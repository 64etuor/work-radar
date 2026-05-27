use serde::{Deserialize, Serialize};
use specta::Type;
// ── 신호(WorkSignal) ──────────────────────────────────────────────────────────

/// 개인/업무 힌트. 입력 맨앞 토큰 마커 > 세그먼트 토글 > 기본 업무.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Kind {
    Personal,
    Work,
}

/// 라이프 도메인 (닫힌 taxonomy = Wheel of Life + other). AI는 세트 밖을 만들지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum AreaTag {
    Health,
    Work,
    Studies,
    Environment,
    Recreation,
    Romance,
    Family,
    Friends,
    Finances,
    Other,
}

/// 사람이 편집하는 Life Wheel 팔레트 항목. AI 제안 taxonomy(`AreaTag`)와 별개로,
/// 수동 태그 선택 UI만 확장한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LifeWheelTagConfig {
    pub id: String,
    pub label: String,
    pub color: String,
    pub built_in: bool,
    pub enabled: bool,
}

/// 신호 출처.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum SignalSource {
    Braindump,
    NotionBacklog,
    NotionAgenda,
    GithubPr,
    Calendar,
    Hermes,
    System,
}

/// 신호 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum SignalType {
    Thought,
    TaskCandidate,
    DecisionCandidate,
    PrAttention,
    AgentAlert,
    MeetingPrep,
    Stale,
    Cleanup,
}

/// 아이젠하워 사분면 (사람 결정값). 카드는 항상 `Unclassified`로 진입한다 (INVARIANT #1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Quadrant {
    Q1DoNow,
    Q2Schedule,
    Q3QuickContain,
    Q4Drop,
    Unclassified,
}

/// 신호 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum SignalStatus {
    New,
    Classified,
    Promoted,
    Linked,
    Done,
    Snoozed,
    Archived,
}

/// 매트릭스 카드/Today 항목. 로컬 SQLite가 SSOT (INVARIANT #7).
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct WorkSignal {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub body: Option<String>,
    pub source: SignalSource,
    #[sqlx(rename = "type")]
    #[serde(rename = "type")]
    pub signal_type: SignalType,
    /// 사람 결정값. 자동 분류 없음 (INVARIANT #1).
    pub quadrant: Quadrant,
    /// 파생 힌트 (truth 아님). Phase 1은 항상 NULL.
    pub suggested_quadrant: Option<String>,
    pub kind: Option<Kind>,
    /// 사람 확정 라이프 도메인. Phase 1은 데이터 필드만.
    pub area: Option<AreaTag>,
    /// 사람 확정 라이프 도메인 multi-select(JSON array). `area`는 primary tag로 유지한다.
    pub area_tags: Option<String>,
    /// AI 추론 힌트. Phase 9 enrich에서 채워짐.
    pub suggested_area: Option<AreaTag>,
    pub status: SignalStatus,
    pub snooze_until: Option<String>,
    /// Today로 옮긴 날(YYYY-MM-DD). NULL = Today 아님(매트릭스/미분류).
    pub today_for_date: Option<String>,
    /// Today 완료 체크한 날(YYYY-MM-DD).
    pub today_done_at: Option<String>,
    pub today_rank: Option<i32>,
    /// 회고 태그: 고임팩트(사람 태깅, Phase 17). NULL/false=미태깅, true=고임팩트 ⭐. INVARIANT #1.
    pub impact_high: Option<bool>,
    /// 회고 태그: 하지말걸(사람 태깅, Phase 17). NULL/false=미태깅, true=후회 ⚠️. INVARIANT #1.
    pub regret: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
}

/// 신호 생성 입력. 카드는 항상 unclassified로 만들어진다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSignalInput {
    pub title: String,
    /// 개인/업무 힌트 (없으면 NULL). 결정 레일 아님.
    pub kind: Option<Kind>,
    /// 소속 프로젝트(없으면 NULL → 나중에 reconcile). 메타데이터(결정 레일 아님).
    pub project_id: Option<String>,
}
