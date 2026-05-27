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
use crate::db::Db;
use crate::error::AppError;
use crate::models::PendingWrite;

// ── 입력 enums ────────────────────────────────────────────────────────────────

/// stage_calendar_write의 대상. routine_check은 (routine_id, date)로 식별.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteTarget {
    Signal { id: String },
    RoutineCheck { routine_id: String, date: String },
}

/// stage_calendar_write의 op. 각 분기가 큐 행의 kind/payload/디바운스를 결정한다.
#[derive(Debug, Clone, Deserialize, Serialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WriteOp {
    /// 신규 배치 — create 이벤트, 800ms 디바운스.
    Schedule {
        at: String,
        duration_min: i32,
        calendar_id: String,
        title: String,
    },
    /// 시간 이동 — patch(start+duration), 기존 linked event 필요, 800ms 디바운스.
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
    /// 캘린더에서 빈 슬롯에 새 이벤트(추후 카드와 연결) — 800ms 디바운스.
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
    let pool = db.inner();
    let (target_kind, target_id) = match &req.target {
        WriteTarget::Signal { id } => ("signal", id.clone()),
        WriteTarget::RoutineCheck { routine_id, date } => {
            ("routine_check", format!("{routine_id}|{date}"))
        }
    };
    let (kind, calendar_id, event_id_opt, payload, debounce_ms) =
        build_queue_row(&req, pool, target_kind, &target_id).await?;
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
    for id in ids {
        sqlx::query(
            "UPDATE pending_calendar_writes
             SET payload_json = json_remove(payload_json, '$.staged'),
                 next_attempt_at = datetime('now')
             WHERE id = ?1",
        )
        .bind(id)
        .execute(pool)
        .await?;
    }
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

const DEBOUNCE_MS: i64 = 800;

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
            ("create", calendar_id.clone(), None, payload, DEBOUNCE_MS)
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
            ("patch", cal, Some(ev), payload, DEBOUNCE_MS)
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
            ("patch", cal, Some(ev), payload, DEBOUNCE_MS)
        }
        WriteOp::Unschedule => {
            let (cal, ev) = existing.ok_or_else(|| {
                AppError::validation("calendar.no_linked_event", "no linked event to unschedule")
            })?;
            ("delete", cal, Some(ev), "{}".into(), DEBOUNCE_MS)
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
            ("create", calendar_id.clone(), None, payload, DEBOUNCE_MS)
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
        _ => Ok(None),
    }
}

fn pair_or_none(t: (Option<String>, Option<String>)) -> Option<(String, String)> {
    match t {
        (Some(a), Some(b)) => Some((a, b)),
        _ => None,
    }
}
