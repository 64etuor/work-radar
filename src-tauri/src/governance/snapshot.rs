//! Reads governance/workspace/state/*.json (gitignored runtime caches, rebuildable from events).
//! There is NO write path to the governance event log in this module (INVARIANT #1, structural).

// 본 모듈의 모든 reader/helper는 Result<_, AppError>로 통일(단일 envelope, 레포 전역 규약)
// → 모듈 단위 result_large_err 허용(commands/routines/google_sync.rs와 동일 관용).
#![allow(clippy::result_large_err)]

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

// ── Phase enums (mirror governance fold types; Unknown = drift-resilient fallback) ──
//
// NOTE on the `Unknown` fallback: serde's `#[serde(other)]` would be the obvious
// way to get drift-resilient deserialization, but specta rc.25's TypeScript
// formatter rejects `#[serde(other)]` on an externally-tagged (bare-string) enum
// ("requires a tagged enum representation"). Tagging would change the JSON shape
// from bare `"active"` strings to objects, breaking the governance `render*`
// output contract and the FE `statusTone` string-literal switch. So each enum
// keeps the bare-string contract (`Serialize` + `specta::Type` emit a plain
// string union incl. `"unknown"`) and implements a manual `Deserialize` that maps
// any unrecognized string to `Unknown`. The `phase_enum!` macro factors out that
// shared deserialize-with-fallback logic across the six enums.

macro_rules! phase_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant,)+
            /// Drift-resilient fallback: any wire value not in the known set.
            Unknown,
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                let raw = String::deserialize(deserializer)?;
                Ok(match raw.as_str() {
                    $($wire => $name::$variant,)+
                    _ => $name::Unknown,
                })
            }
        }
    };
}

phase_enum!(TaskPhase {
    Ready => "ready",
    Active => "active",
    Blocked => "blocked",
    Done => "done",
    Cancelled => "cancelled",
});

phase_enum!(PlanPhase {
    Draft => "draft",
    Active => "active",
    NeedsRevision => "needs_revision",
    Completed => "completed",
    Archived => "archived",
    Superseded => "superseded",
});

phase_enum!(SpecPhase {
    Draft => "draft",
    Accepted => "accepted",
    Archived => "archived",
});

phase_enum!(SessionPhase {
    Planned => "planned",
    Opening => "opening",
    Active => "active",
    Waiting => "waiting",
    Blocked => "blocked",
    ContextPressureHigh => "context_pressure_high",
    CheckpointRequested => "checkpoint_requested",
    HandoffReady => "handoff_ready",
    Closing => "closing",
    Closed => "closed",
    Crashed => "crashed",
    Recovering => "recovering",
});

phase_enum!(HandoffPhase {
    Requested => "requested",
    Validating => "validating",
    Pending => "pending",
    Invalid => "invalid",
    Consumed => "consumed",
});

phase_enum!(Ownership {
    UserOwned => "user_owned",
    OrchestratorOwned => "orchestrator_owned",
    ExternalOwned => "external_owned",
});

// ── Row structs (camelCase JSON keys mirror the governance render* output) ──

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub task_id: String,
    pub title: String,
    pub phase: TaskPhase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanRow {
    pub plan_id: String,
    pub title: String,
    pub phase: PlanPhase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpecRow {
    pub spec_id: String,
    pub title: String,
    pub phase: SpecPhase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub session_id: String,
    pub surface: Option<String>,
    pub ownership: Ownership,
    pub task_id: Option<String>,
    pub phase: SessionPhase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HandoffRow {
    pub handoff_id: String,
    pub session_id: String,
    pub phase: HandoffPhase,
}

// orchestrator-view.json (slim sessions: no surface)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorTaskRow {
    pub task_id: String,
    pub phase: TaskPhase,
    pub has_open_block: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorPlanRow {
    pub plan_id: String,
    pub phase: PlanPhase,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorSessionRow {
    pub session_id: String,
    pub phase: SessionPhase,
    pub ownership: Ownership,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorView {
    pub tasks: Vec<OrchestratorTaskRow>,
    pub plans: Vec<OrchestratorPlanRow>,
    pub sessions: Vec<OrchestratorSessionRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ControlRoomSnapshot {
    /// RFC3339 newest state-file mtime; None if nothing has been projected yet.
    pub generated_at: Option<String>,
    pub tasks: Vec<TaskRow>,
    pub plans: Vec<PlanRow>,
    pub specs: Vec<SpecRow>,
    pub sessions: Vec<SessionRow>,
    pub handoffs: Vec<HandoffRow>,
    pub orchestrator: OrchestratorView,
}

/// Read one axis file. Absent ⇒ `T::default()` (axis not yet projected). Corrupt ⇒ terminal error.
/// Records the file's mtime into `newest` when present.
fn read_axis<T>(
    state_dir: &Path,
    file: &str,
    newest: &mut Option<std::time::SystemTime>,
) -> Result<T, AppError>
where
    T: serde::de::DeserializeOwned + Default,
{
    let path = state_dir.join(file);
    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
        Err(e) => {
            return Err(AppError::terminal(
                "governance.stat_failed",
                format!("{file}: {e}"),
            ))
        }
    };
    if let Ok(modified) = meta.modified() {
        if newest.is_none_or(|n| modified > n) {
            *newest = Some(modified);
        }
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::terminal("governance.read_failed", format!("{file}: {e}")))?;
    serde_json::from_str::<T>(&raw)
        .map_err(|e| AppError::terminal("governance.parse_failed", format!("{file}: {e}")))
}

/// Read all six derived projection files into a single read-only snapshot.
pub fn read_snapshot(state_dir: &Path) -> Result<ControlRoomSnapshot, AppError> {
    let mut newest: Option<std::time::SystemTime> = None;
    let tasks = read_axis::<Vec<TaskRow>>(state_dir, "tasks.json", &mut newest)?;
    let plans = read_axis::<Vec<PlanRow>>(state_dir, "plans.json", &mut newest)?;
    let specs = read_axis::<Vec<SpecRow>>(state_dir, "specs.json", &mut newest)?;
    let sessions = read_axis::<Vec<SessionRow>>(state_dir, "sessions.json", &mut newest)?;
    let handoffs = read_axis::<Vec<HandoffRow>>(state_dir, "handoffs.json", &mut newest)?;
    let orchestrator =
        read_axis::<OrchestratorView>(state_dir, "orchestrator-view.json", &mut newest)?;
    let generated_at = newest.map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
    Ok(ControlRoomSnapshot {
        generated_at,
        tasks,
        plans,
        specs,
        sessions,
        handoffs,
        orchestrator,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, file: &str, body: &str) {
        fs::write(dir.join(file), body).unwrap();
    }

    #[test]
    fn reads_present_axes_and_treats_absent_as_empty() {
        let tmp = std::env::temp_dir().join(format!("cr-snap-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        write(
            &tmp,
            "tasks.json",
            r#"[{"taskId":"t1","title":"T","phase":"active"}]"#,
        );
        // sessions.json: full shape incl. a NON-null surface (round-trips Option<String>).
        write(
            &tmp,
            "sessions.json",
            r#"[{"sessionId":"s1","surface":"cmux:42","ownership":"user_owned","taskId":"t1","phase":"active"}]"#,
        );
        // orchestrator-view.json: SLIM sessions (no surface) — exercises OrchestratorSessionRow.
        write(
            &tmp,
            "orchestrator-view.json",
            r#"{"tasks":[{"taskId":"t1","phase":"active","hasOpenBlock":true}],"plans":[],"sessions":[{"sessionId":"s1","phase":"active","ownership":"user_owned","taskId":"t1"}]}"#,
        );
        // plans/specs/handoffs.json intentionally absent.

        let snap = read_snapshot(&tmp).unwrap();
        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.tasks[0].phase, TaskPhase::Active);
        assert_eq!(snap.sessions[0].surface.as_deref(), Some("cmux:42"));
        assert_eq!(snap.sessions[0].ownership, Ownership::UserOwned);
        assert_eq!(snap.orchestrator.sessions[0].session_id, "s1");
        assert!(snap.orchestrator.tasks[0].has_open_block);
        assert!(snap.plans.is_empty() && snap.specs.is_empty() && snap.handoffs.is_empty());
        assert!(snap.generated_at.is_some());
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn none_present_yields_empty_snapshot_with_null_generated_at() {
        let tmp = std::env::temp_dir().join(format!("cr-snap-empty-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let snap = read_snapshot(&tmp).unwrap();
        assert!(snap.tasks.is_empty());
        assert_eq!(snap.generated_at, None);
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn corrupt_file_is_terminal_error() {
        let tmp = std::env::temp_dir().join(format!("cr-snap-bad-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        write(&tmp, "tasks.json", "{ not json");
        let err = read_snapshot(&tmp).unwrap_err();
        assert_eq!(err.code, "governance.parse_failed");
        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn unknown_phase_degrades_not_errors() {
        let tmp = std::env::temp_dir().join(format!("cr-snap-unk-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        write(
            &tmp,
            "tasks.json",
            r#"[{"taskId":"t1","title":"T","phase":"frobnicated"}]"#,
        );
        let snap = read_snapshot(&tmp).unwrap();
        assert_eq!(snap.tasks[0].phase, TaskPhase::Unknown);
        fs::remove_dir_all(&tmp).ok();
    }

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
