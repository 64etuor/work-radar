use super::{AreaTag, Quadrant};
use serde::{Deserialize, Serialize};
use specta::Type;
// ── Phase 9: 추가 suggestion 자동화 (enrich / CI triage) ──────────────
//
// 모두 제안 레일 + Acceptance 게이트(Phase 8 PR self-check 패턴). codex 출력은 Proposal(draft)일 뿐,
// 사람이 accept해야 (로컬) 반영된다 — 외부(Notion/GitHub) 직접 mutate 없음(INVARIANT #2).
// INVARIANT #1: enrich는 quadrant를 자동 확정하지 않는다 — suggested_quadrant/suggested_area는 힌트.
// INVARIANT #5: CI triage 재트리거는 retry_key/retry_count로 캡되고 초과 시 Q1 escalate(사람).

/// 미분류 전체 배치 enrich 잡 입력 (Phase 15 #4). 모든 미분류 카드를 한 codex 호출로 enrich한다.
/// project_id가 있으면 해당 프로젝트로 한정, 없으면 전체. bounds는 강제(INVARIANT #5).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEnrichAllInput {
    pub project_id: Option<String>,
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

/// 배치 enrich 한 카드 제안 (Phase 15 #4). codex가 카드별로 낸 suggested 힌트.
/// Quadrant/AreaTag로 타입해 닫힌 세트를 구조적으로 강제한다(세트 밖이면 카드 단위로 skip). serde
/// default로 누락 관용. **suggested_*는 힌트일 뿐** — accept해도 quadrant 자동 확정 0(INVARIANT #1).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchEnrichItem {
    /// 대상 신호 id (입력 cards.json과 매칭).
    pub id: String,
    /// 표시용 카드 제목 (UI 패널 — 입력 신호에서 채워 돌려준다).
    #[serde(default)]
    pub title: Option<String>,
    /// 제안 사분면 힌트(닫힌 enum). 자동 분류 아님.
    #[serde(default)]
    pub suggested_quadrant: Option<Quadrant>,
    /// 제안 라이프 도메인 힌트(닫힌 taxonomy).
    #[serde(default)]
    pub suggested_area: Option<AreaTag>,
    /// 제안 근거(짧은 설명).
    #[serde(default)]
    pub reason: Option<String>,
}

/// 배치 enrich 산출 Proposal (Phase 15 #4, codex draft). 카드별 제안 목록 + 부분 실패 격리 카운트.
/// codex가 형식 밖/세트 밖/미존재 카드를 낸 항목은 `items`에서 빠지고 `skipped`로 집계된다(부분 실패
/// 격리). accept는 items의 suggested_*만 반영 — quadrant 자동 확정 0(INVARIANT #1). specta i64/u64 금지.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BatchEnrichProposal {
    pub items: Vec<BatchEnrichItem>,
    /// 형식/세트/존재 검증에서 제외된 카드 수(부분 실패 격리).
    pub skipped: u32,
}

/// CI triage 잡 입력 (PR Radar CI Blocked 카드에서 트리거). 재트리거는 retry_key로 캡된다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerCiTriageInput {
    pub project_id: Option<String>,
    pub repo_full_name: String,
    pub pr_number: u32,
    pub pr_url: String,
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

/// CI triage 산출 Proposal (codex draft). 원인 가설 + 수정안. accept는 로컬 기록만(외부 무변경).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CiTriageProposal {
    /// CI 실패 원인 가설.
    #[serde(default)]
    pub cause: String,
    /// 제안 수정안(체크리스트).
    #[serde(default)]
    pub suggested_fixes: Vec<String>,
    /// 사람이 읽을 요약.
    #[serde(default)]
    pub summary: String,
}

/// CI triage 트리거 결과. 재트리거 캡 초과면 잡을 만들지 않고(run_id=None) 매트릭스 Q1으로 escalate한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriageOutcome {
    /// 새 triage 잡 id (escalate된 경우 None).
    pub run_id: Option<String>,
    /// 캡 초과로 Q1 escalate됐는지.
    pub escalated: bool,
    /// 사람이 읽을 상세.
    pub detail: String,
}

// ── OKR 받아쓰기(자유 텍스트 → OKR 초안) — 제안 레일 + Acceptance 게이트 ──────────────
//
// codex는 초안(draft)만 낸다. 실제 mission/horizon/objective/KR 생성은 사람이 검토·편집 후
// "적용"을 클릭할 때만(accept_okr_import) — INVARIANT #1/#2와 동일한 게이트 모양.

/// OKR 받아쓰기 잡 입력. 자유 텍스트와 대상 분기, 강제 bounds(INVARIANT #5).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerOkrImportInput {
    pub text: String,
    pub quarter: String,
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

/// KR 초안. kind 닫힌 세트(KeyResultKind)로 구조 강제 — 세트 밖이면 항목 단위 skip.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrImportKeyResultDraft {
    pub title: String,
    pub kind: super::KeyResultKind,
    #[serde(default)]
    pub target_value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    /// milestone kind일 때 항목 라벨(적용 시 done=false로 생성).
    #[serde(default)]
    pub milestones: Vec<String>,
}

/// Objective 초안. linked_area_keys는 문자열로 관용(커스텀 Life Wheel 태그 허용) —
/// 프롬프트가 입력 태그 id 세트를 제시하고, 사람이 적용 전에 편집으로 최종 결정한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrImportObjectiveDraft {
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub linked_area_keys: Vec<String>,
    #[serde(default)]
    pub key_results: Vec<OkrImportKeyResultDraft>,
}

/// 장기 목표(horizon) 초안. kind 닫힌 세트(MissionHorizonKind).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrImportHorizonDraft {
    pub title: String,
    pub horizon_kind: super::MissionHorizonKind,
}

/// OKR 받아쓰기 초안 전체. skipped = 형식/세트 밖이라 항목 단위로 제외된 수(부분 실패 격리).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrImportDraft {
    pub mission: Option<String>,
    pub horizons: Vec<OkrImportHorizonDraft>,
    pub objectives: Vec<OkrImportObjectiveDraft>,
    pub skipped: u32,
}
