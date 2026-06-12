//! Control Room IPC — read-only snapshot of the governance harness derived projections.
//! No write path to the governance event log (INVARIANT #1, structural).

use crate::db::Db;
use crate::error::AppError;
use crate::governance::boule_config::{
    get_boule_config_core, set_boule_config_core, BouleConfigSettings, SetBouleConfigInput,
};
use crate::governance::control_room::get_project_control_room_snapshot as get_project_control_room_snapshot_core;
use crate::governance::snapshot::ControlRoomSnapshot;
use crate::governance::ticker::{
    clear_ticker_attention_core, get_project_tick_status_core, list_project_tick_status_core,
    set_project_tick_enabled_core, set_project_tick_interval_core, set_project_tick_live_core,
    tick_project_now as tick_project_now_core, ProjectTickStatus, ProjectTickerStatusRow,
    TickProjectNowResult,
};
use crate::governance::ticker_scheduler::{
    get_ticker_scheduler_status_core, TickerSchedulerStatus,
};
use tauri::State;

/// Read ONE project's LIVE Control Room snapshot by folding its `.boule/workspace` events
/// via the bounded, read-only `boule snapshot` CLI. The repo path is resolved from the DB
/// (never renderer-supplied). Empty arrays + null `generatedAt` for a repo with no events.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)] // AppError 큰 Err 변형 — 레포 관용(snapshot.rs 등과 동일).
pub async fn get_project_control_room_snapshot(
    db: State<'_, Db>,
    project_id: String,
) -> Result<ControlRoomSnapshot, AppError> {
    get_project_control_room_snapshot_core(db.inner(), &project_id).await
}

/// Read a designated LOCAL repo's Boule config (kind + autonomyLevel + reviewQuorum + budget).
/// Absent file ⇒ per-kind defaults (config_exists=false). Settings-only — no event write path.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)] // AppError 큰 Err 변형 — 레포 관용(snapshot.rs 등과 동일).
pub async fn get_boule_config(
    db: State<'_, Db>,
    repo_id: String,
) -> Result<BouleConfigSettings, AppError> {
    get_boule_config_core(db.inner(), &repo_id).await
}

/// Update a local repo's Boule config. Paths are resolved from the DB (never renderer-supplied);
/// preserves fields this UI doesn't manage. ⚠ auto_plan/full OPEN INVARIANT #1's human gate
/// (test/dev) — the UI warns; acceptance auto-fires actor:"system", never a forged human.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)] // AppError 큰 Err 변형 — 레포 관용(snapshot.rs 등과 동일).
pub async fn set_boule_config(
    db: State<'_, Db>,
    input: SetBouleConfigInput,
) -> Result<BouleConfigSettings, AppError> {
    set_boule_config_core(db.inner(), &input).await
}

/// Read a project's ticker settings/status. Missing ticker row returns a disabled default view.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn get_project_tick_status(
    db: State<'_, Db>,
    project_id: String,
) -> Result<ProjectTickStatus, AppError> {
    get_project_tick_status_core(db.inner(), &project_id).await
}

/// Read every project's live ticker status from app SQLite. Missing ticker rows return disabled
/// defaults; Boule autonomy is best-effort from the first enabled local repo config.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn list_project_tick_status(
    db: State<'_, Db>,
) -> Result<Vec<ProjectTickerStatusRow>, AppError> {
    list_project_tick_status_core(db.inner()).await
}

/// Toggle only the operator clock flag. This does not mutate Boule autonomy/governance state.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn set_project_tick_enabled(
    db: State<'_, Db>,
    project_id: String,
    enabled: bool,
) -> Result<ProjectTickStatus, AppError> {
    set_project_tick_enabled_core(db.inner(), &project_id, enabled).await
}

/// Store the future scheduler interval. T1 has no scheduler; this setting is inert until T2.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn set_project_tick_interval(
    db: State<'_, Db>,
    project_id: String,
    interval_sec: Option<i32>,
) -> Result<ProjectTickStatus, AppError> {
    set_project_tick_interval_core(db.inner(), &project_id, interval_sec).await
}

/// Per-project LIVE opt-in (operator consent to spawn real sessions): when on, the app
/// injects BOULE_CONDUCTOR_MODE/OBSERVER_MODE=live into this project's boule tick/snapshot
/// children. Settings-only — no governance event/autonomy write.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn set_project_tick_live(
    db: State<'_, Db>,
    project_id: String,
    live: bool,
) -> Result<ProjectTickStatus, AppError> {
    set_project_tick_live_core(db.inner(), &project_id, live).await
}

/// P1(a) — attention 래치 해제(operator affordance). `attention_required=0` +
/// `consecutive_failures=0`(다음 인프라 실패가 깨끗한 새 bounded-escalation 윈도우에서
/// 재래치되도록). `last_*`/`in_progress`/스케줄러 heartbeat는 건드리지 않는다 —
/// 래치 사유는 다음 tick까지 그대로 보인다. governance 이벤트 쓰기 없음(INVARIANT #1).
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn clear_ticker_attention(
    db: State<'_, Db>,
    project_id: String,
) -> Result<ProjectTickStatus, AppError> {
    clear_ticker_attention_core(db.inner(), &project_id).await
}

/// Run one bounded Boule heartbeat for the DB-resolved local repo path.
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn tick_project_now(
    db: State<'_, Db>,
    project_id: String,
) -> Result<TickProjectNowResult, AppError> {
    tick_project_now_core(db.inner(), &project_id).await
}

/// Read the app-bound scheduler's heartbeat. `None` = the scheduler has never woken on this
/// database; a stale `secondsSinceWake` means the scheduler task is dead (previously invisible).
#[tauri::command]
#[specta::specta]
#[allow(clippy::result_large_err)]
pub async fn get_ticker_scheduler_status(
    db: State<'_, Db>,
) -> Result<Option<TickerSchedulerStatus>, AppError> {
    get_ticker_scheduler_status_core(db.inner()).await
}
