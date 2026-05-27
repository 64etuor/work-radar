use serde::{Deserialize, Serialize};
use specta::Type;
/// 단일 잡 폴링용 경량 상태 (B3: EnrichModal 인플레이스 폴링).
/// status: 잡 상태(닫힌 enum), has_proposal: proposal 컬럼 비-NULL 여부, detail: 실패 메시지.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStatus {
    pub status: AgentStatus,
    pub has_proposal: bool,
    pub detail: Option<String>,
}

// ── Agent 스파인 (Phase 7, 잡 큐 + bounds + kill) ──────────────────────────────────
//
// INVARIANT #5: 모든 잡은 bound된다 (timeout + max_turns + cost_cap + kill switch).
// INVARIANT #6: 코드 잡은 worktree 격리, 샌드박스 기본 read_only (danger_full 금지).
// INVARIANT #2: Codex 출력은 외부를 직접 mutate 못함 — Proposal일 뿐, Acceptance 게이트 통과 후에만 반영.
// 잡은 agent_runs(0001)에 영속된다(INVARIANT #7: SQLite = 잡의 SSOT). 토큰 본문은 절대 미포함.

/// 잡 실행 엔진. agent_runs.engine CHECK과 동일.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Engine {
    Codex,
    Hermes,
    Claude,
}

/// 잡이 속한 레일. 결정 레일은 사람만 — 자동화는 제안/실행 레일에만 (INVARIANT #1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum AgentRail {
    Suggestion,
    Execution,
}

/// 샌드박스 권한. 기본 read_only, 쓰기는 명시 승인 시에만. danger_full은 타입에 없음 (INVARIANT #6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Sandbox {
    ReadOnly,
    WorkspaceWrite,
}

impl Sandbox {
    /// `codex exec --sandbox <flag>` 값 (하이픈 표기 — 실 설치본 0.125 검증).
    pub fn as_codex_flag(self) -> &'static str {
        match self {
            Sandbox::ReadOnly => "read-only",
            Sandbox::WorkspaceWrite => "workspace-write",
        }
    }
}

/// 잡 상태 (agent_runs.status CHECK과 동일). 잡 생애주기:
/// proposed(큐 대기) → running → succeeded | failed | cancelled. (awaiting_approval은 Phase 8.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum AgentStatus {
    Proposed,
    AwaitingApproval,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl AgentStatus {
    /// 영속(SQLite)·IPC 문자열 표현. serde/sqlx의 snake_case와 동일 — 잡 상태 문자열의 **단일 출처**.
    /// SQL 바인딩·로그·에러 메시지가 흩어진 리터럴 대신 이 함수를 경유한다.
    pub fn as_str(self) -> &'static str {
        match self {
            AgentStatus::Proposed => "proposed",
            AgentStatus::AwaitingApproval => "awaiting_approval",
            AgentStatus::Running => "running",
            AgentStatus::Succeeded => "succeeded",
            AgentStatus::Failed => "failed",
            AgentStatus::Cancelled => "cancelled",
        }
    }
}

impl std::fmt::Display for AgentStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Jobs 뷰 표시용 잡 한 항목. agent_runs에서 도출 (i64 컬럼은 specta 금지 → u32/f64로 변환).
/// 토큰 본문은 절대 담기지 않는다(INVARIANT).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunView {
    pub id: String,
    pub project_id: Option<String>,
    pub engine: Engine,
    /// 잡 종류 (자유 텍스트 — e.g. "echo", "draft_pr_selfcheck").
    pub kind: String,
    pub rail: AgentRail,
    pub sandbox: Sandbox,
    pub status: AgentStatus,
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
    pub cost_tokens: Option<u32>,
    pub cost_usd: Option<f64>,
    pub repo_id: Option<String>,
    pub workdir: Option<String>,
    pub log_path: Option<String>,
    /// 사람이 읽을 상세 (성공 요약 또는 실패/취소 사유 — result JSON에서 도출).
    pub detail: Option<String>,
    /// 잡 트리거 JSON ({ prUrl, repoFullName, prNumber, ... }). Phase 8 PR self-check 연결용.
    pub trigger: Option<String>,
    /// suggestion 산출물 존재 여부 (awaiting_approval 게이트 — 상세는 `pr_proposal`로 조회).
    pub has_proposal: bool,
    pub created_at: String,
    pub started_at: Option<String>,
    pub heartbeat_at: Option<String>,
    pub recovery_count: u32,
    pub finished_at: Option<String>,
}

/// codex CLI 가용성 (graceful degrade 판정 — 미설치/미인증이면 자동화 UI 비활성).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CodexAvailability {
    /// PATH(또는 알려진 경로)에서 codex 바이너리가 발견됨.
    pub installed: bool,
    /// `codex login status`가 성공 (로그인됨). installed=false면 항상 false.
    pub authed: bool,
    pub version: Option<String>,
    /// 사람이 읽을 상태 상세.
    pub detail: String,
}

/// echo 테스트 잡 입력 (codex 없이 bound/kill/로그 캡처 검증). seconds 동안 틱을 출력하는
/// 셸아웃 잡 — happy(짧은 seconds) / timeout 테스트(긴 seconds + 짧은 timeout_sec).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEchoInput {
    /// 잡 프로세스가 1초 간격 틱을 출력할 횟수 (0 = 즉시 종료).
    pub seconds: u32,
    /// timeout bound (초). seconds보다 작으면 timeout→kill→failed.
    pub timeout_sec: u32,
    /// 첫 줄로 출력할 메시지 (로그 캡처 확인).
    pub message: String,
}

/// codex 잡 입력. Phase 7은 read_only 샌드박스 고정 (실행 레일=Phase 10). bounds는 강제(INVARIANT #5).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerCodexInput {
    pub project_id: Option<String>,
    /// 코드 잡이면 worktree 베이스 레포 (없으면 비-레포 prompt 잡).
    pub repo_id: Option<String>,
    pub prompt: String,
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

// ── PR self-check 자동 초안 (Phase 8, 제안 레일 첫 자동화) ──────────────────────────
//
// INVARIANT #2: codex 출력은 Proposal(draft)일 뿐 — 사람이 accept해야 (로컬) 반영, GitHub는 무변경.
// INVARIANT #6: read_only 샌드박스 + worktree 격리. INVARIANT #5: bounds 강제.

/// PR self-check 초안 잡 입력 (PR Radar 카드에서 트리거). repo는 worktree용 local_path가 있어야 한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerPrSelfCheckInput {
    pub project_id: Option<String>,
    /// PR이 속한 repo full name ('owner/repo'). diff fetch + repo 해석에 사용.
    pub repo_full_name: String,
    pub pr_number: u32,
    pub pr_url: String,
    /// bounds (강제). 비면 백엔드 기본값.
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

/// self-check 한 항목 (codex 제안 → 사람이 체크/수정). checked 기본 false (사람이 확인하기 전).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckItem {
    pub item: String,
    #[serde(default)]
    pub checked: bool,
    pub note: Option<String>,
}

/// PR self-check 초안 Proposal (codex 산출물, draft). 사람이 accept하면 로컬에 반영(제출은 수동).
/// serde default로 codex가 일부 필드를 누락해도 관용한다(스키마-관용 — Phase 7 선례).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrSelfCheckProposal {
    /// PR 설명 초안 (사람이 수동 제출).
    #[serde(default)]
    pub summary: String,
    /// self-check 체크리스트 항목.
    #[serde(default)]
    pub self_checks: Vec<SelfCheckItem>,
    /// 스크린샷이 필요한 변경 (UI 등).
    #[serde(default)]
    pub screenshots_needed: Vec<String>,
    /// 마이그레이션/배포 주의 노트.
    #[serde(default)]
    pub migration_notes: Vec<String>,
}

#[cfg(test)]
mod agent_status_tests {
    use super::AgentStatus;

    /// `as_str()`(단일 출처)가 serde·sqlx 인코딩(snake_case)과 1:1로 일치함을 잠근다.
    /// 셋 중 하나라도 어긋나면 영속/IPC/SQL 바인딩 사이에 상태 문자열 드리프트가 생긴다.
    #[test]
    fn as_str_matches_serde_snake_case_and_display() {
        let all = [
            AgentStatus::Proposed,
            AgentStatus::AwaitingApproval,
            AgentStatus::Running,
            AgentStatus::Succeeded,
            AgentStatus::Failed,
            AgentStatus::Cancelled,
        ];
        for v in all {
            let json = serde_json::to_string(&v).unwrap();
            assert_eq!(json, format!("\"{}\"", v.as_str()), "serde != as_str");
            assert_eq!(v.to_string(), v.as_str(), "Display != as_str");
        }
        // 닫힌 세트 — 마이그레이션 CHECK(0001)과 동일한 6개 값.
        assert_eq!(AgentStatus::AwaitingApproval.as_str(), "awaiting_approval");
    }
}
