//! Google Calendar 연동 클라이언트 (read 레일 Phase 10 + write/이벤트 생성 Phase 19).
//! INVARIANT: 외부 호출은 Rust(reqwest)에, 자격증명(client_id/secret/refresh_token)은 keychain blob에서만
//! 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//! 스코프는 `calendar`(full read+write, calendarList + events 모두 커버).
//! 기존 `calendar.events` 또는 `calendar.readonly` 토큰은 이 스코프 동의가 없어 calendarList.list 시
//! 403이 발생함 → 재동의(다시 연결)로 갱신. 재연결 신호는 `CalendarError::ReconnectRequired`로 노출.
//! write는 **사용자 폼 제출 = 사람 결정**이라 Acceptance 게이트 불요(게이트는 자동화/Codex의 외부 mutate
//! 차단용 — INVARIANT #2). 외부 호출은 bounded retry + graceful terminal failure.
//!
//! 모듈 레이아웃:
//!  - `oauth`   PKCE/auth_url/redirect 파싱 · CalendarCreds blob · TokenResponse · connect/refresh_core
//!  - `loopback` RFC 8252 loopback redirect 수신기 + LOOPBACK_TIMEOUT
//!  - `parse`   calendarList/events 응답 파싱 + Raw 타입 + CalendarEvent 정렬
//!  - `windows` 오늘/임의 범위 RFC3339 윈도우(순수 — 오프셋은 주입)
//!  - `http`    실 HTTP provider(reqwest) + 에러 분류 + path segment percent-encoding
//!  - `write`   이벤트 생성 입력(CreateEventInput) + 페이로드 빌더 + 응답 파싱
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): `with_retry`(github.rs/notion.rs와 동일 패턴) + reqwest timeout +
//!    loopback timeout. 무한 retry/poll 금지.
//!  - OAuth = Auth Code + PKCE(S256) + loopback redirect(RFC 8252 installed-app). client는 사용자 제공.
//!  - 테스트 가능 seam: 순수 함수 + `CalendarProvider` 트레잇 fake로 connect/refresh/fetch 오케스트레이션을
//!    cargo test. 실 OAuth loopback·실 Google fetch·keychain 영속은 사용자 관찰.
//!
//! calendar는 자체 `CalendarError`를 소유한다(notion/github와 비공유) — Google OAuth/Calendar는
//! 자체 토큰 엔드포인트·refresh 흐름·재시도 관심사를 가지므로 모듈별로 분리(선례: github≠notion).

mod http;
mod loopback;
mod oauth;
mod parse;
pub mod pending_store;
pub mod sync;
pub mod timing;
mod windows;
mod write;

use crate::models::CalendarEvent;
use crate::retry::Retryable;

pub use http::HttpCalendarProvider;
pub use loopback::{Loopback, LOOPBACK_TIMEOUT};
// 원본 calendar.rs에서 `pub`였던 항목은 전부 보존(슬라이스 분리 후 외부에서 직접 쓰지 않는
// 순수 헬퍼·파서·page-내부 도구도 surface로 두는 게 분리 PR의 계약). 일부는 현 crate 내부에서
// 안 쓰여 unused 경고가 나는데, 의도적 보존이므로 allow.
#[allow(unused_imports)]
pub use oauth::{
    auth_url, connect_core, gen_code_verifier, gen_state, merge_refresh, parse_redirect_query,
    parse_token_response, pkce_challenge, refresh_core, CalendarCreds, TokenResponse,
};
#[allow(unused_imports)]
pub use parse::{
    merge_sort_events, parse_calendar_event, parse_calendar_list, RawCalendar, RawEvent,
};
pub use windows::{range_window, today_window};
#[allow(unused_imports)]
pub use write::{build_event_payload, parse_created_event, CreateEventInput};
// External Action Gate(Phase 4) dispatch — commands::external_actions 라우터가 호출.
pub(crate) use write::execute_calendar_action;

// ── CalendarError ─────────────────────────────────────────────────────────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
/// ReconnectRequired = 스코프 불일치로 재연결이 필요한 경우(calendarList 403).
/// NotFound = 대상 이벤트가 Google에서 사라짐(404/410, stale mirror). 재시도 무의미 →
/// 호출자가 로컬 mirror를 NULL로 sweep하는 reactive 경로(ADR-0005). DELETE는 멱등 Ok로
/// 흡수하지만 PATCH는 진행 불가라 이 변형으로 노출한다.
#[derive(Debug, Clone, thiserror::Error)]
pub enum CalendarError {
    #[error("{0}")]
    Transient(String),
    #[error("{0}")]
    Terminal(String),
    #[error("{0}")]
    ReconnectRequired(String),
    #[error("{0}")]
    NotFound(String),
}

impl Retryable for CalendarError {
    fn is_retryable(&self) -> bool {
        matches!(self, CalendarError::Transient(_))
    }
}

// ── 트레잇 seam (RPITIT, PrProvider/NotionReader 패턴) ────────────────────────────

/// OAuth 토큰 교환/갱신 + 캘린더/이벤트 read 계약 + 이벤트 생성(write, Phase 19). 오케스트레이션
/// (connect/refresh/fetch/create)은 이 트레잇에만 의존 → fake로 cargo test. 실 HTTP는 HttpCalendarProvider.
pub trait CalendarProvider {
    /// authorization code → 토큰(첫 동의: refresh_token 포함). PKCE verifier·redirect_uri 동봉.
    fn exchange_code(
        &self,
        creds: &CalendarCreds,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> impl std::future::Future<Output = Result<TokenResponse, CalendarError>> + Send;

    /// refresh_token → 새 access_token(만료 재발급). refresh_token은 응답에 없을 수 있다.
    fn refresh_access(
        &self,
        creds: &CalendarCreds,
    ) -> impl std::future::Future<Output = Result<TokenResponse, CalendarError>> + Send;

    /// 사용자 calendarList(포함 캘린더 다중 선택용). bounded retry.
    fn list_calendars(
        &self,
        access_token: &str,
    ) -> impl std::future::Future<Output = Result<Vec<RawCalendar>, CalendarError>> + Send;

    /// 한 캘린더의 [time_min, time_max] 이벤트(singleEvents 전개·시작순). bounded.
    fn fetch_events(
        &self,
        access_token: &str,
        calendar_id: &str,
        time_min: &str,
        time_max: &str,
    ) -> impl std::future::Future<Output = Result<Vec<RawEvent>, CalendarError>> + Send;

    /// 한 캘린더에 이벤트 생성(write, Phase 19). 반환: (생성된 이벤트 id, htmlLink). bounded retry.
    /// 사용자 폼 제출 = 사람 결정이라 Acceptance 게이트 불요(#2). 실패는 graceful terminal로 노출.
    fn create_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        input: &CreateEventInput,
    ) -> impl std::future::Future<Output = Result<(String, Option<String>), CalendarError>> + Send;

    /// 이벤트 생성 — **단일 시도(재시도 없음)**. External Action Gate(AI-origin, Phase 4) 전용.
    /// events.insert는 멱등하지 않다 — 요청이 Google에 도달한 뒤 응답만 유실되면(transport drop=
    /// transient) `create_event`의 bounded retry가 **중복 이벤트**를 만든다. 게이트 idempotency_key는
    /// *제안* dedup이지 API 콜 dedup이 아니다(github WRITE_MAX_ATTEMPTS=1 선례). 그래서 gate write는
    /// 재시도 대신 실패를 노출해 사용자가 재제안하게 한다. 사람-폼 경로는 `create_event` 그대로(무변경).
    ///
    /// 기본 구현은 `create_event`로 위임한다 — **실 HTTP provider(HttpCalendarProvider)는 단일-시도
    /// POST로 override**해야 한다(중복 write 방지). 기본 위임은 retry가 무의미한 테스트 fake 전용이다.
    fn create_event_once(
        &self,
        access_token: &str,
        calendar_id: &str,
        input: &CreateEventInput,
    ) -> impl std::future::Future<Output = Result<(String, Option<String>), CalendarError>> + Send
    {
        self.create_event(access_token, calendar_id, input)
    }

    /// 기존 이벤트 부분 갱신(Today×Timeline PR 2). patch 페이로드는 시작/지속시간/제목 등 변경분만.
    /// bounded retry. 사용자 폼/타임라인 드래그 = 사람 결정 — Acceptance 게이트 불요(#2).
    fn patch_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
        patch: &serde_json::Value,
    ) -> impl std::future::Future<Output = Result<(), CalendarError>> + Send;

    /// 이벤트 삭제(Today×Timeline PR 2). 카드 unschedule → mirror 정리. bounded retry.
    fn delete_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> impl std::future::Future<Output = Result<(), CalendarError>> + Send;
}

// ── 한 프로젝트의 fetch 컨텍스트 + 다중 프로젝트 병합 코어 ──────────────────────────

/// 한 프로젝트의 fetch 컨텍스트(access token + 선택 캘린더 [(id, summary)]).
pub struct ProjectCalendars {
    pub project_id: String,
    pub project_color: String,
    pub project_text_color: String,
    pub access_token: String,
    pub calendars: Vec<(String, String)>,
}

/// 여러 프로젝트의 선택 캘린더 오늘 이벤트를 시간순 병합. 캘린더별 실패는 격리(건너뜀 — 부분 실패).
/// 프로젝트별 실패(토큰/refresh)는 호출자가 ctx를 만들 때 격리한다. 트레잇 의존 → fake로 cargo test.
pub async fn fetch_events_core<P: CalendarProvider>(
    provider: &P,
    projects: Vec<ProjectCalendars>,
    time_min: &str,
    time_max: &str,
) -> Vec<CalendarEvent> {
    let mut out: Vec<CalendarEvent> = Vec::new();
    for proj in projects {
        for (cal_id, cal_summary) in &proj.calendars {
            // 부분 실패 격리: 한 캘린더 fetch 실패는 건너뛰고 나머지는 계속.
            let Ok(raws) = provider
                .fetch_events(&proj.access_token, cal_id, time_min, time_max)
                .await
            else {
                continue;
            };
            for r in raws {
                let all_day = r.all_day;
                out.push(CalendarEvent {
                    id: r.id,
                    recurring_event_id: r.recurring_event_id,
                    calendar_id: cal_id.clone(),
                    calendar_summary: cal_summary.clone(),
                    title: r.title,
                    start: if all_day {
                        r.start
                    } else {
                        normalize_timed_to_local(&r.start)
                    },
                    end: if all_day {
                        r.end
                    } else {
                        normalize_timed_to_local(&r.end)
                    },
                    all_day,
                    location: r.location,
                    url: r.url,
                    project_id: proj.project_id.clone(),
                    project_color: proj.project_color.clone(),
                    project_text_color: proj.project_text_color.clone(),
                });
            }
        }
    }
    merge_sort_events(out)
}

/// 타임드 RFC3339(어떤 오프셋/`Z`든)을 뷰어 로컬 존(OS 로컬 SSOT `crate::timezone`, per-instant
/// DST 정확)으로 정규화해 `YYYY-MM-DDTHH:MM:SS±HH:MM`(소수초 없음·`Z` 없음)로 반환한다. 프런트의
/// 고정 위치 슬라이스(`iso.slice(11,16)`)와 `new Date()`가 동일 wall-clock을 읽도록 만든다(스펙 §3.2).
/// 파싱 불가 입력은 그대로 반환(이벤트 유실/패닉 금지). 종일 이벤트는 호출부가 `all_day`로 분기.
/// (`to_rfc3339_opts`는 내부에서 offset을 `fix()`하므로 Tz 약어("KST")가 새지 않는다.)
pub(crate) fn normalize_timed_to_local(s: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(s) {
        Ok(dt) => dt
            .with_timezone(&crate::timezone::user_timezone())
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
        Err(_) => s.to_string(),
    }
}

// 트레잇 seam cross-slice 통합 테스트(connect/refresh/fetch_events_core)는 별도 파일로 분리.
#[cfg(test)]
mod tests;
