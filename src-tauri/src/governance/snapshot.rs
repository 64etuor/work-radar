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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheck {
    pub id: String,
    pub ok: bool,
    pub level: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessGates {
    pub preflight: bool,
    pub conductor: bool,
    pub observer: bool,
    pub auto: bool,
    pub stall: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessView {
    pub ready: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
    pub gates: ReadinessGates,
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
    #[serde(default)]
    pub infra: Vec<PreflightCheck>,
    #[serde(default)]
    pub readiness: ReadinessView,
    /// 이 스냅샷이 실제로 접은 레포(멀티레포 프로젝트 coverage 표시). CLI 출력이 아니라
    /// Rust가 DB 해석 결과로 채운다 — None = 로컬 레포 없는 프로젝트(빈 스냅샷).
    #[serde(default)]
    pub covered_repo: Option<CoveredRepo>,
    /// P4(a) — 완주-미머지 `boule/<planId>` 브랜치 목록("merge 대기 N"). CLI가 git 리스팅
    /// 실패 시 필드 자체를 omit(fail-soft)하므로 default 빈 벡터로 흡수한다. 표시 전용 —
    /// 머지는 인간 유지(자동 merge-back 기각, 플랜 §5).
    #[serde(default)]
    pub unmerged_plan_branches: Vec<UnmergedPlanBranch>,
}

/// 완주-미머지 plan 브랜치 한 행 — governance `repo/planBranches.ts`의 `UnmergedPlanBranch`
/// JSON(camelCase) 미러. 읽기 전용 가시화 데이터(이 모듈엔 git/merge 경로 없음).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnmergedPlanBranch {
    /// 짧은 브랜치명, 예: `boule/evt_20260610_075405_4553`.
    pub branch: String,
    /// 축약 tip SHA.
    pub tip: String,
    /// tip 커밋 subject(한 줄).
    pub subject: String,
    /// HEAD에서 도달 불가한 커밋 수(`rev-list --count HEAD..branch`); per-branch 카운트
    /// 실패 시 None(행 자체는 그대로 표시). specta i64 금지 규약 → i32.
    pub ahead_count: Option<i32>,
}

/// Control Room 스냅샷의 집계 대상 레포 식별. 프로젝트는 레포를 여러 개 가질 수 있지만
/// 스냅샷은 첫 enabled 로컬 레포 하나만 접는다(`resolve_project_repo_row`) — FE가 그
/// 사실을 표시할 수 있도록 식별 + 형제 수를 함께 내려준다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoveredRepo {
    pub repo_id: String,
    /// 표시용 이름 — local_path의 마지막 세그먼트.
    pub name: String,
    pub local_path: String,
    /// 프로젝트의 enabled 로컬 레포 총수(이 레포 포함). 1 초과 = 미포함 레포 존재.
    pub enabled_local_total: u32,
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

    #[test]
    fn parses_infra_and_readiness_blocks() {
        let json = r#"{
            "generatedAt": null,
            "tasks": [], "plans": [], "specs": [], "sessions": [], "handoffs": [],
            "orchestrator": {"tasks": [], "plans": [], "sessions": []},
            "infra": [
                {"id":"cmux_socket","ok":false,"level":"required","detail":"CMUX_SOCKET_PATH MISSING"},
                {"id":"conductor_mode","ok":false,"level":"advisory","detail":"stub"}
            ],
            "readiness": {
                "ready": false,
                "blockers": ["BOULE_OBSERVER_MODE!=live — crashes/stalls undetected (unsafe unattended)"],
                "warnings": [],
                "gates": {"preflight":false,"conductor":false,"observer":false,"auto":false,"stall":true}
            }
        }"#;
        let snap = parse_control_room_snapshot(json).unwrap();
        assert_eq!(snap.infra.len(), 2);
        assert_eq!(snap.infra[0].id, "cmux_socket");
        assert!(!snap.infra[0].ok);
        assert_eq!(snap.infra[0].level, "required");
        assert!(!snap.readiness.ready);
        assert!(snap.readiness.gates.stall);
        assert!(!snap.readiness.gates.observer);
        assert_eq!(snap.readiness.blockers.len(), 1);
    }

    #[test]
    fn default_snapshot_has_empty_infra_and_unready_readiness() {
        let snap = ControlRoomSnapshot::default();
        assert!(snap.infra.is_empty());
        assert!(!snap.readiness.ready);
        assert!(!snap.readiness.gates.preflight);
    }

    /// P4(a): `unmergedPlanBranches` 파싱 — null aheadCount(브랜치별 카운트 실패)도 행 유지.
    #[test]
    fn parses_unmerged_plan_branches_including_null_ahead_count() {
        let json = r#"{
            "generatedAt": null,
            "tasks": [], "plans": [], "specs": [], "sessions": [], "handoffs": [],
            "orchestrator": {"tasks": [], "plans": [], "sessions": []},
            "unmergedPlanBranches": [
                {"branch":"boule/evt_1","tip":"abc1234","subject":"feat: step 3","aheadCount":4},
                {"branch":"boule/evt_2","tip":"def5678","subject":"fix: retry","aheadCount":null}
            ]
        }"#;
        let snap = parse_control_room_snapshot(json).unwrap();
        assert_eq!(snap.unmerged_plan_branches.len(), 2);
        assert_eq!(snap.unmerged_plan_branches[0].branch, "boule/evt_1");
        assert_eq!(snap.unmerged_plan_branches[0].ahead_count, Some(4));
        assert_eq!(snap.unmerged_plan_branches[1].subject, "fix: retry");
        assert_eq!(snap.unmerged_plan_branches[1].ahead_count, None);
    }

    /// P4(a) fail-soft 계약: CLI가 git 리스팅 실패 시 필드를 omit → 빈 벡터로 흡수(에러 아님).
    #[test]
    fn absent_unmerged_plan_branches_defaults_to_empty() {
        let json = r#"{"generatedAt":null,"tasks":[],"plans":[],"specs":[],"sessions":[],"handoffs":[],"orchestrator":{"tasks":[],"plans":[],"sessions":[]}}"#;
        let snap = parse_control_room_snapshot(json).unwrap();
        assert!(snap.unmerged_plan_branches.is_empty());
    }
}
