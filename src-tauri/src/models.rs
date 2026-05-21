//! 도메인 타입. serde(camelCase)로 프런트에 노출되고 specta로 TS 타입이 생성된다.
//! INVARIANT: 토큰 같은 비밀은 절대 이 타입들에 담기지 않는다 (keychain 참조만).
//! INVARIANT: `quadrant`(사람 결정) vs `suggested_quadrant`/`suggested_area`(파생 힌트) 분리.

use serde::{Deserialize, Serialize};
use specta::Type;

/// 프로젝트 종류. 개인/업무는 별도 토큰·Notion 워크스페이스로 분리된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ProjectKind {
    Personal,
    Work,
}

/// 최상위 그룹. `credential_ref`는 keychain 키일 뿐, 토큰 평문이 아니다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub kind: ProjectKind,
    pub notion_backlog_db_id: Option<String>,
    pub notion_agenda_db_id: Option<String>,
    pub ticket_key_pattern: Option<String>,
    pub credential_ref: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 프로젝트 생성 입력. credential_ref는 백엔드가 생성한다(프런트가 정하지 않음).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    pub name: String,
    pub kind: ProjectKind,
    pub notion_backlog_db_id: Option<String>,
    pub notion_agenda_db_id: Option<String>,
    pub ticket_key_pattern: Option<String>,
}

// ── 레포(Repo) ────────────────────────────────────────────────────────────────

/// 레포 제공자. github = remote_url, local = local_path(Codex worktree 베이스).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum Provider {
    Github,
    Local,
}

/// project별 레포. PR Radar(Phase 4)·worktree(Phase 5)의 단위.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: String,
    pub project_id: String,
    pub provider: Provider,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    pub default_branch: String,
    pub ticket_key_pattern: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

/// 레포 추가 입력.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateRepoInput {
    pub project_id: String,
    pub provider: Provider,
    pub remote_url: Option<String>,
    pub local_path: Option<String>,
    /// 기본 브랜치. 비면 'main'.
    pub default_branch: Option<String>,
    pub ticket_key_pattern: Option<String>,
}

// ── 토큰 / 외부 ping (토큰 본문은 절대 이 타입들에 담기지 않는다) ────────────────

/// project별 분리되는 토큰 종류. keychain account 접미사로 쓰인다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Notion,
    Github,
}

impl TokenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenKind::Notion => "notion",
            TokenKind::Github => "github",
        }
    }
}

/// 토큰 존재 여부만 노출 (본문 미노출 — INVARIANT: 토큰 렌더러 노출 금지).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub has_notion: bool,
    pub has_github: bool,
}

/// 외부 API ping 결과 (read-only). 토큰 본문은 포함하지 않는다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub ok: bool,
    /// 성공 시 식별 정보(예: GitHub login, Notion bot 이름), 실패 시 에러 메시지.
    pub detail: String,
}

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
    Mismatch,
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
    /// AI 추론 힌트. Phase 9 enrich에서 채워짐.
    pub suggested_area: Option<AreaTag>,
    pub status: SignalStatus,
    pub snooze_until: Option<String>,
    /// Today로 옮긴 날(YYYY-MM-DD). NULL = Today 아님(매트릭스/미분류).
    pub today_for_date: Option<String>,
    /// Today 완료 체크한 날(YYYY-MM-DD).
    pub today_done_at: Option<String>,
    pub today_rank: Option<i32>,
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
    /// 사람이 읽을 상세(성공 식별 또는 실패 사유).
    pub detail: String,
}

/// 오프라인 복구 시 큐(draft) 재시도 집계. specta는 i64/u64 export 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FlushSummary {
    pub created: u32,
    pub queued: u32,
    pub failed: u32,
}

// ── 루틴(Routine) ─────────────────────────────────────────────────────────────

/// 루틴 반복 주기.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RoutineFreq {
    Daily,
    Weekly,
}

/// 요일 (weekly 루틴 스케줄 + 오늘 매칭용).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

/// 오늘 표시할 루틴 항목 (스케줄 매칭 + 날짜별 완료 상태 포함).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineToday {
    pub id: String,
    pub title: String,
    pub freq: RoutineFreq,
    pub weekdays: Vec<Weekday>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
    /// 주어진 날짜에 완료 체크됐는지 (RoutineCheck 존재 여부).
    pub done: bool,
}

/// 루틴 생성 입력.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoutineInput {
    pub title: String,
    pub freq: RoutineFreq,
    /// weekly일 때 해당 요일들. daily면 무시.
    pub weekdays: Vec<Weekday>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
}

// ── PR Radar (Phase 4, read 레일) ─────────────────────────────────────────────

/// PR의 CI 상태 (check-runs conclusion 집계). `None` = 체크 없음.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CiStatus {
    Passing,
    Failing,
    Pending,
    None,
}

/// readiness 버킷 (PR Radar 자기 뷰의 분류 — 매트릭스 결정 레일과 별개, INVARIANT #4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessBucket {
    NeedsSelfCheck,
    CiBlocked,
    Ready,
    MergedCleanup,
    Stale,
}

/// PR Radar 한 항목 (프런트 표시용). ambient 상태라 매 폴링마다 GitHub에서 새로 도출된다.
/// 토큰 본문은 절대 담기지 않는다(INVARIANT). specta i64/u64 export 금지 → number/ageDays는 u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PrRadarItem {
    pub repo_full_name: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    pub author_login: String,
    pub bucket: ReadinessBucket,
    pub ci: CiStatus,
    pub has_conflict: bool,
    pub is_draft: bool,
    /// ticketKeyPattern으로 PR title/branch에서 추출한 링크 백로그 티켓 (없으면 None).
    pub linked_ticket: Option<String>,
    /// 수동 self-check 로컬 상태 (GitHub 아님).
    pub self_checked: bool,
    /// 경과일 (updated_at 기준, 0 = 오늘 갱신).
    pub age_days: u32,
    /// 이 PR이 매트릭스로 escalate된 active 신호를 갖는지 (임계치 초과 — INVARIANT #4).
    pub escalated: bool,
    pub project_id: String,
}
