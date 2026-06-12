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
use crate::commands::placement_store;
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
        /// 이 이벤트가 동기화된 루틴의 블록이면 그 루틴 id — Reschedule/Resize 시
        /// `routine_checks.time_override`를 같은 트랜잭션 흐름에서 미러해, 캘린더만 움직이고
        /// 루틴이 옛 시각에 남는 분리(stale-hide 스냅백)를 막는다. `routine_date`와 쌍.
        #[serde(default)]
        routine_id: Option<String>,
        /// 위 루틴의 occurrence 날짜(YYYY-MM-DD). `routine_id`와 쌍으로만 의미.
        #[serde(default)]
        routine_date: Option<String>,
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
    /// `from_date`: Signal 타깃 전용 — 이동 출발 블록의 날짜(YYYY-MM-DD).
    /// 날짜가 바뀌는 이동이면 그 날짜의 signal_day_placements 행을 삭제한다.
    /// routine_check/event 타깃에선 무시. None이면 현 scheduled_at의 날짜로 폴백(레거시 큐 행).
    Reschedule {
        at: String,
        duration_min: i32,
        #[serde(default)]
        from_date: Option<String>,
    },
    /// 리사이즈만 — start와 함께 묶어 patch로 보낸다(워커 단순화). 기존 linked event 필요.
    /// `from_date`: Reschedule과 동일 의미(top-핸들 리사이즈는 날짜를 넘을 수 있다).
    Resize {
        at: String,
        duration_min: i32,
        #[serde(default)]
        from_date: Option<String>,
    },
    /// 큐에서 delete → 카드 mirror 정리(scheduled_at/duration/linked_* NULL).
    /// `from_date`: Signal 타깃 전용 — 트레이로 복귀시키는 블록의 날짜.
    /// 그 날짜의 placement 행만 삭제한다(과거 날짜 히스토리는 보존).
    Unschedule {
        #[serde(default)]
        from_date: Option<String>,
    },
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
    if let Some(code) = validate_write_op(&req.op) {
        return Err(AppError::validation(code, "calendar write start is empty"));
    }
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
            ..
        } => ("event", format!("{calendar_id}|{event_id}")),
    };
    // None = 외부 미러 대상이 없는 유효한 로컬-only write(링크/pending create 없는
    // routine_check 시간 이동). 큐 행 없이 아래 로컬 미러만 수행한다 — 거부하면
    // 가상 루틴 블록 드래그가 로컬에서도 안 움직인다(원위치 잔류).
    let queue_row = build_queue_row(&req, pool, target_kind, &target_id).await?;

    // build_queue_row가 Err 없이 끝난 뒤에만 로컬 mirror를 바꾼다(Some=큐 행 예정,
    // None=로컬-only 둘 다 성공). linked event가 없는 unschedule/resize가 거부됐는데
    // 카드만 미배치로 돌아가는 상태 분리를 막기 위한 순서 보장이다.
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
        } else if matches!(req.op, WriteOp::Unschedule { .. }) {
            // 트레이 복귀 = 즉시 로컬 mirror에서 time_override/링크 제거(signal Unschedule과 대칭).
            // 이전엔 워커가 Google delete에 성공한 뒤에야 unlink_impl이 지워서, 동기화 지연/실패 시
            // linked_event_id=NULL인데 time_override만 남는 좀비 상태 → 블록이 옛 시각에 잔류했다.
            // completed_at(완료 마커)은 건드리지 않는다 — unschedule≠완료해제.
            sqlx::query(
                "UPDATE routine_checks SET time_override = NULL, \
                 linked_event_id = NULL, linked_calendar_id = NULL \
                 WHERE routine_id = ?1 AND date = ?2",
            )
            .bind(routine_id)
            .bind(date)
            .execute(pool)
            .await?;
        }
    }

    // 루틴-backed 이벤트(동기화된 루틴이 이벤트 블록으로 렌더되는 경우)의 시간 이동/리사이즈는
    // routine_checks.time_override를 같은 IPC 안에서 미러한다. 이벤트만 patch되고 루틴 시각이
    // 그대로면 todayBlocks의 stale 판정이 이동된 이벤트를 숨기고 옛 시각의 가상 블록을 그린다
    // (드래그해도 블록이 원위치에 남는 버그). RoutineCheck 타깃의 미러와 동일 규율.
    //
    // 링크백(adoption)도 함께 한다 — 사용자가 만진 인스턴스를 그 occurrence의 per-day
    // mirror event로 명시 저장. recurring-sync 루틴은 per-day 링크가 없어 occurrence↔이벤트
    // 대응이 렌더 시각-추론에만 의존했는데(이번 버그 일가의 뿌리), 링크가 박히면 이후 그
    // 날짜의 reschedule/resize/unschedule이 전부 ID 기반으로 동작한다(로컬-only 폴백 불필요).
    if let WriteTarget::Event {
        calendar_id,
        event_id,
        routine_id: Some(routine_id),
        routine_date: Some(date),
    } = &req.target
    {
        if let WriteOp::Reschedule { at, .. } | WriteOp::Resize { at, .. } = &req.op {
            ensure_routine_check_row(pool, routine_id, date).await?;
            sqlx::query(
                "UPDATE routine_checks \
                 SET time_override = ?1, linked_event_id = ?2, linked_calendar_id = ?3 \
                 WHERE routine_id = ?4 AND date = ?5",
            )
            .bind(extract_hhmm(at))
            .bind(event_id)
            .bind(calendar_id)
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
        // placement from_date 폴백용 — 미러 UPDATE 전에 읽는다(이후엔 새 값으로 덮임).
        // NOTE: scheduled_at 미러와 placement 쓰기는 트랜잭션으로 묶지 않았다 — 이 파일의
        // 기존 로컬 미러들(routine time_override 등)과 동일한 비원자 규율. TX wrapping은
        // decisions.md의 기존 deferred 항목과 함께 후속(placement_store 시그니처 리플).
        let prev_date: Option<String> =
            sqlx::query_scalar("SELECT substr(scheduled_at, 1, 10) FROM signals WHERE id = ?1")
                .bind(id)
                .fetch_optional(pool)
                .await?
                .flatten();
        match &req.op {
            WriteOp::Schedule {
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
                // 날짜별 배치 SSOT 미러 — 트레이→캔버스 신규 배치는 그 날짜 행 upsert.
                placement_store::upsert_placement(pool, id, local_date_of(at), at, *duration_min)
                    .await?;
            }
            // CreateBlank의 Signal id는 placeholder UUID(실 카드 아님) — FK 위반이므로
            // placement 미러 제외. scheduled_at UPDATE는 기존처럼 0행 no-op.
            WriteOp::CreateBlank {
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
            WriteOp::Reschedule {
                at,
                duration_min,
                from_date,
            }
            | WriteOp::Resize {
                at,
                duration_min,
                from_date,
            } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2 WHERE id = ?3",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(id)
                .execute(pool)
                .await?;
                // 도착 날짜 upsert 먼저, 출발 날짜 삭제 나중 — 중간 실패 시 "양쪽 소실"
                // 대신 "무해한 중복"이 남도록 부분 실패 모드를 선택(다음 이동/unschedule이 정리).
                let new_date = local_date_of(at);
                placement_store::upsert_placement(pool, id, new_date, at, *duration_min).await?;
                // 날짜를 넘는 이동이면 출발 날짜 행 삭제(같은 날이면 위 upsert가 그 행을 갱신).
                let src = from_date.as_deref().or(prev_date.as_deref());
                if let Some(src) = src {
                    if src != new_date {
                        placement_store::delete_placement(pool, id, src).await?;
                    }
                }
            }
            WriteOp::Unschedule { from_date } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = NULL, scheduled_duration = NULL, \
                     linked_event_id = NULL, linked_calendar_id = NULL WHERE id = ?1",
                )
                .bind(id)
                .execute(pool)
                .await?;
                // 그 날짜의 배치만 트레이 복귀 — 과거 날짜 placement는 누적 집계 히스토리로 보존.
                if let Some(src) = from_date.as_deref().or(prev_date.as_deref()) {
                    placement_store::delete_placement(pool, id, src).await?;
                }
            }
            // MoveCalendar는 staged — Acceptance 게이트 전까지 로컬 mirror도 보류.
            // commit_staged_writes 시점이 아니라 워커 flush 시 link_back에서 반영된다.
            WriteOp::MoveCalendar { .. } => {}
        }
    }
    if let Some((kind, calendar_id, event_id_opt, payload, debounce_ms)) = queue_row {
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
    }
    Ok(())
}

fn validate_write_op(op: &WriteOp) -> Option<&'static str> {
    let at = match op {
        WriteOp::Schedule { at, .. }
        | WriteOp::Reschedule { at, .. }
        | WriteOp::Resize { at, .. }
        | WriteOp::MoveCalendar { at, .. }
        | WriteOp::CreateBlank { at, .. } => Some(at),
        WriteOp::Unschedule { .. } => None,
    };
    if at.is_some_and(|value| value.trim().is_empty()) {
        return Some("calendar.invalid_start");
    }
    None
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

/// 로컬 ISO 'YYYY-MM-DD…'에서 날짜 10글자. validate_write_op가 빈 at을 선차단하므로
/// 짧은 입력은 방어적으로 전체 문자열 반환(placement date 불일치는 upsert가 무해).
fn local_date_of(at: &str) -> &str {
    at.get(0..10).unwrap_or(at)
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
/// 큐 행 스펙을 만든다. `Ok(None)` = 외부 미러 대상이 없는 유효한 로컬-only write
/// (링크/pending create 없는 routine_check 시간 이동) — 호출자는 큐 upsert를 건너뛴다.
async fn build_queue_row(
    req: &StageWriteRequest,
    pool: &SqlitePool,
    target_kind: &str,
    target_id: &str,
) -> Result<Option<(&'static str, String, Option<String>, String, i64)>, AppError> {
    let existing = fetch_linked_event(pool, target_kind, target_id).await?;
    Ok(Some(match &req.op {
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
        WriteOp::Reschedule {
            at, duration_min, ..
        } => match existing {
            Some((cal, ev)) => {
                let payload = serde_json::json!({
                    "start": at,
                    "duration_min": duration_min,
                })
                .to_string();
                ("patch", cal, Some(ev), payload, GOOGLE_SYNC_DEBOUNCE_MS)
            }
            // 배치 직후 미동기화 — pending create에 coalesce.
            // (signal: 없으면 거부 / routine_check: 없으면 로컬-only 미러 = 큐 없음)
            None => match coalesce_into_pending_create(
                pool,
                target_kind,
                target_id,
                at,
                *duration_min,
                "reschedule",
            )
            .await?
            {
                Some(row) => row,
                None => return Ok(None),
            },
        },
        WriteOp::Resize {
            at, duration_min, ..
        } => match existing {
            Some((cal, ev)) => {
                // resize-only patch는 워커가 거부 — start와 묶어 보낸다(워커 simplification).
                let payload = serde_json::json!({
                    "start": at,
                    "duration_min": duration_min,
                })
                .to_string();
                ("patch", cal, Some(ev), payload, GOOGLE_SYNC_DEBOUNCE_MS)
            }
            // 배치 직후 미동기화 — pending create에 coalesce.
            // (signal: 없으면 거부 / routine_check: 없으면 로컬-only 미러 = 큐 없음)
            None => match coalesce_into_pending_create(
                pool,
                target_kind,
                target_id,
                at,
                *duration_min,
                "resize",
            )
            .await?
            {
                Some(row) => row,
                None => return Ok(None),
            },
        },
        WriteOp::Unschedule { .. } => {
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
    }))
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

/// 같은 target의 아직 미동기화된 pending `create` 행(calendar_id, payload_json)을 조회.
/// 배치(schedule) 직후 워커가 Google 이벤트를 만들기 전 윈도우에서만 존재한다.
async fn fetch_pending_create(
    pool: &SqlitePool,
    target_kind: &str,
    target_id: &str,
) -> Result<Option<(String, String)>, AppError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT calendar_id, payload_json FROM pending_calendar_writes \
         WHERE target_kind = ?1 AND target_id = ?2 AND kind = 'create'",
    )
    .bind(target_kind)
    .bind(target_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// linked event가 아직 없는 reschedule/resize를 pending `create`에 coalesce한다.
///
/// 배치 직후엔 signal에 linked_event_id가 없어(워커가 디바운스 후 생성+링크) patch 타깃이
/// 없다. 이때 create 행이 있으면 에러 대신 그 행 payload를 새 start/duration으로 갱신한다
/// — `upsert_write`가 UNIQUE(target, 'create')로 머지하므로 디바운스 윈도우 안의 연속
/// 드래그/리사이즈가 한 create로 합쳐지고, 워커는 최종 위치로 한 번에 이벤트를 만든다.
///
/// create 행조차 없을 때는 target에 따라 갈린다:
/// - signal: 이벤트가 외부에서 삭제된 진짜 orphan → 기존대로 거부.
/// - routine_check: Google 링크 없는 시간 이동도 유효하다(time_override는 로컬 정본,
///   recurring-sync 루틴의 가상 블록·stale 블록 드래그가 이 경로) → `Ok(None)` =
///   큐 행 없이 로컬 미러만. 거부하면 블록이 로컬에서도 안 움직인다(원위치 잔류 버그).
async fn coalesce_into_pending_create(
    pool: &SqlitePool,
    target_kind: &str,
    target_id: &str,
    at: &str,
    duration_min: i32,
    verb: &str,
) -> Result<Option<(&'static str, String, Option<String>, String, i64)>, AppError> {
    let Some((cal, create_payload)) = fetch_pending_create(pool, target_kind, target_id).await?
    else {
        if target_kind == "routine_check" {
            return Ok(None);
        }
        return Err(AppError::validation(
            "calendar.no_linked_event",
            format!("no linked event to {verb}"),
        ));
    };
    // create 행의 title 보존 — start/duration만 새 값으로 교체.
    let title = serde_json::from_str::<serde_json::Value>(&create_payload)
        .ok()
        .and_then(|v| v.get("title").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_default();
    let payload = serde_json::json!({
        "title": title,
        "start": at,
        "duration_min": duration_min,
    })
    .to_string();
    Ok(Some((
        "create",
        cal,
        None,
        payload,
        GOOGLE_SYNC_DEBOUNCE_MS,
    )))
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

    /// 회귀(0049): 루틴을 캘린더에 배치(ensure_routine_check_row = 링크 목적 행)해도
    /// "완료"로 표시되면 안 된다. done = (completed_at IS NOT NULL)이고, 링크 행은
    /// completed_at을 세팅하지 않는다. 0049 이전엔 done = (rc.id IS NOT NULL)이라
    /// 배치만으로 체크박스가 켜지고, 체크 해제 시 링크 행을 통째로 DELETE했다(버그).
    #[tokio::test]
    async fn scheduling_routine_does_not_mark_it_done() {
        let db = fresh_db().await;
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active) VALUES ('r1','아침','daily',1)",
        )
        .execute(&db)
        .await
        .unwrap();

        // 캘린더 배치(링크) — 완료 아님.
        ensure_routine_check_row(&db, "r1", "2026-05-28")
            .await
            .unwrap();
        let (completed,): (Option<String>,) = sqlx::query_as(
            "SELECT completed_at FROM routine_checks WHERE routine_id='r1' AND date='2026-05-28'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(
            completed.is_none(),
            "배치(링크) 행은 완료 마커가 없어야 한다 — scheduled≠done"
        );
    }

    /// 회귀: Google 링크도 pending create도 없는 루틴의 시간 이동(가상 블록·stale 블록 드래그,
    /// recurring-sync 루틴의 per-day check은 링크가 없다)은 거부되면 안 된다 —
    /// calendar.no_linked_event로 거부하면 로컬 time_override조차 안 바뀌어 블록이 원위치에
    /// 남는다. 로컬-only 미러(큐 행 0)로 성공해야 한다.
    #[tokio::test]
    async fn routine_reschedule_without_link_mirrors_time_override_without_queue() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active, time_of_day) \
             VALUES ('r1','아침','daily',1,'09:00')",
        )
        .execute(&db)
        .await
        .unwrap();

        let req = StageWriteRequest {
            target: WriteTarget::RoutineCheck {
                routine_id: "r1".into(),
                date: "2026-05-28".into(),
            },
            op: WriteOp::Reschedule {
                at: "2026-05-28T11:15:00".into(),
                duration_min: 30,
                from_date: None,
            },
            idempotency_key: "test-unlinked-routine-move".into(),
        };
        stage_calendar_write_inner(&db, &notify, req).await.unwrap();

        let (time_override,): (Option<String>,) = sqlx::query_as(
            "SELECT time_override FROM routine_checks WHERE routine_id='r1' AND date='2026-05-28'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(time_override.as_deref(), Some("11:15"));

        let (queued,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(queued, 0, "외부 미러 대상이 없으니 큐 행도 없어야 한다");
    }

    /// Resize 경로도 동일 — None-coalesce arm이 Reschedule과 별도 분기라 직접 핀.
    #[tokio::test]
    async fn routine_resize_without_link_mirrors_time_override_without_queue() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active, time_of_day) \
             VALUES ('r1','아침','daily',1,'09:00')",
        )
        .execute(&db)
        .await
        .unwrap();

        let req = StageWriteRequest {
            target: WriteTarget::RoutineCheck {
                routine_id: "r1".into(),
                date: "2026-05-28".into(),
            },
            op: WriteOp::Resize {
                at: "2026-05-28T08:45:00".into(),
                duration_min: 45,
                from_date: None,
            },
            idempotency_key: "test-unlinked-routine-resize".into(),
        };
        stage_calendar_write_inner(&db, &notify, req).await.unwrap();

        let (time_override,): (Option<String>,) = sqlx::query_as(
            "SELECT time_override FROM routine_checks WHERE routine_id='r1' AND date='2026-05-28'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(time_override.as_deref(), Some("08:45"));

        let (queued,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(queued, 0);
    }

    /// 회귀: 동기화된 루틴 블록(이벤트 블록으로 렌더)을 드래그하면 Google 이벤트만 patch되고
    /// routine_checks.time_override가 안 바뀌어 — todayBlocks stale 판정이 이동된 이벤트를
    /// 숨기고 옛 시각의 가상 루틴 블록을 그렸다(블록 원위치 잔류 버그). Event 타깃에 루틴
    /// 컨텍스트가 동봉되면 같은 IPC에서 time_override가 미러돼야 한다.
    #[tokio::test]
    async fn event_reschedule_with_routine_context_mirrors_time_override() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active, time_of_day) \
             VALUES ('r1','아침','daily',1,'09:00')",
        )
        .execute(&db)
        .await
        .unwrap();

        let req = StageWriteRequest {
            target: WriteTarget::Event {
                calendar_id: "work-cal".into(),
                event_id: "master-1_20260528T000000Z".into(),
                routine_id: Some("r1".into()),
                routine_date: Some("2026-05-28".into()),
            },
            op: WriteOp::Reschedule {
                at: "2026-05-28T10:30:00".into(),
                duration_min: 30,
                from_date: None,
            },
            idempotency_key: "test-routine-backed-move".into(),
        };
        stage_calendar_write_inner(&db, &notify, req).await.unwrap();

        // 루틴 occurrence 미러 + 링크백(adoption) — 블록이 새 위치를 따라가고,
        // 만진 인스턴스가 그 날짜의 per-day mirror event로 명시 저장된다.
        let (time_override, linked_event_id, linked_calendar_id): (
            Option<String>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT time_override, linked_event_id, linked_calendar_id \
             FROM routine_checks WHERE routine_id='r1' AND date='2026-05-28'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(time_override.as_deref(), Some("10:30"));
        assert_eq!(
            linked_event_id.as_deref(),
            Some("master-1_20260528T000000Z")
        );
        assert_eq!(linked_calendar_id.as_deref(), Some("work-cal"));

        // 캘린더 patch 큐 행 — 이벤트 타깃 그대로(루틴 컨텍스트는 미러 전용).
        let (kind, event_id): (String, Option<String>) =
            sqlx::query_as("SELECT kind, event_id FROM pending_calendar_writes")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(kind, "patch");
        assert_eq!(event_id.as_deref(), Some("master-1_20260528T000000Z"));
    }

    /// adoption 효과 엔드투엔드: 루틴-backed 이벤트를 한 번 만지면(링크백) 그 뒤 같은
    /// occurrence의 routine_check 타깃 이동은 — 이전처럼 로컬-only 폴백이 아니라 —
    /// 링크된 인스턴스를 patch하는 큐 행을 만든다(추론→ID 기반 전환의 실증).
    #[tokio::test]
    async fn adopted_instance_makes_subsequent_routine_moves_id_based() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active, time_of_day) \
             VALUES ('r1','아침','daily',1,'09:00')",
        )
        .execute(&db)
        .await
        .unwrap();

        // 1) 루틴-backed 이벤트 드래그 — adoption.
        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Event {
                    calendar_id: "work-cal".into(),
                    event_id: "master-1_20260528T000000Z".into(),
                    routine_id: Some("r1".into()),
                    routine_date: Some("2026-05-28".into()),
                },
                op: WriteOp::Reschedule {
                    at: "2026-05-28T10:30:00".into(),
                    duration_min: 30,
                    from_date: None,
                },
                idempotency_key: "adopt".into(),
            },
        )
        .await
        .unwrap();

        // 2) 같은 occurrence를 routine_check 타깃으로 다시 이동(가상 블록 드래그 경로).
        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::RoutineCheck {
                    routine_id: "r1".into(),
                    date: "2026-05-28".into(),
                },
                op: WriteOp::Reschedule {
                    at: "2026-05-28T13:00:00".into(),
                    duration_min: 30,
                    from_date: None,
                },
                idempotency_key: "move-after-adopt".into(),
            },
        )
        .await
        .unwrap();

        // 링크 덕에 routine_check 이동도 인스턴스 patch 큐 행을 만든다(로컬-only 아님).
        let (count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM pending_calendar_writes \
             WHERE target_kind='routine_check' AND kind='patch' \
               AND event_id='master-1_20260528T000000Z'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count, 1);

        let (time_override,): (Option<String>,) = sqlx::query_as(
            "SELECT time_override FROM routine_checks WHERE routine_id='r1' AND date='2026-05-28'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(time_override.as_deref(), Some("13:00"));
    }

    /// 루틴 컨텍스트 없는 평범한 이벤트 write는 routine_checks를 일절 만들지 않는다.
    #[tokio::test]
    async fn event_reschedule_without_routine_context_leaves_routine_checks_alone() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        let req = StageWriteRequest {
            target: WriteTarget::Event {
                calendar_id: "work-cal".into(),
                event_id: "ev-1".into(),
                routine_id: None,
                routine_date: None,
            },
            op: WriteOp::Reschedule {
                at: "2026-05-28T10:30:00".into(),
                duration_min: 30,
                from_date: None,
            },
            idempotency_key: "test-plain-event-move".into(),
        };
        stage_calendar_write_inner(&db, &notify, req).await.unwrap();

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM routine_checks")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
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
            op: WriteOp::Unschedule { from_date: None },
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
                from_date: None,
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

    #[tokio::test]
    async fn reschedule_before_sync_coalesces_into_pending_create() {
        // 배치 직후(워커가 Google 이벤트 만들기 전) reschedule이 에러 대신 pending create에 머지돼야 한다.
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) \
             VALUES ('s1','Demo','braindump','thought')",
        )
        .execute(&db)
        .await
        .unwrap();

        // 1) 배치 — pending create + 로컬 mirror.
        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Schedule {
                    at: "2026-05-28T10:00:00".into(),
                    duration_min: 30,
                    calendar_id: "cal1".into(),
                    title: "Demo".into(),
                },
                idempotency_key: "k-schedule".into(),
            },
        )
        .await
        .unwrap();

        // 2) 동기화 전 reschedule — coalesce(에러 없음).
        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Reschedule {
                    at: "2026-05-28T12:00:00".into(),
                    duration_min: 45,
                    from_date: None,
                },
                idempotency_key: "k-reschedule".into(),
            },
        )
        .await
        .expect("reschedule before sync should coalesce, not error");

        // 큐: create 한 행만(머지), payload는 최신 위치 + title 보존.
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT kind, payload_json FROM pending_calendar_writes WHERE target_id='s1'",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "create 한 행으로 머지");
        assert_eq!(rows[0].0, "create");
        assert!(rows[0].1.contains("2026-05-28T12:00:00"));
        assert!(rows[0].1.contains("45"));
        assert!(rows[0].1.contains("Demo"), "title 보존");

        // 로컬 mirror도 새 위치.
        let (at, dur): (Option<String>, Option<i64>) =
            sqlx::query_as("SELECT scheduled_at, scheduled_duration FROM signals WHERE id='s1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(at.as_deref(), Some("2026-05-28T12:00:00"));
        assert_eq!(dur, Some(45));
    }

    #[tokio::test]
    async fn empty_start_is_rejected_before_signal_mirror_or_queue() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) \
             VALUES ('s1','Demo','braindump','thought')",
        )
        .execute(&db)
        .await
        .unwrap();

        let req = StageWriteRequest {
            target: WriteTarget::Signal { id: "s1".into() },
            op: WriteOp::Schedule {
                at: "".into(),
                duration_min: 30,
                calendar_id: "cal1".into(),
                title: "Demo".into(),
            },
            idempotency_key: "test-empty-start".into(),
        };
        let err = stage_calendar_write_inner(&db, &notify, req)
            .await
            .expect_err("empty start should reject");
        assert_eq!(err.code, "calendar.invalid_start");

        let (scheduled_at, scheduled_duration, linked_calendar_id): (
            Option<String>,
            Option<i64>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT scheduled_at, scheduled_duration, linked_calendar_id FROM signals WHERE id='s1'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(scheduled_at.is_none());
        assert!(scheduled_duration.is_none());
        assert!(linked_calendar_id.is_none());

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

    // ── placement mirroring tests (Task 3) ──────────────────────────────────

    /// Schedule op → signal_day_placements에 그 날짜 행이 생성된다.
    #[tokio::test]
    async fn signal_schedule_upserts_day_placement() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) \
             VALUES ('s1','X','braindump','thought')",
        )
        .execute(&db)
        .await
        .unwrap();

        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Schedule {
                    at: "2026-06-11T14:00:00".into(),
                    duration_min: 60,
                    calendar_id: "cal".into(),
                    title: "X".into(),
                },
                idempotency_key: "t3-schedule".into(),
            },
        )
        .await
        .unwrap();

        let rows = placement_store::fetch_placements_in_range(&db, "2026-06-11", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "배치 1행");
        assert_eq!(rows[0].date, "2026-06-11");
        assert_eq!(rows[0].start_at, "2026-06-11T14:00:00");
        assert_eq!(rows[0].duration_min, 60);
    }

    /// Reschedule이 날짜를 넘으면 출발 날짜 행이 삭제되고 도착 날짜 행만 남는다.
    #[tokio::test]
    async fn signal_reschedule_across_dates_moves_placement_row() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, \
             scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id) \
             VALUES ('s1','X','braindump','thought','2026-06-10T09:00:00',30,'ev1','cal')",
        )
        .execute(&db)
        .await
        .unwrap();
        // 6/10 placement 시드.
        placement_store::upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 30)
            .await
            .unwrap();

        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Reschedule {
                    at: "2026-06-11T10:00:00".into(),
                    duration_min: 60,
                    from_date: Some("2026-06-10".into()),
                },
                idempotency_key: "t3-reschedule-cross".into(),
            },
        )
        .await
        .unwrap();

        let rows = placement_store::fetch_placements_in_range(&db, "2026-06-10", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "6/10 삭제, 6/11만 남아야 한다");
        assert_eq!(rows[0].date, "2026-06-11");
        assert_eq!(rows[0].start_at, "2026-06-11T10:00:00");
    }

    /// 같은 날 Reschedule은 기존 날짜 히스토리를 보존하며 당일 행만 갱신한다.
    #[tokio::test]
    async fn signal_reschedule_same_date_keeps_other_days_history() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, \
             scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id) \
             VALUES ('s1','X','braindump','thought','2026-06-11T14:00:00',60,'ev1','cal')",
        )
        .execute(&db)
        .await
        .unwrap();
        // 6/10 + 6/11 placement 시드.
        placement_store::upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 30)
            .await
            .unwrap();
        placement_store::upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T14:00:00", 60)
            .await
            .unwrap();

        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Reschedule {
                    at: "2026-06-11T16:00:00".into(),
                    duration_min: 30,
                    from_date: Some("2026-06-11".into()),
                },
                idempotency_key: "t3-reschedule-same".into(),
            },
        )
        .await
        .unwrap();

        let rows = placement_store::fetch_placements_in_range(&db, "2026-06-10", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 2, "6/10 보존, 6/11 갱신 — 2행");
        let r10 = rows.iter().find(|r| r.date == "2026-06-10").expect("6/10");
        assert_eq!(r10.start_at, "2026-06-10T09:00:00", "6/10 불변");
        assert_eq!(r10.duration_min, 30);
        let r11 = rows.iter().find(|r| r.date == "2026-06-11").expect("6/11");
        assert_eq!(r11.start_at, "2026-06-11T16:00:00", "6/11 갱신");
        assert_eq!(r11.duration_min, 30);
    }

    /// Unschedule(from_date 있음)은 그 날짜 placement만 삭제하고 다른 날짜는 보존한다.
    /// 링크 있는 신호로 설정 — build_queue_row가 linked event를 요구하므로
    /// placement 미러(Unschedule 로컬 미러 블록)까지 도달하려면 링크가 필요하다.
    #[tokio::test]
    async fn signal_unschedule_deletes_only_from_date_placement() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, \
             scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id) \
             VALUES ('s1','X','braindump','thought','2026-06-11T14:00:00',60,'ev1','cal')",
        )
        .execute(&db)
        .await
        .unwrap();
        // 6/10 + 6/11 placement 시드.
        placement_store::upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 30)
            .await
            .unwrap();
        placement_store::upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T14:00:00", 60)
            .await
            .unwrap();

        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Unschedule {
                    from_date: Some("2026-06-11".into()),
                },
                idempotency_key: "t3-unschedule".into(),
            },
        )
        .await
        .unwrap();

        let rows = placement_store::fetch_placements_in_range(&db, "2026-06-10", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "6/11 삭제, 6/10만 남아야 한다");
        assert_eq!(rows[0].date, "2026-06-10");
    }

    /// Resize도 날짜를 넘으면(top-핸들 리사이즈) 출발 날짜 행이 삭제되고 도착 날짜만 남는다
    /// — Reschedule과 같은 arm이지만 변형별로 직접 핀.
    #[tokio::test]
    async fn signal_resize_across_dates_moves_placement_row() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, \
             scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id) \
             VALUES ('s1','X','braindump','thought','2026-06-10T09:00:00',30,'ev1','cal')",
        )
        .execute(&db)
        .await
        .unwrap();
        // 6/10 placement 시드.
        placement_store::upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 30)
            .await
            .unwrap();

        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Resize {
                    at: "2026-06-11T10:00:00".into(),
                    duration_min: 60,
                    from_date: Some("2026-06-10".into()),
                },
                idempotency_key: "t3-resize-cross".into(),
            },
        )
        .await
        .unwrap();

        let rows = placement_store::fetch_placements_in_range(&db, "2026-06-10", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "6/10 삭제, 6/11만 남아야 한다");
        assert_eq!(rows[0].date, "2026-06-11");
        assert_eq!(rows[0].start_at, "2026-06-11T10:00:00");
        assert_eq!(rows[0].duration_min, 60);
    }

    /// 대상 날짜에 이미 placement가 있어도 Schedule은 UNIQUE 에러 없이 단일 행을
    /// 새 값으로 갱신한다(ON CONFLICT upsert 경유 확인).
    #[tokio::test]
    async fn signal_schedule_onto_existing_date_updates_in_place() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) \
             VALUES ('s1','X','braindump','thought')",
        )
        .execute(&db)
        .await
        .unwrap();
        // 같은 날짜에 placement 선시드.
        placement_store::upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T09:00:00", 30)
            .await
            .unwrap();

        stage_calendar_write_inner(
            &db,
            &notify,
            StageWriteRequest {
                target: WriteTarget::Signal { id: "s1".into() },
                op: WriteOp::Schedule {
                    at: "2026-06-11T14:00:00".into(),
                    duration_min: 60,
                    calendar_id: "cal".into(),
                    title: "X".into(),
                },
                idempotency_key: "t3-schedule-existing".into(),
            },
        )
        .await
        .expect("schedule onto existing date must upsert, not UNIQUE-error");

        let rows = placement_store::fetch_placements_in_range(&db, "2026-06-11", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "단일 행 유지");
        assert_eq!(rows[0].start_at, "2026-06-11T14:00:00");
        assert_eq!(rows[0].duration_min, 60);
    }
}
