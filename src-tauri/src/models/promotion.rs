use serde::{Deserialize, Serialize};
use specta::Type;
// ── 승격(Promotion) ───────────────────────────────────────────────────────────

/// 승격 대상. notion_*/calendar = 외부(Acceptance 게이트), today = 로컬(즉시).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum PromotionTarget {
    NotionBacklog,
    NotionAgenda,
    Today,
    Calendar,
}

/// 승격 상태. 외부 승격은 draft에서 멈춘다 (실제 write는 Phase 3/11, INVARIANT #2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum PromotionStatus {
    Draft,
    Confirmed,
    Created,
    Failed,
}

/// append-only 승격 이력 (undo/audit). 외부 변경은 Acceptance 전엔 일어나지 않는다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Promotion {
    pub id: String,
    pub signal_id: String,
    pub target: PromotionTarget,
    pub status: PromotionStatus,
    pub draft_payload: String,
    pub created_external_id: Option<String>,
    pub created_at: String,
}

/// 승격(write) 시도 결과. status로 created / draft(오프라인 큐잉) / failed를 구분한다.
/// `page_url`은 성공 시 "Notion에서 열기" 딥링크용. 토큰 본문은 절대 담기지 않는다(INVARIANT).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromotionOutcome {
    pub promotion_id: String,
    pub status: PromotionStatus,
    pub page_url: Option<String>,
    /// 데스크톱 앱 딥링크(`notion://`). page_url에서 파생(스킴 교체). 호출부는 이걸 우선 열고
    /// 실패 시 page_url(https)로 폴백한다.
    pub page_deep_link: Option<String>,
    /// 사람이 읽을 상세(성공 식별 또는 실패 사유).
    pub detail: String,
    /// 실제 사용된 project_id (프런트의 자동 지정 라벨 표시용). 미변경이면 None.
    pub resolved_project_id: Option<String>,
}

/// 오프라인 복구 시 큐(draft) 재시도 집계. specta는 i64/u64 export 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FlushSummary {
    pub created: u32,
    pub queued: u32,
    pub failed: u32,
}
