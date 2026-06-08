//! cmux notification bridge commands.
//!
//! Read-only observer surface for the existing local cmux notification hooks.

use crate::cmux_bridge::{claude_dir_for_home, load_snapshot_from_dir, CmuxBridgeSnapshot};
use crate::error::AppError;

#[tauri::command]
#[specta::specta]
pub async fn cmux_bridge_snapshot() -> Result<CmuxBridgeSnapshot, AppError> {
    let home = std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| AppError::terminal("cmux_bridge.home", "HOME is not set"))?;
    load_snapshot_from_dir(&claude_dir_for_home(&home))
        .map_err(|e| AppError::unexpected("cmux_bridge.snapshot", e))
}
