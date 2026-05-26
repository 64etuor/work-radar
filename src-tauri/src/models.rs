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
    /// 포함할 Google Calendar 선택 목록 (JSON `[{id,summary}]`). Phase 10b. NULL/빈 목록이면 fetch 없음.
    /// INVARIANT #7: 선택 목록만 로컬 SSOT — 이벤트는 ambient(영속 없음), 토큰은 keychain.
    pub google_calendar_ids: Option<String>,
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
}

// ── 토큰 / 외부 ping (토큰 본문은 절대 이 타입들에 담기지 않는다) ────────────────

/// project별 분리되는 토큰 종류. keychain account 접미사로 쓰인다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Notion,
    Github,
    /// Google Calendar 자격증명 blob ({clientId, clientSecret, refreshToken}). Phase 10a.
    GoogleCalendar,
    /// Hermes 메신저 브리지 봇 토큰(Telegram Bot API류). 앱 레벨 단일 브리지(외부 Hermes 하나). Phase 20.
    HermesBridge,
}

impl TokenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenKind::Notion => "notion",
            TokenKind::Github => "github",
            TokenKind::GoogleCalendar => "google_calendar",
            TokenKind::HermesBridge => "hermes_bridge",
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

/// CLI 토큰 import 도구(gh/ntn) 가용성 (graceful degrade 판정용, Phase 14).
/// 토큰 본문은 절대 담기지 않는다(INVARIANT) — 설치/로그인 여부와 import 가능성만.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliToolStatus {
    /// CLI 바이너리가 PATH(또는 알려진 경로)에서 발견됨.
    pub installed: bool,
    /// 로그인/토큰 import 가능 (gh=`gh auth status`, ntn=auth 파일 존재). false면 로그인 필요.
    pub logged_in: bool,
    /// 사람이 읽을 상태 상세 (토큰 본문 미포함).
    pub detail: String,
}

/// 단일 잡 폴링용 경량 상태 (B3: EnrichModal 인플레이스 폴링).
/// status: 잡 상태(닫힌 enum), has_proposal: proposal 컬럼 비-NULL 여부, detail: 실패 메시지.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunStatus {
    pub status: AgentStatus,
    pub has_proposal: bool,
    pub detail: Option<String>,
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

// ── 루틴(Routine) ─────────────────────────────────────────────────────────────

/// 루틴 반복 주기.
/// - Daily: 매일.
/// - Weekly: 매주 선택 요일(weekdays).
/// - Biweekly: 격주 — 선택 요일 + anchor 기준 14일 parity(`(days_since_anchor / 7) % 2 == 0`).
/// - Monthly: 매월 같은 day-of-month(anchor의 일), 월말 클램프(31 → 그달 말일).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RoutineFreq {
    Daily,
    Weekly,
    Biweekly,
    Monthly,
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
    /// biweekly 2주 주기·monthly day-of-month 기준일 (YYYY-MM-DD). daily/weekly는 None.
    pub anchor_date: Option<String>,
    /// 알림 발사 기준 시각 'HH:MM'(로컬). None=알림 없음.
    pub time_of_day: Option<String>,
    /// 발사를 시각보다 N분 앞당김(예: 30=30분 전). None/0=정시. specta i64/u64 금지 → u32.
    pub reminder_offset_min: Option<u32>,
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
    /// weekly/biweekly일 때 해당 요일들. daily/monthly면 무시.
    pub weekdays: Vec<Weekday>,
    /// biweekly/monthly일 때 기준일(YYYY-MM-DD). 비면 백엔드가 오늘로 채운다. daily/weekly는 무시.
    pub anchor_date: Option<String>,
    /// 알림 시각 'HH:MM'(로컬). None=알림 없음.
    pub time_of_day: Option<String>,
    /// 알림 오프셋(분, N분 전). None/0=정시. specta i64/u64 금지 → u32.
    pub reminder_offset_min: Option<u32>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
}

/// 루틴 수정 입력.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRoutineInput {
    pub id: String,
    pub title: String,
    pub freq: RoutineFreq,
    /// weekly/biweekly일 때 해당 요일들. daily/monthly면 무시.
    pub weekdays: Vec<Weekday>,
    /// biweekly/monthly일 때 기준일(YYYY-MM-DD). 비면 기존 anchor 유지(없으면 오늘). daily/weekly는 무시.
    pub anchor_date: Option<String>,
    /// 알림 시각 'HH:MM'(로컬). None=알림 없음.
    pub time_of_day: Option<String>,
    /// 알림 오프셋(분, N분 전). None/0=정시. specta i64/u64 금지 → u32.
    pub reminder_offset_min: Option<u32>,
    pub area: Option<AreaTag>,
    pub kind: Option<Kind>,
}

/// 루틴 트래킹 한 항목 (Phase 16 #12). 루틴별 이행률(%)·연속(streak)·히스토리.
/// `routine_checks` + 스케줄 occurrence 집계 — 전부 로컬 read(자동화 아님). specta i64/u64 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTrackingItem {
    pub id: String,
    pub title: String,
    pub freq: RoutineFreq,
    /// 집계 기간 내 스케줄상 due occurrence 수.
    pub due: u32,
    /// due 날에 실제 체크된 수(done ⊆ due).
    pub done: u32,
    /// 이행률 = done*100/due (0..100). due=0이면 0.
    pub rate_pct: u32,
    /// 현재 연속(streak): 가장 최근 due 날짜부터 거꾸로 연속 체크된 occurrence 수.
    pub streak: u32,
    /// 히스토리 한 점들(오래된→최신). 히트맵/바 렌더용. 기간 내 due 날만.
    pub history: Vec<RoutineHistoryDay>,
}

/// 루틴 히스토리 한 날 (due occurrence + 체크 여부). 히트맵/바 한 칸.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RoutineHistoryDay {
    pub date: String,
    pub done: bool,
}

// ── Today 운영 뷰 + Work Debt (Phase 11a) ─────────────────────────────────────
//
// 전부 로컬 SQLite 집계 — 네트워크 없음(캘린더는 프런트가 fetchCalendarEvents로 별도 합성).
// INVARIANT #1: read 집계일 뿐 — 자동 분류/승격 없음. specta i64/u64 export 금지 → 카운트는 u32.

/// Work Debt 지표 (Today 콕핏 상단 스트립 + 일별 스냅샷 입력).
/// 임계치: q1_overdue = q1 생성 ≥ 1일, stale_backlog = 생성 ≥ 14일(today 레일 밖).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkDebt {
    /// quadrant=unclassified active (today 레일 밖) — "미분류 수".
    pub unclassified: u32,
    /// q1_do_now active & 생성 ≥ 1일 경과 (당일 처리 못 한 긴급).
    pub q1_overdue: u32,
    /// active & 생성 ≥ 14일 경과 (today 레일 밖) — 오래 멈춘 것.
    pub stale_backlog: u32,
    /// type=cleanup active — 정리 필요(머지 후 등).
    pub cleanup_needed: u32,
}

/// Today 운영 뷰 집계. 캘린더 오늘 이벤트·Today 레일·루틴은 프런트가 기존 헬퍼로 합성한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TodayOverview {
    pub work_debt: WorkDebt,
    /// 사람이 q1으로 분류했고 아직 Today 레일에 없는 활성 신호(콕핏에서 끌어올릴 대상).
    pub q1_items: Vec<WorkSignal>,
    /// 매트릭스로 escalate된 PR 신호(source=github_pr, type=pr_attention) — ambient PR이 임계치 넘은 것.
    pub pr_attention: Vec<WorkSignal>,
}

// ── Weekly review (Phase 11c, read 집계) ──────────────────────────────────────
//
// 지난 7일 집계. throughput/PR/루틴은 기존 타임스탬프에서 live 유도, debt_trend는
// debt_snapshots(11a부터 전진 누적)에서 읽는다. 전부 read — 외부 변경 없음. specta i64 금지 → u32.

/// 주간 처리량(지난 7일).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyThroughput {
    /// 캡처된 braindump 신호 수(created_at 로컬 기준).
    pub captured: u32,
    /// 완료한 Today 레일 항목 수(today_done_at 로컬 날짜 기준).
    pub completed: u32,
    /// accept된 외부 승격(Notion 등 status=created) 수.
    pub promoted: u32,
}

/// 주간 PR 활동. PR Radar는 ambient(머지 히스토리 미영속) → 근사:
/// `attention_new`=범위 내 새 PR-attention 신호, `resolved`=done 전이된 PR 신호(머지/CI해소 근사).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyPrActivity {
    pub attention_new: u32,
    pub resolved: u32,
}

/// 주간 루틴 이행률. due=스케줄상 해당 occurrence 수, done=실제 체크 수, rate_pct=done*100/due(0..100).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyRoutineAdherence {
    pub due: u32,
    pub done: u32,
    pub rate_pct: u32,
}

/// 부채 추세 한 점(일별 스냅샷). 11a부터 전진 누적 — 7일 미만이면 있는 만큼만.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DebtPoint {
    pub date: String,
    pub unclassified: u32,
    pub q1_overdue: u32,
    pub stale_backlog: u32,
    pub cleanup_needed: u32,
    pub pr_attention: u32,
}

/// Weekly review 집계(지난 7일, [start, end] 로컬 날짜 inclusive).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyReview {
    pub start: String,
    pub end: String,
    pub throughput: WeeklyThroughput,
    pub pr_activity: WeeklyPrActivity,
    pub routine_adherence: WeeklyRoutineAdherence,
    pub debt_trend: Vec<DebtPoint>,
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
    /// 수동 self-check 로컬 상태 (GitHub 아님).
    pub self_checked: bool,
    /// 경과일 (updated_at 기준, 0 = 오늘 갱신).
    pub age_days: u32,
    pub project_id: String,
    /// 댓글 수 (comments + review_comments). open PR만 채움, merged는 0.
    pub comment_count: u32,
    /// 댓글이 SUSPICIOUS_COMMENT_THRESHOLD 초과인지(시각 경고 힌트).
    pub is_suspicious: bool,
}

// ── Worktree & Branch Diff (Phase 5, read-only) ──────────────────────────────────
//
// 모두 ambient DTO다 — DB 영속 없이 매 호출마다 git에서 fresh 도출(PR Radar 선례).
// INVARIANT #6: read 서브커맨드만 — Diff Viewer는 워킹트리/브랜치를 절대 변경하지 않는다.
// specta는 i64/u64 export 금지 → 카운트는 u32.

/// worktree 동기화 상태 요약 (architecture §4). 우선순위:
/// Diverged(ahead&behind) > Dirty > Ahead > Behind > Clean. 수치는 ahead/behind로 별도 노출.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeStatus {
    Clean,
    Dirty,
    Ahead,
    Behind,
    Diverged,
}

/// repo별 git worktree (ambient — `git worktree list`로 매번 도출). 토큰 등 비밀 미포함.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// 안정 식별자 = `{repoId}:{path}` (ambient라 DB id 없음).
    pub id: String,
    pub repo_id: String,
    pub project_id: String,
    /// 표시 라벨 (remote owner/repo 또는 local_path basename).
    pub repo_label: String,
    /// worktree 파일시스템 경로.
    pub path: String,
    /// 현재 브랜치 (detached HEAD면 None).
    pub branch: Option<String>,
    /// HEAD sha.
    pub head: String,
    /// diff 비교 기본 기준 (repo.default_branch). vs_base 모드 기본값.
    pub base_branch: String,
    /// 현재 브랜치가 base_branch에 머지됐는지. detached/base/조회 실패는 None으로 둔다.
    pub merged_into_base: Option<bool>,
    /// base_branch에는 없고 현재 HEAD에만 있는 커밋 수(`git rev-list base...HEAD` right side).
    /// detached/조회 실패는 None.
    pub base_ahead: Option<u32>,
    /// 현재 HEAD에는 없고 base_branch에만 있는 커밋 수(`git rev-list base...HEAD` left side).
    /// detached/조회 실패는 None.
    pub base_behind: Option<u32>,
    /// 메인 워킹카피 여부 (`git worktree list` 첫 항목).
    pub is_primary: bool,
    pub status: WorktreeStatus,
    /// 미커밋 변경(추적 변경 + untracked) 존재 여부.
    pub dirty: bool,
    /// staged(index vs HEAD) 변경 파일 수. Worktree Review Cockpit이 staged-only 상태를 설명한다.
    pub staged_count: u32,
    /// unstaged(working tree vs index + untracked) 변경 파일 수.
    pub unstaged_count: u32,
    pub ahead: u32,
    pub behind: u32,
    /// worktree 안 가장 최근 파일 mtime(RFC3339). .git/target/node_modules 등은 제외. 없으면 None.
    pub newest_mtime: Option<String>,
    /// 최근(ACTIVE_CHANGE_WINDOW 이내) 파일 변경 = "지금 작업 중" 표시. 라이브 폴링으로 갱신.
    pub active_change: bool,
    /// 이 도출 시각(RFC3339) — ambient라 항상 now.
    pub last_fetched_at: String,
}

/// 안전 dev rebase 결과 (Phase 12c). 성공/충돌(abort+복구) 둘 다 terminal로 노출한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    /// rebase 성공 여부. false면 충돌로 abort + 백업 복구된 상태.
    pub success: bool,
    /// rebase 기준 ref (예: "origin/dev").
    pub base: String,
    /// 복구를 위해 만든 백업 ref (`refs/wr-backup/<branch>-<ts>`). dirty 거부 시엔 미생성(None).
    pub backup_ref: Option<String>,
    /// 사람이 읽을 결과/실패 요약(성공 통계 또는 충돌 사유).
    pub message: String,
}

/// 정리 후보 한 항목 (Phase 12d). merged 브랜치 / stale 브랜치 / prunable worktree.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CleanupKind {
    /// 기준 브랜치(base)에 이미 머지된 로컬 브랜치.
    MergedBranch,
    /// base에 미머지지만 오래된(stale) 로컬 브랜치 — 삭제는 force 필요.
    StaleBranch,
    /// 디스크에서 사라졌거나 prune 대상인 worktree 등록.
    PrunableWorktree,
}

/// 정리 후보 (Phase 12d). UI 다중 선택 + 보호 가드의 입력. 비밀 미포함.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    /// 안정 식별자 = `{kind}:{name}` (branch명 또는 worktree 경로).
    pub id: String,
    pub kind: CleanupKind,
    /// 브랜치명 또는 worktree 경로.
    pub name: String,
    /// 사람이 읽을 보조 설명(예: "dev에 머지됨", "현재 브랜치 — 보호됨").
    pub detail: String,
    /// 보호 대상(현재 브랜치/dirty worktree/미머지)이라 기본 삭제 불가. force여도 일부는 불가.
    pub protected: bool,
    /// 삭제 시 force 플래그 필요 여부(미머지 브랜치 = true).
    pub needs_force: bool,
}

/// diff 비교 모드 4종 (PLAN.md Phase 5). IPC 파라미터.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DiffMode {
    /// 미커밋 워킹트리 diff (워킹트리 vs index, unstaged).
    Working,
    /// index diff (staged, index vs HEAD).
    Staged,
    /// `git diff <base>...<head>` (3-dot, merge-base 기준).
    VsBase,
    /// 임의 두 ref 직접 비교 (`git diff <base> <head>`).
    BranchBranch,
}

/// diff 한 파일의 변경 종류. architecture DTO와 동일하게 단일 문자로 직렬화("M"/"A"/"D"/"R").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum FileChange {
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
}

/// diff 파일 목록 한 항목 (통계만 — 파일별 hunk는 지연 로드). specta i64/u64 금지 → adds/dels u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileSummary {
    pub path: String,
    pub status: FileChange,
    pub adds: u32,
    pub dels: u32,
    /// rename일 때 이전 경로 (표시용 "old → new").
    pub old_path: Option<String>,
    /// 바이너리 파일 (numstat이 '-'). adds/dels는 0.
    pub binary: bool,
}

/// base...HEAD 커밋 그래프 한 커밋의 방향. right=head 전용, left=base 전용.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CommitSide {
    Left,
    Right,
}

/// 커밋 그래프 drawer용 구조화 커밋. Git read-only log 출력에서 도출.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphEntry {
    pub side: CommitSide,
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    /// 짧은 hash 리스트(`git log %p`). 빈 벡터면 root 커밋. lane 토폴로지 계산용.
    pub parents: Vec<String>,
}

/// `git log --graph` 원문 라인 + 구조화 커밋 목록. 표시 전용(read-only).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraph {
    pub base: String,
    pub head: String,
    pub graph_lines: Vec<String>,
    pub commits: Vec<CommitGraphEntry>,
    pub truncated: bool,
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

// ── Phase 9: 추가 suggestion 자동화 (enrich / CI triage) ──────────────
//
// 모두 제안 레일 + Acceptance 게이트(Phase 8 PR self-check 패턴). codex 출력은 Proposal(draft)일 뿐,
// 사람이 accept해야 (로컬) 반영된다 — 외부(Notion/GitHub) 직접 mutate 없음(INVARIANT #2).
// INVARIANT #1: enrich는 quadrant를 자동 확정하지 않는다 — suggested_quadrant/suggested_area는 힌트.
// INVARIANT #5: CI triage 재트리거는 retry_key/retry_count로 캡되고 초과 시 Q1 escalate(사람).

/// braindump enrich 잡 입력 (미분류 카드 ⋯ 메뉴에서 트리거). 비-레포 잡(worktree 불요).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEnrichInput {
    pub signal_id: String,
    pub timeout_sec: u32,
    pub max_turns: u32,
    pub cost_cap_usd: f64,
}

/// enrich 산출 Proposal (codex draft). quadrant/area는 **힌트일 뿐** — accept해도 카드는
/// unclassified로 남고(INVARIANT #1), area는 사람이 별도로 확정한다. Quadrant/AreaTag로 타입해
/// **닫힌 세트를 구조적으로 강제**한다(세트 밖 값이면 파싱이 거부 → INVARIANT #1). serde default로 누락 관용.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnrichProposal {
    /// 제안 사분면 힌트(닫힌 enum). 자동 분류 아님.
    #[serde(default)]
    pub suggested_quadrant: Option<Quadrant>,
    /// 제안 라이프 도메인 힌트(닫힌 taxonomy). AI는 세트 밖을 만들지 못한다.
    #[serde(default)]
    pub suggested_area: Option<AreaTag>,
    /// 제안 근거(짧은 설명).
    #[serde(default)]
    pub reason: Option<String>,
}

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

// ── Phase 10: Google Calendar 연동 (read 레일) ────────────────────────────────────
//
// INVARIANT: 자격증명(clientId/clientSecret/refreshToken)은 keychain blob에만 — DTO/렌더러/반환에
// 절대 담기지 않는다. 외부 호출은 Rust(reqwest), read-only(`calendar.readonly`) → 외부 mutate 0 →
// Acceptance 불요(PR Radar read 선례). bounded·graceful degrade(#5). specta i64/u64 금지.

/// 프로젝트별 Google Calendar 연결 상태 (graceful degrade 판정용). 토큰 본문 미포함.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GoogleCalendarStatus {
    /// OAuth client(client_id/secret)이 입력됨 (연결 시도 가능).
    pub has_client: bool,
    /// refresh_token 보유 (OAuth 연결 완료 — 이벤트 fetch 가능).
    pub connected: bool,
    /// 사람이 읽을 상태 상세.
    pub detail: String,
}

/// calendarList 한 항목 (다중 선택 picker용). selected = 저장된 선택 목록에 포함됨. Phase 10b.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarListItem {
    pub id: String,
    pub summary: String,
    pub primary: bool,
    pub selected: bool,
}

/// 선택 캘린더 저장 입력 (id+summary). google_calendar_ids에 JSON `[{id,summary}]`로 영속.
/// summary를 함께 저장해 이벤트 fetch 시 calendarList 재조회 없이 calendar_summary를 채운다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectedCalendar {
    pub id: String,
    pub summary: String,
}

/// 오늘 캘린더 이벤트 한 건 (ambient — DB 영속 없이 매 호출 fresh fetch, PR Radar 선례). Phase 10b.
/// 토큰 본문 미포함(INVARIANT). start/end는 RFC3339(timed) 또는 YYYY-MM-DD(all-day). specta i64/u64 금지.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    /// 캘린더 표시 이름 (저장된 선택 목록 summary). 이벤트 제목과 별개.
    pub calendar_summary: String,
    pub title: String,
    /// timed = `start.dateTime`(RFC3339), all-day = `start.date`(YYYY-MM-DD).
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    /// 이벤트 딥링크 (`htmlLink`).
    pub url: Option<String>,
    pub project_id: String,
}

/// 카드 → 캘린더 이벤트 생성 입력 (직접 모달, Phase 19). 사용자 폼 = 사람 결정이라 Acceptance 게이트
/// 불요(#2 — 게이트는 자동화의 외부 mutate 차단용). 토큰/외부 ID 미포함. start/end는 RFC3339(timed)
/// 또는 YYYY-MM-DD(all-day). description은 선택. specta i64/u64 금지.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateCalendarEventInput {
    pub title: String,
    /// timed = RFC3339, all-day = YYYY-MM-DD.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub description: Option<String>,
}

/// 생성된 캘린더 이벤트 결과 (write 응답, Phase 19). id + 딥링크(htmlLink). 토큰 미포함.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCalendarEvent {
    pub id: String,
    pub url: Option<String>,
}

// ── Phase 20 #15: Hermes 메신저 브리지 (외부 Hermes를 Telegram Bot API류로 제어) ───────
//
// INVARIANT: 봇 토큰은 keychain(TokenKind::HermesBridge)만 — DTO/렌더러/DB 평문에 절대 안 담긴다.
// 비밀 아닌 chat_id·getUpdates offset은 로컬 SQLite(hermes_bridge) SSOT. #5: 수신은 bounded 단발
// getUpdates(무한 long-poll 금지). 외부 호출은 Rust(reqwest)·bounded retry·graceful degrade. specta
// i64/u64 금지(여기 카운트/플래그는 bool/u32) — update_id는 백엔드 내부에서만 쓰고 DTO엔 미노출.

/// Hermes 브리지 연결 상태(graceful degrade 판정용). 봇 토큰 본문은 절대 미포함(INVARIANT).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesBridgeStatus {
    /// 봇 토큰이 keychain에 있고 chat_id가 설정됨(송수신 가능).
    pub configured: bool,
    /// 설정된 chat_id(비밀 아님 — 라우팅 대상 표시용). 미설정이면 None.
    pub chat_id: Option<String>,
    /// 사람이 읽을 상태 상세(토큰 본문 미포함).
    pub detail: String,
}

/// 제어 surface(채팅형 뷰)에 표시할 메시지 한 건. 송신/수신 로그(hermes_messages)에서 도출.
/// 토큰 미포함. direction = "sent"|"received".
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct HermesMessage {
    pub id: String,
    /// "sent"(work-radar→Hermes) | "received"(Hermes→work-radar).
    pub direction: String,
    pub text: String,
    pub created_at: String,
}

/// fetch_hermes_messages 결과(bounded 단발 getUpdates). 이번 호출에서 새로 받은 메시지 수.
/// 메시지 본문은 별도 list_hermes_messages로 조회(제어 surface). specta i64/u64 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesFetchResult {
    /// 이번 bounded 호출에서 새로 수신·기록한 메시지 수.
    pub received: u32,
}

/// detect_hermes_chat_id 결과. getUpdates에서 감지된 실 사용자 chat.
/// 봇 토큰 본문은 절대 미포함(INVARIANT) — chat_id + 라벨만 노출한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedChat {
    /// 감지된 chat.id (숫자 → 문자열).
    pub chat_id: String,
    /// 사람이 읽을 라벨(채팅 이름/username/first_name 폴백).
    pub label: String,
}

// ── 스킬 공유 레지스트리 (Phase 20 #21) ─────────────────────────────────────────────
//
// 인앱 에이전트 프롬프트(편집 가능 잡 템플릿)와 외부 Claude/Codex 스킬(~/.claude/skills)을 한
// 레지스트리에서 본다. INVARIANT #1/#2: 프롬프트 편집은 codex 제안 *내용*만 바꾼다 — 잡은 여전히
// 제안 레일 + Acceptance 게이트를 거치고 accept는 suggested_*/proposal만 쓴다(스킬 자동 실행 없음).

/// 레지스트리 한 행. kind="in_app_prompt"면 prompt/binding이 의미 있고(편집 가능 잡 템플릿),
/// kind="external"이면 source_path/prompt(=디스크에서 읽은 description)가 의미 있다(읽기 전용 브라우즈).
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    /// "in_app_prompt" | "external".
    pub kind: String,
    /// in_app_prompt: 편집 가능 템플릿. external: 디스크 description(스캔 시 채움).
    pub prompt: Option<String>,
    /// in_app_prompt: 잡 키(enrich/batch_enrich/ci_triage/pr_selfcheck). external: None.
    pub binding: Option<String>,
    /// 표시용 레일(suggestion). 결정 레일 침범 없음(메타).
    pub rail: Option<String>,
    /// 비활성이면 잡 lookup이 코드 상수로 폴백한다(기본 동작 보존).
    pub enabled: bool,
    /// external: SKILL.md 디렉터리/파일 경로. in_app: None.
    pub source_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 외부 스킬 스캔 결과 한 건(~/.claude/skills/<dir>/SKILL.md frontmatter). 디스크가 SSOT이므로
/// DB에 영속하지 않고 매 스캔마다 읽는다(읽기 전용 브라우즈 + 선택적 내용 열람).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSkill {
    /// frontmatter name(없으면 디렉터리명).
    pub name: String,
    /// frontmatter description(없으면 빈 문자열).
    pub description: String,
    /// SKILL.md 파일 절대 경로(내용 열람·편집 대상).
    pub path: String,
}

/// 인앱 프롬프트 생성 입력(레지스트리에 새 편집 가능 템플릿 추가). binding은 선택(미바인딩 템플릿도 가능).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillInput {
    pub name: String,
    pub prompt: String,
    /// 잡 키(enrich/batch_enrich/ci_triage/pr_selfcheck) 또는 None(미바인딩).
    pub binding: Option<String>,
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
