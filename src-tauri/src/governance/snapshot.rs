//! Snapshot shape + JSON parsing for the Control Room. The data itself comes LIVE from
//! the per-repo `boule snapshot --repo <p> --json` CLI (see governance/control_room.rs),
//! which folds `<repo>/.boule/workspace` events into this shape. This module only mirrors
//! that shape and deserializes it — there is NO write path to the governance event log
//! (INVARIANT #1, structural).

// 본 모듈의 모든 reader/helper는 Result<_, AppError>로 통일(단일 envelope, 레포 전역 규약)
// → 모듈 단위 result_large_err 허용(commands/routines/google_sync.rs와 동일 관용).
#![allow(clippy::result_large_err)]

use crate::error::AppError;
use serde::{Deserialize, Serialize};

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

/// Parse the combined Control Room snapshot JSON emitted by `boule snapshot --json`.
/// The CLI always prints one JSON object on success (empty arrays + null `generatedAt`
/// for a repo with no events). Empty output ⇒ terminal error; malformed JSON ⇒ terminal
/// parse error. Unknown phase strings degrade to `Unknown` (drift-resilient enums).
pub fn parse_control_room_snapshot(json: &str) -> Result<ControlRoomSnapshot, AppError> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Err(AppError::terminal(
            "governance.snapshot_empty",
            "boule snapshot produced no output",
        ));
    }
    serde_json::from_str::<ControlRoomSnapshot>(trimmed)
        .map_err(|e| AppError::terminal("governance.parse_failed", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_snapshot_with_all_axes() {
        // Full shape incl. a non-null session surface (Option<String>) and a SLIM
        // orchestrator session (no surface) — exercises both session row kinds.
        let json = r#"{
            "generatedAt": "2026-06-09T00:00:00Z",
            "tasks": [{"taskId":"t1","title":"T","phase":"active"}],
            "plans": [],
            "specs": [],
            "sessions": [{"sessionId":"s1","surface":"cmux:42","ownership":"user_owned","taskId":"t1","phase":"active"}],
            "handoffs": [],
            "orchestrator": {
                "tasks": [{"taskId":"t1","phase":"active","hasOpenBlock":true}],
                "plans": [],
                "sessions": [{"sessionId":"s1","phase":"active","ownership":"user_owned","taskId":"t1"}]
            }
        }"#;
        let snap = parse_control_room_snapshot(json).unwrap();
        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.tasks[0].phase, TaskPhase::Active);
        assert_eq!(snap.sessions[0].surface.as_deref(), Some("cmux:42"));
        assert_eq!(snap.sessions[0].ownership, Ownership::UserOwned);
        assert_eq!(snap.orchestrator.sessions[0].session_id, "s1");
        assert!(snap.orchestrator.tasks[0].has_open_block);
        assert_eq!(snap.generated_at.as_deref(), Some("2026-06-09T00:00:00Z"));
    }

    #[test]
    fn parses_empty_but_valid_snapshot() {
        // A repo with no .boule events ⇒ the CLI emits empty arrays + null generatedAt.
        let json = r#"{"generatedAt":null,"tasks":[],"plans":[],"specs":[],"sessions":[],"handoffs":[],"orchestrator":{"tasks":[],"plans":[],"sessions":[]}}"#;
        let snap = parse_control_room_snapshot(json).unwrap();
        assert!(snap.tasks.is_empty() && snap.sessions.is_empty());
        assert_eq!(snap.generated_at, None);
    }

    #[test]
    fn empty_output_is_terminal_error() {
        let err = parse_control_room_snapshot("   \n").unwrap_err();
        assert_eq!(err.code, "governance.snapshot_empty");
    }

    #[test]
    fn malformed_json_is_terminal_error() {
        let err = parse_control_room_snapshot("{ not json").unwrap_err();
        assert_eq!(err.code, "governance.parse_failed");
    }

    #[test]
    fn unknown_phase_degrades_not_errors() {
        let json = r#"{"generatedAt":null,"tasks":[{"taskId":"t1","title":"T","phase":"frobnicated"}],"plans":[],"specs":[],"sessions":[],"handoffs":[],"orchestrator":{"tasks":[],"plans":[],"sessions":[]}}"#;
        let snap = parse_control_room_snapshot(json).unwrap();
        assert_eq!(snap.tasks[0].phase, TaskPhase::Unknown);
    }
}
