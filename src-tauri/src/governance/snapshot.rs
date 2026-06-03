//! Reads governance/workspace/state/*.json (gitignored runtime caches, rebuildable from events).
//! There is NO write path to the governance event log in this module (INVARIANT #1, structural).

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const STATE_SUBDIR: &str = "state";

/// Resolve the governance `workspace/state` directory.
/// Override: `WORK_RADAR_GOVERNANCE_WORKSPACE` points at the `workspace` dir; we join `state`.
/// Default (dev): `<src-tauri>/../governance/workspace/state` anchored at the compile-time crate dir.
/// (Release-build resolution is deferred — spec §9 fork F1.)
pub fn resolve_governance_state_dir(workspace_override: Option<String>) -> PathBuf {
    if let Some(ws) = workspace_override.filter(|s| !s.is_empty()) {
        return PathBuf::from(ws).join(STATE_SUBDIR);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("governance")
        .join("workspace")
        .join(STATE_SUBDIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_uses_override_when_set() {
        let got = resolve_governance_state_dir(Some("/tmp/ws".to_string()));
        assert_eq!(got, PathBuf::from("/tmp/ws/state"));
    }

    #[test]
    fn resolve_ignores_empty_override_and_defaults_to_workspace_state() {
        let got = resolve_governance_state_dir(Some(String::new()));
        assert!(got.ends_with("governance/workspace/state"), "got {got:?}");
        let got_none = resolve_governance_state_dir(None);
        assert!(
            got_none.ends_with("governance/workspace/state"),
            "got {got_none:?}"
        );
    }
}
