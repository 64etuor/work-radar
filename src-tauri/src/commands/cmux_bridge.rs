//! cmux notification bridge commands.
//!
//! Read-only observer surface for the existing local cmux notification hooks.

use crate::cmux_bridge::{claude_dir_for_home, load_snapshot_from_dir, CmuxBridgeSnapshot};
use crate::error::AppError;
use crate::platform::{self, OptionalIntegration};

#[tauri::command]
#[specta::specta]
pub async fn cmux_bridge_snapshot() -> Result<CmuxBridgeSnapshot, AppError> {
    if !platform::supports_integration(platform::current_host(), OptionalIntegration::Cmux) {
        return Ok(CmuxBridgeSnapshot {
            transports: vec![],
            sessions: vec![],
            warnings: vec!["cmux bridge is not supported on this platform".to_string()],
        });
    }
    let home = platform::home_dir()
        .ok_or_else(|| AppError::terminal("cmux_bridge.home", "HOME is not set"))?;
    load_snapshot_from_dir(&claude_dir_for_home(&home))
        .map_err(|e| AppError::unexpected("cmux_bridge.snapshot", e))
}
