//! Control Room IPC — read-only snapshot of the governance harness derived projections.
//! No write path to the governance event log (INVARIANT #1, structural).

use crate::error::AppError;
use crate::governance::snapshot::{
    read_snapshot, resolve_governance_state_dir, ControlRoomSnapshot,
};

/// Read the latest derived governance projections. Absent axes return empty;
/// `generatedAt` is null until the harness has projected at least once.
#[tauri::command]
#[specta::specta]
pub async fn get_control_room_snapshot() -> Result<ControlRoomSnapshot, AppError> {
    let state_dir =
        resolve_governance_state_dir(std::env::var("WORK_RADAR_GOVERNANCE_WORKSPACE").ok());
    read_snapshot(&state_dir)
}
