//! Control Room IPC — read-only snapshot of the governance harness derived projections.
//! No write path to the governance event log (INVARIANT #1, structural).

use crate::db::Db;
use crate::error::AppError;
use crate::governance::boule_config::{
    get_boule_config_core, set_boule_config_core, BouleConfigSettings, SetBouleConfigInput,
};
use crate::governance::snapshot::{
    read_snapshot, resolve_governance_state_dir, ControlRoomSnapshot,
};
use tauri::State;

/// Read the latest derived governance projections. Absent axes return empty;
/// `generatedAt` is null until the harness has projected at least once.
#[tauri::command]
#[specta::specta]
pub async fn get_control_room_snapshot() -> Result<ControlRoomSnapshot, AppError> {
    let state_dir =
        resolve_governance_state_dir(std::env::var("WORK_RADAR_GOVERNANCE_WORKSPACE").ok());
    read_snapshot(&state_dir)
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
