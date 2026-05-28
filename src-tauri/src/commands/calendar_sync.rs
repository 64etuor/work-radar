//! pending_calendar_writes IPC (Today×Timeline PR 2).
//!
//! 4개 커맨드:
//!  - `stage_calendar_write` — UI 드래그/리사이즈/언스케줄/cross-cal 이동을 큐에 넣고 워커 깨움.
//!  - `commit_staged_writes` — staged=true 행에서 staged 플래그 제거 + due로 만들어 워커가 가져가게.
//!  - `cancel_pending_write` — 큐에서 행 제거(외부 호출 안 일어남).
//!  - `list_pending_writes` — 디버그/관찰용 큐 스냅샷.
//!
//! INVARIANT: 외부 호출은 sync 워커(Rust)에서만 일어난다. 이 IPC는 큐 머지/조회만.
//! AppError envelope. specta로 TS 바인딩 생성.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;
use tokio::sync::Notify;

use crate::calendar::pending_store::{delete_write, upsert_write};
use crate::calendar::timing::GOOGLE_SYNC_DEBOUNCE_MS;
use crate::db::Db;
use crate::error::AppError;
use crate::models::PendingWrite;

// ── 입력 enums ────────────────────────────────────────────────────────────────

/// stage_calendar_write의 대상. routine_check은 (routine_id, date)로 식별.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteTarget {
    Signal {
        id: String,
    },
    RoutineCheck {
        routine_id: String,
        date: String,
    },
    Event {
        calendar_id: String,
        event_id: String,
    },
}

/// stage_calendar_write의 op. 각 분기가 큐 행의 kind/payload/디바운스를 결정한다.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WriteOp {
    /// 신규 배치 — create 이벤트, Google API 디바운스.
    Schedule {
        at: String,
        duration_min: i32,
        calendar_id: String,
        title: String,
    },
    /// 시간 이동 — patch(start+duration), 기존 linked event 필요, Google API 디바운스.
    Reschedule { at: String, duration_min: i32 },
    /// 리사이즈만 — start와 함께 묶어 patch로 보낸다(워커 단순화). 기존 linked event 필요.
    Resize { at: String, duration_min: i32 },
    /// 큐에서 delete → 카드 mirror 정리(scheduled_at/duration/linked_* NULL).
    Unschedule,
    /// 다른 캘린더로 이동 — create with staged=true(commit_staged_writes로 풀릴 때까지 skip).
    /// 기존 이벤트의 delete는 호출자(UI)가 별도 unschedule을 추가로 stage해 처리한다.
    MoveCalendar {
        calendar_id: String,
        at: String,
        duration_min: i32,
        title: String,
    },
    /// 캘린더에서 빈 슬롯에 새 이벤트(추후 카드와 연결) — Google API 디바운스.
    CreateBlank {
        title: String,
        at: String,
        duration_min: i32,
        calendar_id: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, Type)]
pub struct StageWriteRequest {
    pub target: WriteTarget,
    pub op: WriteOp,
    /// 같은 키는 (target_kind, target_id, kind) UNIQUE로 머지된다. UI는 디바운스용으로 자유 사용.
    pub idempotency_key: String,
}

// ── IPC commands ──────────────────────────────────────────────────────────────

/// UI 드래그/리사이즈/언스케줄/cross-cal 이동을 pending_calendar_writes 큐에 머지하고 워커를 깨운다.
/// 외부 호출은 워커에서만 — 이 함수는 SQL UPSERT만 한다.
#[tauri::command]
#[specta::specta]
pub async fn stage_calendar_write(
    req: StageWriteRequest,
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
) -> Result<(), AppError> {
    stage_calendar_write_inner(db.inner(), notify.inner(), req).await
}

pub(crate) async fn stage_calendar_write_inner(
    pool: &SqlitePool,
    notify: &Arc<Notify>,
    req: StageWriteRequest,
) -> Result<(), AppError> {
    // PR 6: 루틴은 오늘 처음 인터랙션 시점에 routine_checks 행이 없을 수 있다.
    // build_queue_row 전에 idempotent INSERT로 행 보장(UNIQUE(routine_id, date) 0011 마이그레이션).
    // 이렇게 해야 fetch_linked_event/이후 sync 워커의 link_back UPDATE가 0행이 안 되고
    // Schedule 직후 time_override UPDATE도 안전.
    if let WriteTarget::RoutineCheck { routine_id, date } = &req.target {
        ensure_routine_check_row(pool, routine_id, date).await?;
    }
    let (target_kind, target_id) = match &req.target {
        WriteTarget::Signal { id } => ("signal", id.clone()),
        WriteTarget::RoutineCheck { routine_id, date } => {
            ("routine_check", format!("{routine_id}|{date}"))
        }
        WriteTarget::Event {
            calendar_id,
            event_id,
        } => ("event", format!("{calendar_id}|{event_id}")),
    };
    let (kind, calendar_id, event_id_opt, payload, debounce_ms) =
        build_queue_row(&req, pool, target_kind, &target_id).await?;

    // build_queue_row 성공 뒤에만 로컬 mirror를 바꾼다. linked event가 없는 unschedule/resize가
    // 실패했는데 카드만 미배치로 돌아가는 상태 분리를 막기 위한 순서 보장이다.
    if let WriteTarget::RoutineCheck { routine_id, date } = &req.target {
        // Schedule/Reschedule이면 time_override를 즉시 로컬에 반영 — Google mirror는 큐 워커가.
        // 트레이↔캔버스 드래그 직후 UI가 다음 fetch에서 time_override를 보는 게 보장돼야 한다(spec §D10).
        let hhmm = match &req.op {
            WriteOp::Schedule { at, .. }
            | WriteOp::Reschedule { at, .. }
            | WriteOp::Resize { at, .. } => Some(extract_hhmm(at)),
            _ => None,
        };
        if let Some(hhmm) = hhmm {
            sqlx::query(
                "UPDATE routine_checks SET time_override = ?1 \
                 WHERE routine_id = ?2 AND date = ?3",
            )
            .bind(&hhmm)
            .bind(routine_id)
            .bind(date)
            .execute(pool)
            .await?;
        }
    }

    // ADR-0002 카드 정본: signals.scheduled_at/duration/linked_calendar_id를 즉시
    // 로컬에 반영한다. 워커는 Google mirror만 담당 — UI가 다음 fetch에서 즉시
    // 새 schedule을 본다. (이전엔 link_back만 있어서 Google round-trip 끝나야
    // UI에 반영, 사용자 체감 "한참 있다 보임".)
    if let WriteTarget::Signal { id } = &req.target {
        match &req.op {
            WriteOp::Schedule {
                at,
                duration_min,
                calendar_id,
                ..
            }
            | WriteOp::CreateBlank {
                at,
                duration_min,
                calendar_id,
                ..
            } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2, \
                     linked_calendar_id = ?3 WHERE id = ?4",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(calendar_id)
                .bind(id)
                .execute(pool)
                .await?;
            }
            WriteOp::Reschedule { at, duration_min } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2 WHERE id = ?3",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(id)
                .execute(pool)
                .await?;
            }
            WriteOp::Resize { at, duration_min } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2 WHERE id = ?3",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(id)
                .execute(pool)
                .await?;
            }
            WriteOp::Unschedule => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = NULL, scheduled_duration = NULL, \
                     linked_event_id = NULL, linked_calendar_id = NULL WHERE id = ?1",
                )
                .bind(id)
                .execute(pool)
                .await?;
            }
            // MoveCalendar는 staged — Acceptance 게이트 전까지 로컬 mirror도 보류.
            // commit_staged_writes 시점이 아니라 워커 flush 시 link_back에서 반영된다.
            WriteOp::MoveCalendar { .. } => {}
        }
    }
    upsert_write(
        pool,
        kind,
        target_kind,
        &target_id,
        &calendar_id,
        event_id_opt.as_deref(),
        &payload,
        debounce_ms,
    )
    .await?;
    notify.notify_one();
    Ok(())
}

/// 루틴 체크 행 보장 — (routine_id, date) UNIQUE 위에서 INSERT...ON CONFLICT DO NOTHING.
/// 마이그레이션 0011이 UNIQUE(routine_id, date)를 강제해 멱등.
pub(crate) async fn ensure_routine_check_row(
    pool: &SqlitePool,
    routine_id: &str,
    date: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO routine_checks (id, routine_id, date) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2) \
         ON CONFLICT(routine_id, date) DO NOTHING",
    )
    .bind(routine_id)
    .bind(date)
    .execute(pool)
    .await?;
    Ok(())
}

/// ISO 'YYYY-MM-DDTHH:MM[:SS...]'에서 HH:MM만 추출. 형식 불일치 시 "00:00".
/// 입력이 11..16 슬라이스를 갖지 않으면 (a) ISO 가정 오류이거나 (b) 빈/짧은 문자열 →
/// `tracing::warn!`로 표면화한 뒤 안전 폴백. 침묵 "00:00" 폴백은 시간이 어긋난
/// 캘린더 이벤트가 silent하게 생성될 수 있어 위험(PR 7 코드리뷰).
fn extract_hhmm(at: &str) -> String {
    match at.get(11..16) {
        Some(s) => s.to_string(),
        None => {
            tracing::warn!(
                input_len = at.len(),
                "extract_hhmm: malformed ISO input — falling back to 00:00"
            );
            "00:00".to_string()
        }
    }
}

/// staged=true 행에서 staged 플래그를 제거하고 next_attempt_at을 now로 당겨 워커가 즉시 가져가게 한다
/// (cross-cal Acceptance, spec §6.2). 워커는 깨우기만 — 실제 외부 호출은 워커에서.
#[tauri::command]
#[specta::specta]
pub async fn commit_staged_writes(
    ids: Vec<i32>,
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
) -> Result<(), AppError> {
    let pool = db.inner();
    // 한 트랜잭션으로 묶어 중도 실패 시 부분 적용을 막는다(staged 일부만 풀린 상태 = 사용자
    // Acceptance의 partial 적용이라 INVARIANT #2 회색지대). all-or-nothing이 안전.
    let mut tx = pool.begin().await?;
    for id in ids {
        sqlx::query(
            "UPDATE pending_calendar_writes
             SET payload_json = json_remove(payload_json, '$.staged'),
                 next_attempt_at = datetime('now')
             WHERE id = ?1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    notify.notify_one();
    Ok(())
}

/// 큐에서 한 행을 지운다(외부 호출 안 함 — UI 취소/롤백 전용).
#[tauri::command]
#[specta::specta]
pub async fn cancel_pending_write(id: i32, db: State<'_, Db>) -> Result<(), AppError> {
    delete_write(db.inner(), id).await?;
    Ok(())
}

/// 디버그/관찰용 큐 스냅샷(created_at DESC). 토큰/외부 응답 본문은 큐에 없으므로 안전.
#[tauri::command]
#[specta::specta]
pub async fn list_pending_writes(db: State<'_, Db>) -> Result<Vec<PendingWrite>, AppError> {
    let rows = sqlx::query_as::<_, PendingWrite>(
        "SELECT id, kind, target_kind, target_id, calendar_id, event_id,
                payload_json, attempts, next_attempt_at, last_error, created_at
         FROM pending_calendar_writes
         ORDER BY created_at DESC",
    )
    .fetch_all(db.inner())
    .await?;
    Ok(rows)
}

// ── op → queue row 변환 (build_queue_row) ──────────────────────────────────────

/// op + 기존 linked event(있다면) → (kind, calendar_id, event_id, payload_json, debounce_ms).
async fn build_queue_row(
    req: &StageWriteRequest,
    pool: &SqlitePool,
    target_kind: &str,
    target_id: &str,
) -> Result<(&'static str, String, Option<String>, String, i64), AppError> {
    let existing = fetch_linked_event(pool, target_kind, target_id).await?;
    Ok(match &req.op {
        WriteOp::Schedule {
            at,
            duration_min,
            calendar_id,
            title,
        } => {
            let payload = serde_json::json!({
                "title": title,
                "start": at,
                "duration_min": duration_min,
            })
            .to_string();
            (
                "create",
                calendar_id.clone(),
                None,
                payload,
                GOOGLE_SYNC_DEBOUNCE_MS,
            )
        }
        WriteOp::Reschedule { at, duration_min } => {
            let (cal, ev) = existing.ok_or_else(|| {
                AppError::validation("calendar.no_linked_event", "no linked event to reschedule")
            })?;
            let payload = serde_json::json!({
                "start": at,
                "duration_min": duration_min,
            })
            .to_string();
            ("patch", cal, Some(ev), payload, GOOGLE_SYNC_DEBOUNCE_MS)
        }
        WriteOp::Resize { at, duration_min } => {
            let (cal, ev) = existing.ok_or_else(|| {
                AppError::validation("calendar.no_linked_event", "no linked event to resize")
            })?;
            // resize-only patch는 워커가 거부 — start와 묶어 보낸다(워커 simplification).
            let payload = serde_json::json!({
                "start": at,
                "duration_min": duration_min,
            })
            .to_string();
            ("patch", cal, Some(ev), payload, GOOGLE_SYNC_DEBOUNCE_MS)
        }
        WriteOp::Unschedule => {
            let (cal, ev) = existing.ok_or_else(|| {
                AppError::validation("calendar.no_linked_event", "no linked event to unschedule")
            })?;
            (
                "delete",
                cal,
                Some(ev),
                "{}".into(),
                GOOGLE_SYNC_DEBOUNCE_MS,
            )
        }
        WriteOp::MoveCalendar {
            calendar_id,
            at,
            duration_min,
            title,
        } => {
            // staged=true → 워커가 commit_staged_writes 호출 전까지 skip.
            let payload = serde_json::json!({
                "title": title,
                "start": at,
                "duration_min": duration_min,
                "staged": true,
            })
            .to_string();
            ("create", calendar_id.clone(), None, payload, 0)
        }
        WriteOp::CreateBlank {
            title,
            at,
            duration_min,
            calendar_id,
        } => {
            let payload = serde_json::json!({
                "title": title,
                "start": at,
                "duration_min": duration_min,
            })
            .to_string();
            (
                "create",
                calendar_id.clone(),
                None,
                payload,
                GOOGLE_SYNC_DEBOUNCE_MS,
            )
        }
    })
}

/// target → (calendar_id, event_id) — 카드/루틴 mirror에 박혀 있는 linked event를 조회.
async fn fetch_linked_event(
    pool: &SqlitePool,
    target_kind: &str,
    target_id: &str,
) -> Result<Option<(String, String)>, AppError> {
    match target_kind {
        "signal" => {
            let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT linked_calendar_id, linked_event_id FROM signals WHERE id = ?1",
            )
            .bind(target_id)
            .fetch_optional(pool)
            .await?;
            Ok(row.and_then(pair_or_none))
        }
        "routine_check" => {
            let mut parts = target_id.splitn(2, '|');
            let (Some(routine_id), Some(date)) = (parts.next(), parts.next()) else {
                return Ok(None);
            };
            let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT linked_calendar_id, linked_event_id
                 FROM routine_checks
                 WHERE routine_id = ?1 AND date = ?2",
            )
            .bind(routine_id)
            .bind(date)
            .fetch_optional(pool)
            .await?;
            Ok(row.and_then(pair_or_none))
        }
        "event" => {
            let Some((calendar_id, event_id)) = target_id.split_once('|') else {
                return Ok(None);
            };
            if calendar_id.is_empty() || event_id.is_empty() {
                return Ok(None);
            }
            Ok(Some((calendar_id.to_string(), event_id.to_string())))
        }
        _ => Ok(None),
    }
}

fn pair_or_none(t: (Option<String>, Option<String>)) -> Option<(String, String)> {
    match t {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    /// 시드 routine + ensure_routine_check_row 두 번 호출 → 한 행만 생성(멱등).
    /// 0011 UNIQUE(routine_id, date) ON CONFLICT DO NOTHING 동작 보증.
    #[tokio::test]
    async fn ensure_routine_check_row_is_idempotent() {
        let db = fresh_db().await;
        // 루틴 1개 시드 (직접 INSERT — 테스트 격리).
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active) \
             VALUES ('r1', '아침', 'daily', 1)",
        )
        .execute(&db)
        .await
        .unwrap();

        // 첫 호출 — 행 생성.
        ensure_routine_check_row(&db, "r1", "2026-05-28")
            .await
            .unwrap();
        // 두 번째 호출 — ON CONFLICT DO NOTHING (UNIQUE 위반 시 에러 안 남).
        ensure_routine_check_row(&db, "r1", "2026-05-28")
            .await
            .unwrap();

        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM routine_checks WHERE routine_id='r1' AND date='2026-05-28'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            count, 1,
            "멱등 — UNIQUE(routine_id, date) ON CONFLICT DO NOTHING"
        );
    }

    #[tokio::test]
    async fn unschedule_without_link_does_not_clear_signal_schedule_or_queue() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, scheduled_at, scheduled_duration) \
             VALUES ('s1','Demo','braindump','thought','2026-05-28T10:00:00',30)",
        )
        .execute(&db)
        .await
        .unwrap();

        let req = StageWriteRequest {
            target: WriteTarget::Signal { id: "s1".into() },
            op: WriteOp::Unschedule,
            idempotency_key: "test-unschedule".into(),
        };
        let err = stage_calendar_write_inner(&db, &notify, req)
            .await
            .expect_err("missing linked event should reject unschedule");
        assert_eq!(err.code, "calendar.no_linked_event");

        let (scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id): (
            Option<String>,
            Option<i64>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id \
             FROM signals WHERE id = 's1'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(scheduled_at.as_deref(), Some("2026-05-28T10:00:00"));
        assert_eq!(scheduled_duration, Some(30));
        assert!(linked_event_id.is_none());
        assert!(linked_calendar_id.is_none());

        let (queued,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(queued, 0);
    }

    #[tokio::test]
    async fn reschedule_without_link_does_not_move_signal_or_queue() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, scheduled_at, scheduled_duration) \
             VALUES ('s1','Demo','braindump','thought','2026-05-28T10:00:00',30)",
        )
        .execute(&db)
        .await
        .unwrap();

        let req = StageWriteRequest {
            target: WriteTarget::Signal { id: "s1".into() },
            op: WriteOp::Reschedule {
                at: "2026-05-28T12:00:00".into(),
                duration_min: 45,
            },
            idempotency_key: "test-reschedule".into(),
        };
        let err = stage_calendar_write_inner(&db, &notify, req)
            .await
            .expect_err("missing linked event should reject reschedule");
        assert_eq!(err.code, "calendar.no_linked_event");

        let (scheduled_at, scheduled_duration): (Option<String>, Option<i64>) =
            sqlx::query_as("SELECT scheduled_at, scheduled_duration FROM signals WHERE id = 's1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(scheduled_at.as_deref(), Some("2026-05-28T10:00:00"));
        assert_eq!(scheduled_duration, Some(30));

        let (queued,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(queued, 0);
    }

    /// extract_hhmm: 다양한 ISO 입력에서 HH:MM 추출.
    #[test]
    fn extract_hhmm_isos() {
        assert_eq!(extract_hhmm("2026-05-28T09:30:00"), "09:30");
        assert_eq!(extract_hhmm("2026-05-28T23:45:00"), "23:45");
        // 형식 미달 — fallback "00:00".
        assert_eq!(extract_hhmm("invalid"), "00:00");
    }
}
