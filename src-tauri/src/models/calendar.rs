use serde::{Deserialize, Serialize};
use specta::Type;
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
