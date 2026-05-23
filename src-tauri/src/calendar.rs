//! Google Calendar 연동 클라이언트 (read 레일 Phase 10 + write/이벤트 생성 Phase 19).
//! INVARIANT: 외부 호출은 Rust(reqwest)에, 자격증명(client_id/secret/refresh_token)은 keychain blob에서만
//! 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//! 스코프는 `calendar`(full read+write, calendarList + events 모두 커버).
//! 기존 `calendar.events` 또는 `calendar.readonly` 토큰은 이 스코프 동의가 없어 calendarList.list 시
//! 403이 발생함 → 재동의(다시 연결)로 갱신. 재연결 신호는 `CalendarError::ReconnectRequired`로 노출.
//! write는 **사용자 폼 제출 = 사람 결정**이라 Acceptance 게이트 불요(게이트는 자동화/Codex의 외부 mutate
//! 차단용 — INVARIANT #2). 외부 호출은 bounded retry + graceful terminal failure.
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): `with_retry`(github.rs/notion.rs와 동일 패턴) + reqwest timeout +
//!    loopback timeout. 무한 retry/poll 금지.
//!  - OAuth = Auth Code + PKCE(S256) + loopback redirect(RFC 8252 installed-app). client는 사용자 제공.
//!  - 테스트 가능 seam: 순수 함수(PKCE/auth_url/redirect 파싱/토큰 응답 파싱/blob 병합) + `CalendarProvider`
//!    트레잇 fake로 connect/refresh 오케스트레이션을 cargo test. 실 OAuth loopback·실 Google fetch·keychain
//!    영속은 사용자 관찰(실 네트워크/브라우저 없음 — Notion/GitHub/codex 선례).
//!
//! calendar.rs는 자체 `CalendarError`를 소유한다(notion/github와 비공유) — Google OAuth/Calendar는
//! 자체 토큰 엔드포인트·refresh 흐름·재시도 관심사를 가지므로 모듈별로 분리(선례: github≠notion).

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::CalendarEvent;
use crate::retry::{with_retry, Retryable};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// 한 토큰 교환/갱신 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// loopback redirect 대기 상한(bounded — 무한 대기 금지). 사용자 동의 시간 포함.
pub const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(180);

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
/// full read+write 스코프 (calendarList + events 모두 커버). 기존 `calendar.events` 또는
/// `calendar.readonly` 토큰은 calendarList.list를 허용하지 않아 403이 발생하므로 재연결 필요.
/// write는 사용자 폼 제출(사람 결정)이라 Acceptance 게이트 불요 — 게이트는 자동화의 외부 mutate 차단용(#2).
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar";
const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3/calendars";
/// events 조회 상한(bounded — 무한 페이지네이션 금지). 오늘 윈도우라 단발로 충분.
const EVENTS_MAX_RESULTS: &str = "50";

/// loopback에 redirect 도착 시 사용자 브라우저에 보여줄 최소 HTML(200).
const SUCCESS_HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: 96\r\n\r\n<html><body style=\"font-family:sans-serif\"><h3>연결되었습니다.</h3><p>이 창을 닫아도 됩니다.</p></body></html>";
/// code 없는 잡음 요청(favicon 등)에 대한 최소 200.
const WAIT_HTML: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 7\r\n\r\nwaiting";

// ── 에러 분류 + bounded retry (github.rs/notion.rs와 동일 패턴) ─────────────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
/// ReconnectRequired = 스코프 불일치로 재연결이 필요한 경우(calendarList 403).
#[derive(Debug, Clone, thiserror::Error)]
pub enum CalendarError {
    #[error("{0}")]
    Transient(String),
    #[error("{0}")]
    Terminal(String),
    #[error("{0}")]
    ReconnectRequired(String),
}

impl Retryable for CalendarError {
    fn is_retryable(&self) -> bool {
        matches!(self, CalendarError::Transient(_))
    }
}

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
fn classify_http(status: u16, body: &str) -> CalendarError {
    // 외부 응답 본문은 사용자 콘텐츠/PII 가능 → 메시지·로그에 내용을 넣지 않는다(스펙 §5.5). 크기만 노출.
    let body_len = body.len();
    if status == 429 || status >= 500 {
        CalendarError::Transient(format!("HTTP {status} (응답 {body_len}B)"))
    } else {
        CalendarError::Terminal(format!("HTTP {status} (응답 {body_len}B)"))
    }
}

/// reqwest 전송 에러 → 분류. 네트워크/타임아웃은 일시적, 디코드 실패는 영구.
fn classify_reqwest(e: &reqwest::Error) -> CalendarError {
    if e.is_decode() {
        CalendarError::Terminal(format!("decode error: {e}"))
    } else {
        CalendarError::Transient(e.to_string())
    }
}

// ── 자격증명 blob (keychain 전용 — 절대 DTO/렌더러로 나가지 않는다) ──────────────────

/// keychain blob `{credential_ref}:google_calendar`의 내용. INVARIANT: DTO/반환/캐시 어디에도 안 나간다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCreds {
    pub client_id: String,
    pub client_secret: String,
    /// OAuth 연결 완료 시 저장. refresh 시 응답에 없으면 기존 유지(merge_refresh).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl CalendarCreds {
    /// keychain JSON 문자열 → creds. 깨진 JSON은 Terminal(자동 재시도 무의미).
    pub fn from_blob(s: &str) -> Result<Self, CalendarError> {
        serde_json::from_str(s)
            .map_err(|e| CalendarError::Terminal(format!("creds blob 파싱: {e}")))
    }

    /// creds → keychain JSON 문자열.
    pub fn to_blob(&self) -> String {
        serde_json::to_string(self).expect("CalendarCreds serialize")
    }

    /// refresh_token 보유 여부(연결 완료 판정).
    pub fn has_refresh(&self) -> bool {
        self.refresh_token.as_deref().is_some_and(|t| !t.is_empty())
    }
}

/// 토큰 응답의 refresh_token을 기존 creds에 병합한다. 응답에 없으면(refresh 시 흔함) 기존 유지. 순수.
pub fn merge_refresh(mut creds: CalendarCreds, resp: &TokenResponse) -> CalendarCreds {
    if let Some(rt) = resp.refresh_token.as_deref() {
        if !rt.is_empty() {
            creds.refresh_token = Some(rt.to_string());
        }
    }
    creds
}

// ── 순수 OAuth 헬퍼 (단위 테스트 대상) ─────────────────────────────────────────────

/// PKCE code_verifier: CSPRNG 32바이트 → base64url(no pad) = 43자(43~128 unreserved 범위).
pub fn gen_code_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("CSPRNG code_verifier");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE S256 challenge = base64url(no pad, SHA-256(verifier)). 순수 — RFC 7636 테스트 벡터로 검증.
pub fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
}

/// CSRF state: CSPRNG 16바이트 → base64url(no pad).
pub fn gen_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("CSPRNG state");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// authorization URL 조립(파라미터 percent-encoding은 reqwest::Url가 처리). 순수.
pub fn auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(AUTH_ENDPOINT).expect("valid auth endpoint");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", CALENDAR_SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", state);
    url.to_string()
}

/// loopback GET 요청 첫 줄("GET /?code=..&state=.. HTTP/1.1")에서 (code, state)를 뽑는다. 순수.
/// code 또는 state가 없으면(잡음 요청·OAuth error) None — 호출자가 state 일치까지 검증한다.
pub fn parse_redirect_query(request_line: &str) -> Option<(String, String)> {
    let path = request_line.split_whitespace().nth(1)?;
    // 상대 path를 절대 URL로 감싸 query_pairs로 안전하게 percent-decode.
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
    let mut code = None;
    let mut state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    Some((code?, state?))
}

/// Google 토큰 엔드포인트 응답(access_token/refresh_token/expires_in).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenResponse {
    pub access_token: String,
    /// 첫 동의 시 발급, refresh 응답엔 보통 없음.
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

/// 토큰 응답 JSON → TokenResponse. access_token 누락은 Terminal(재시도 무의미). 순수.
pub fn parse_token_response(body: &serde_json::Value) -> Result<TokenResponse, CalendarError> {
    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        // 응답 본문(OAuth 토큰 응답)은 메시지/로그에 넣지 않는다(스펙 §5.5).
        .ok_or_else(|| CalendarError::Terminal("토큰 응답에 access_token 없음".into()))?
        .to_string();
    let refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);
    Ok(TokenResponse {
        access_token,
        refresh_token,
        expires_in,
    })
}

// ── 이벤트 생성(write, Phase 19) — 입력 + 순수 페이로드 빌더 ────────────────────────

/// 카드 → 캘린더 이벤트 생성 입력(사용자 폼). title은 카드에서 prefill, start/end는 RFC3339(timed)
/// 또는 YYYY-MM-DD(all-day). description은 선택. 토큰/외부 ID 미포함(write 입력만). 순수 페이로드로 변환된다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateEventInput {
    pub title: String,
    /// timed = RFC3339(`2026-05-22T09:00:00+09:00`), all-day = YYYY-MM-DD.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub description: Option<String>,
}

/// Google Calendar `events.insert` 요청 본문(JSON). all-day는 `start.date`/`end.date`,
/// timed는 `start.dateTime`/`end.dateTime`. description은 비었으면 생략. 순수 — 단위 테스트 대상.
pub fn build_event_payload(input: &CreateEventInput) -> serde_json::Value {
    let key = if input.all_day { "date" } else { "dateTime" };
    let mut body = serde_json::json!({
        "summary": input.title,
        "start": { key: input.start },
        "end": { key: input.end },
    });
    if let Some(desc) = input.description.as_deref() {
        if !desc.is_empty() {
            body["description"] = serde_json::Value::String(desc.to_string());
        }
    }
    body
}

/// events.insert 응답(JSON) → 생성된 이벤트 id/htmlLink. id 누락은 Terminal(write 검증 실패). 순수.
pub fn parse_created_event(
    body: &serde_json::Value,
) -> Result<(String, Option<String>), CalendarError> {
    let id = body
        .get("id")
        .and_then(|v| v.as_str())
        // 응답 본문(이벤트 상세)은 메시지/로그에 넣지 않는다(스펙 §5.5).
        .ok_or_else(|| CalendarError::Terminal("이벤트 생성 응답에 id 없음".into()))?
        .to_string();
    let url = body
        .get("htmlLink")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok((id, url))
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
}

/// 코드 교환 후 자격증명 갱신(refresh_token 병합). 첫 동의면 refresh_token 필수 — 없으면 Terminal.
/// 반환된 creds를 호출자가 keychain blob에 저장한다. 트레잇 의존 → fake로 검증.
pub async fn connect_core<P: CalendarProvider>(
    provider: &P,
    creds: CalendarCreds,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<CalendarCreds, CalendarError> {
    let resp = provider
        .exchange_code(&creds, code, verifier, redirect_uri)
        .await?;
    let updated = merge_refresh(creds, &resp);
    if !updated.has_refresh() {
        return Err(CalendarError::Terminal(
            "Google이 refresh_token을 반환하지 않았습니다 (이미 승인된 client일 수 있음 — \
             Google 계정의 앱 권한을 제거 후 재연결하세요)."
                .into(),
        ));
    }
    Ok(updated)
}

/// refresh_token으로 access token 재발급(bounded). refresh_token 응답 누락 시 기존 보존.
/// 반환: (access_token, 갱신된 creds). access token in-memory 캐시는 호출자(Phase 10b)가 맡는다.
pub async fn refresh_core<P: CalendarProvider>(
    provider: &P,
    creds: CalendarCreds,
) -> Result<(String, CalendarCreds), CalendarError> {
    if !creds.has_refresh() {
        return Err(CalendarError::Terminal(
            "refresh_token 없음 — 먼저 연결하세요".into(),
        ));
    }
    let resp = provider.refresh_access(&creds).await?;
    let access = resp.access_token.clone();
    let updated = merge_refresh(creds, &resp);
    Ok((access, updated))
}

// ── 캘린더/이벤트 read (Phase 10b) — Raw 타입 + 순수 파싱 + 윈도잉 + 병합 + 코어 ──────────

/// provider가 반환하는 raw 캘린더(선택 플래그는 commands가 입힌다 — github.rs RawPr 선례).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawCalendar {
    pub id: String,
    pub summary: String,
    pub primary: bool,
}

/// provider가 반환하는 raw 이벤트(project_id/calendar_summary는 fetch_events_core가 입힌다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEvent {
    pub id: String,
    pub title: String,
    /// timed = RFC3339(`start.dateTime`), all-day = YYYY-MM-DD(`start.date`).
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    pub url: Option<String>,
}

/// calendarList 응답(JSON) → RawCalendar 목록. id 없는 항목은 건너뛴다(관용). 순수.
pub fn parse_calendar_list(body: &serde_json::Value) -> Vec<RawCalendar> {
    let mut out = Vec::new();
    if let Some(items) = body.get("items").and_then(|i| i.as_array()) {
        for it in items {
            let Some(id) = it.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            // summary 없으면 id로 폴백.
            let summary = it
                .get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or(id)
                .to_string();
            let primary = it.get("primary").and_then(|v| v.as_bool()).unwrap_or(false);
            out.push(RawCalendar {
                id: id.to_string(),
                summary,
                primary,
            });
        }
    }
    out
}

/// events 응답의 한 item(JSON) → RawEvent. id/start 없으면 None(관용). 순수.
/// timed = `start.dateTime`(RFC3339), all-day = `start.date`(YYYY-MM-DD).
pub fn parse_calendar_event(item: &serde_json::Value) -> Option<RawEvent> {
    let id = item.get("id").and_then(|v| v.as_str())?.to_string();
    let start_obj = item.get("start")?;
    let (start, all_day) = match start_obj.get("dateTime").and_then(|v| v.as_str()) {
        Some(dt) => (dt.to_string(), false),
        None => (
            start_obj.get("date").and_then(|v| v.as_str())?.to_string(),
            true,
        ),
    };
    // end는 누락 관용(없으면 start로). all-day는 end.date(exclusive)일 수 있으나 표시용이라 그대로.
    let end = item
        .get("end")
        .and_then(|e| {
            e.get("dateTime")
                .or_else(|| e.get("date"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or(&start)
        .to_string();
    let title = item
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("(제목 없음)")
        .to_string();
    let location = item
        .get("location")
        .and_then(|v| v.as_str())
        .map(String::from);
    let url = item
        .get("htmlLink")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(RawEvent {
        id,
        title,
        start,
        end,
        all_day,
        location,
        url,
    })
}

/// 오늘 윈도우 [00:00:00, 23:59:59] (RFC3339, 주어진 로컬 오프셋). 순수.
pub fn today_window(date: &str, offset: &str) -> (String, String) {
    (
        format!("{date}T00:00:00{offset}"),
        format!("{date}T23:59:59{offset}"),
    )
}

/// 임의 [start_date, end_date] 범위 윈도우 [start 00:00:00, end 23:59:59] (RFC3339, 주어진 오프셋). 순수.
/// 주/월 뷰는 이 윈도우 하나로 **단일 Google range 호출**(N일×1콜 금지). 경계 산출은 프런트(주 시작
/// 요일/월 경계)가 정하고, Rust는 그 [start,end]를 RFC3339 윈도우로 감싸기만 한다(today_window의 일반화).
pub fn range_window(start_date: &str, end_date: &str, offset: &str) -> (String, String) {
    (
        format!("{start_date}T00:00:00{offset}"),
        format!("{end_date}T23:59:59{offset}"),
    )
}

/// 시스템 로컬 UTC 오프셋 문자열("+09:00" 등). chrono Local (시스템 시계 — 순수 아님).
pub fn local_offset() -> String {
    chrono::Local::now().offset().to_string()
}

/// path segment percent-encoding(unreserved 외 %XX). cal_id의 @·# 등 안전 처리. 순수.
pub fn encode_path_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 다중 캘린더 이벤트를 시작시각 순으로 정렬(병합). all-day(date-only)는 앞. 순수.
pub fn merge_sort_events(mut events: Vec<CalendarEvent>) -> Vec<CalendarEvent> {
    events.sort_by_key(event_sort_key);
    events
}

/// 정렬 키: timed는 instant(초), all-day(date-only=파싱 실패)는 맨 앞. 보조키=start 문자열.
/// (오늘 윈도우라 같은 날짜 — 오프셋이 섞여도 instant 비교로 안정 정렬.)
fn event_sort_key(e: &CalendarEvent) -> (i64, String) {
    let ts = chrono::DateTime::parse_from_rfc3339(&e.start)
        .map(|dt| dt.timestamp())
        .unwrap_or(i64::MIN);
    (ts, e.start.clone())
}

/// 한 프로젝트의 fetch 컨텍스트(access token + 선택 캘린더 [(id, summary)]).
pub struct ProjectCalendars {
    pub project_id: String,
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
                out.push(CalendarEvent {
                    id: r.id,
                    calendar_id: cal_id.clone(),
                    calendar_summary: cal_summary.clone(),
                    title: r.title,
                    start: r.start,
                    end: r.end,
                    all_day: r.all_day,
                    location: r.location,
                    url: r.url,
                    project_id: proj.project_id.clone(),
                });
            }
        }
    }
    merge_sort_events(out)
}

// ── loopback 서버 (실 OAuth 흐름 — cargo test 아님, 사용자 관찰) ────────────────────

/// 임의 loopback 포트에 bind한 단일 OAuth redirect 수신기. bind 후 redirect_uri를 노출하고,
/// 그 URI로 브라우저를 연 뒤 `wait_for_redirect`로 code를 받는다(bounded timeout).
pub struct Loopback {
    listener: tokio::net::TcpListener,
    pub redirect_uri: String,
}

impl Loopback {
    /// 127.0.0.1 임의 포트 bind → redirect_uri 확정. 웹 프레임워크 없음(tokio TcpListener).
    pub async fn bind() -> Result<Self, CalendarError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| CalendarError::Terminal(format!("loopback bind 실패: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| CalendarError::Terminal(format!("loopback addr: {e}")))?
            .port();
        Ok(Self {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}"),
        })
    }

    /// redirect(GET /?code=..&state=..)를 bounded timeout 안에 받아 (code, state) 반환.
    /// code 없는 잡음 요청(favicon 등)은 무시하고 계속 대기한다.
    pub async fn wait_for_redirect(
        self,
        timeout: Duration,
    ) -> Result<(String, String), CalendarError> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let accept_loop = async {
            loop {
                let (mut stream, _) = self
                    .listener
                    .accept()
                    .await
                    .map_err(|e| CalendarError::Transient(format!("loopback accept: {e}")))?;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                if let Some((code, state)) = parse_redirect_query(first_line) {
                    let _ = stream.write_all(SUCCESS_HTML.as_bytes()).await;
                    let _ = stream.flush().await;
                    return Ok::<_, CalendarError>((code, state));
                }
                let _ = stream.write_all(WAIT_HTML.as_bytes()).await;
                let _ = stream.flush().await;
            }
        };

        match tokio::time::timeout(timeout, accept_loop).await {
            Ok(result) => result,
            Err(_) => Err(CalendarError::Terminal(format!(
                "OAuth redirect {}초 내 미수신 (timeout)",
                timeout.as_secs()
            ))),
        }
    }
}

// ── 실 HTTP provider (reqwest, rustls) ────────────────────────────────────────────

/// 실제 Google OAuth token provider. reqwest(rustls) + bounded retry.
pub struct HttpCalendarProvider {
    http: reqwest::Client,
}

impl HttpCalendarProvider {
    pub fn new() -> Result<Self, CalendarError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| CalendarError::Terminal(format!("client build: {e}")))?;
        Ok(Self { http })
    }

    /// 토큰 엔드포인트 form POST 1회. 200대가 아니면 분류된 에러.
    async fn post_token(&self, form: &[(&str, &str)]) -> Result<TokenResponse, CalendarError> {
        let resp = self
            .http
            .post(TOKEN_ENDPOINT)
            .form(form)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &body));
        }
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| CalendarError::Terminal(format!("token parse: {e}")))?;
        parse_token_response(&json)
    }

    /// Bearer GET → JSON 1회(read). 200대가 아니면 분류된 에러.
    async fn get_json(
        &self,
        url: &str,
        access_token: &str,
        query: &[(&str, &str)],
    ) -> Result<serde_json::Value, CalendarError> {
        let resp = self
            .http
            .get(url)
            .bearer_auth(access_token)
            .query(query)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &body));
        }
        serde_json::from_str(&body)
            .map_err(|e| CalendarError::Terminal(format!("calendar parse: {e}")))
    }

    /// Bearer POST(JSON body) → JSON 1회(write, Phase 19). 200대가 아니면 분류된 에러.
    /// 401(만료)·403(스코프 부족: readonly 토큰)·404 등은 Terminal로 노출(graceful).
    async fn post_json(
        &self,
        url: &str,
        access_token: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, CalendarError> {
        let resp = self
            .http
            .post(url)
            .bearer_auth(access_token)
            .json(body)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &text));
        }
        serde_json::from_str(&text)
            .map_err(|e| CalendarError::Terminal(format!("event create parse: {e}")))
    }
}

impl CalendarProvider for HttpCalendarProvider {
    async fn exchange_code(
        &self,
        creds: &CalendarCreds,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, CalendarError> {
        // form은 fn 본문이 소유 → with_retry 클로저가 참조해도 await 너머까지 산다.
        let form = [
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ];
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_token(&form)).await
    }

    async fn refresh_access(&self, creds: &CalendarCreds) -> Result<TokenResponse, CalendarError> {
        let refresh_token = creds
            .refresh_token
            .as_deref()
            .ok_or_else(|| CalendarError::Terminal("refresh_token 없음".into()))?;
        let form = [
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ];
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_token(&form)).await
    }

    async fn list_calendars(&self, access_token: &str) -> Result<Vec<RawCalendar>, CalendarError> {
        let no_query: [(&str, &str); 0] = [];
        let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.get_json(CALENDAR_LIST_URL, access_token, &no_query)
        })
        .await
        .map_err(|e| match &e {
            // 403 on calendarList = 스코프 불일치 (기존 calendar.events/readonly 토큰).
            // 재연결이 필요하므로 Terminal 대신 ReconnectRequired로 승격.
            CalendarError::Terminal(m) if m.contains("HTTP 403") => {
                CalendarError::ReconnectRequired(
                    "재연결 필요 — Google Calendar를 다시 연결하세요".to_string(),
                )
            }
            _ => e,
        })?;
        Ok(parse_calendar_list(&json))
    }

    async fn fetch_events(
        &self,
        access_token: &str,
        calendar_id: &str,
        time_min: &str,
        time_max: &str,
    ) -> Result<Vec<RawEvent>, CalendarError> {
        // cal_id는 path segment라 percent-encode(이메일/그룹 id의 @·# 등).
        let url = format!(
            "{CALENDAR_API_BASE}/{}/events",
            encode_path_segment(calendar_id)
        );
        let query = [
            ("timeMin", time_min),
            ("timeMax", time_max),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", EVENTS_MAX_RESULTS),
        ];
        let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.get_json(&url, access_token, &query)
        })
        .await?;
        let items = json
            .get("items")
            .and_then(|i| i.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]);
        Ok(items.iter().filter_map(parse_calendar_event).collect())
    }

    async fn create_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        input: &CreateEventInput,
    ) -> Result<(String, Option<String>), CalendarError> {
        // cal_id는 path segment라 percent-encode(이메일/그룹 id의 @·# 등).
        let url = format!(
            "{CALENDAR_API_BASE}/{}/events",
            encode_path_segment(calendar_id)
        );
        let payload = build_event_payload(input);
        let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.post_json(&url, access_token, &payload)
        })
        .await?;
        parse_created_event(&json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PKCE S256: RFC 7636 Appendix B 테스트 벡터(고정 verifier → 알려진 challenge).
    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = pkce_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    /// code_verifier: 43자(32바이트 base64url no-pad) + unreserved 문자만, 매번 달라야 한다.
    #[test]
    fn gen_code_verifier_length_and_charset() {
        let v = gen_code_verifier();
        assert_eq!(v.len(), 43, "32바이트 base64url(no pad) = 43자");
        assert!(
            v.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "unreserved(base64url) 문자만: {v}"
        );
        assert_ne!(
            gen_code_verifier(),
            gen_code_verifier(),
            "CSPRNG라 매번 다름"
        );
    }

    /// state: 비어있지 않고 매번 다르다.
    #[test]
    fn gen_state_is_random_nonempty() {
        let a = gen_state();
        assert!(!a.is_empty());
        assert_ne!(a, gen_state());
    }

    /// auth_url: 모든 필수 파라미터 + S256 + events scope(read+write)를 담는다(percent-encoding 라운드트립).
    #[test]
    fn auth_url_contains_required_params() {
        let url = auth_url("cid.apps", "http://127.0.0.1:54321", "CHAL", "STATE");
        let parsed = reqwest::Url::parse(&url).unwrap();
        let pairs: std::collections::HashMap<String, String> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(parsed.host_str(), Some("accounts.google.com"));
        assert_eq!(pairs.get("client_id").unwrap(), "cid.apps");
        assert_eq!(pairs.get("redirect_uri").unwrap(), "http://127.0.0.1:54321");
        assert_eq!(pairs.get("response_type").unwrap(), "code");
        assert_eq!(pairs.get("scope").unwrap(), CALENDAR_SCOPE);
        assert_eq!(pairs.get("code_challenge").unwrap(), "CHAL");
        assert_eq!(pairs.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(pairs.get("access_type").unwrap(), "offline");
        assert_eq!(pairs.get("prompt").unwrap(), "consent");
        assert_eq!(pairs.get("state").unwrap(), "STATE");
    }

    /// redirect 파싱: 정상 / code 누락 / state 누락 / 잡음(favicon) / percent-encoded code.
    #[test]
    fn parse_redirect_query_cases() {
        assert_eq!(
            parse_redirect_query("GET /?code=abc123&state=xyz HTTP/1.1"),
            Some(("abc123".into(), "xyz".into()))
        );
        // 순서 무관 + 추가 파라미터.
        assert_eq!(
            parse_redirect_query("GET /?scope=foo&state=s1&code=c1 HTTP/1.1"),
            Some(("c1".into(), "s1".into()))
        );
        // code에 percent-encoded 문자(/)가 있어도 디코드.
        assert_eq!(
            parse_redirect_query("GET /?code=4%2Fabc&state=s HTTP/1.1"),
            Some(("4/abc".into(), "s".into()))
        );
        // code 누락.
        assert_eq!(parse_redirect_query("GET /?state=only HTTP/1.1"), None);
        // state 누락.
        assert_eq!(parse_redirect_query("GET /?code=only HTTP/1.1"), None);
        // OAuth error redirect(코드 없음).
        assert_eq!(
            parse_redirect_query("GET /?error=access_denied&state=s HTTP/1.1"),
            None
        );
        // 잡음(favicon).
        assert_eq!(parse_redirect_query("GET /favicon.ico HTTP/1.1"), None);
    }

    /// 토큰 응답 파싱: 전체 / refresh 없음 / expires_in 기본값 / access_token 누락=Terminal.
    #[test]
    fn parse_token_response_cases() {
        let full = serde_json::json!({
            "access_token": "at", "refresh_token": "rt", "expires_in": 3599
        });
        assert_eq!(
            parse_token_response(&full).unwrap(),
            TokenResponse {
                access_token: "at".into(),
                refresh_token: Some("rt".into()),
                expires_in: 3599
            }
        );
        // refresh_token 없음(갱신 응답) + expires_in 기본값.
        let refresh_resp = serde_json::json!({ "access_token": "at2" });
        let r = parse_token_response(&refresh_resp).unwrap();
        assert_eq!(r.access_token, "at2");
        assert!(r.refresh_token.is_none());
        assert_eq!(r.expires_in, 3600, "expires_in 누락 시 기본 3600");
        // access_token 누락 → Terminal. 응답 본문은 메시지에 노출되지 않는다(스펙 §5.5).
        let bad = serde_json::json!({ "error": "invalid_grant", "leak": "SECRET_xyz" });
        let Err(CalendarError::Terminal(m)) = parse_token_response(&bad) else {
            panic!("access_token 누락 → Terminal");
        };
        assert!(
            !m.contains("SECRET_xyz") && !m.contains("invalid_grant"),
            "본문 내용이 메시지에 노출되면 안 됨"
        );
    }

    /// merge_refresh: 응답에 refresh 있으면 교체, 없으면(빈 문자열 포함) 기존 유지.
    #[test]
    fn merge_refresh_preserves_existing_when_absent() {
        let base = CalendarCreds {
            client_id: "c".into(),
            client_secret: "s".into(),
            refresh_token: Some("OLD".into()),
        };
        // 응답에 refresh 없음 → OLD 유지.
        let kept = merge_refresh(
            base.clone(),
            &TokenResponse {
                access_token: "a".into(),
                refresh_token: None,
                expires_in: 3600,
            },
        );
        assert_eq!(kept.refresh_token.as_deref(), Some("OLD"));
        // 응답에 새 refresh → 교체.
        let replaced = merge_refresh(
            base,
            &TokenResponse {
                access_token: "a".into(),
                refresh_token: Some("NEW".into()),
                expires_in: 3600,
            },
        );
        assert_eq!(replaced.refresh_token.as_deref(), Some("NEW"));
    }

    /// blob 라운드트립 + has_refresh. (토큰 본문은 keychain에만 — 이 구조는 그 직렬화 단위)
    #[test]
    fn calendar_creds_blob_roundtrip() {
        let creds = CalendarCreds {
            client_id: "id".into(),
            client_secret: "sec".into(),
            refresh_token: Some("rt".into()),
        };
        let blob = creds.to_blob();
        assert_eq!(CalendarCreds::from_blob(&blob).unwrap(), creds);
        assert!(creds.has_refresh());
        // client만 입력(연결 전): refresh 없음.
        let client_only = CalendarCreds {
            client_id: "id".into(),
            client_secret: "sec".into(),
            refresh_token: None,
        };
        assert!(!client_only.has_refresh());
        assert!(!CalendarCreds::from_blob(&client_only.to_blob())
            .unwrap()
            .has_refresh());
    }

    /// HTTP 분류: 429/5xx=Transient, 그 외 4xx=Terminal.
    #[test]
    fn classify_http_buckets() {
        assert!(matches!(
            classify_http(429, "rate"),
            CalendarError::Transient(_)
        ));
        assert!(matches!(
            classify_http(503, "down"),
            CalendarError::Transient(_)
        ));
        assert!(matches!(
            classify_http(401, "auth"),
            CalendarError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(400, "invalid_grant"),
            CalendarError::Terminal(_)
        ));
        // 본문 스크럽(스펙 §5.5): 응답 본문 내용은 메시지에 노출되지 않는다.
        let CalendarError::Terminal(m) = classify_http(400, "SECRET_BODY_xyz") else {
            panic!("400 → Terminal");
        };
        assert!(!m.contains("SECRET_BODY_xyz"), "본문이 메시지에 새면 안 됨");
    }

    // ── 이벤트 생성(write, Phase 19): 페이로드 빌더 + 응답 파싱 ────────────────────────

    /// timed 이벤트 페이로드: summary + start/end.dateTime + description(있으면).
    #[test]
    fn build_event_payload_timed_with_description() {
        let input = CreateEventInput {
            title: "디자인 리뷰".into(),
            start: "2026-05-22T14:00:00+09:00".into(),
            end: "2026-05-22T15:00:00+09:00".into(),
            all_day: false,
            description: Some("Q2 폴리시".into()),
        };
        let body = build_event_payload(&input);
        assert_eq!(body["summary"], "디자인 리뷰");
        assert_eq!(body["start"]["dateTime"], "2026-05-22T14:00:00+09:00");
        assert_eq!(body["end"]["dateTime"], "2026-05-22T15:00:00+09:00");
        assert_eq!(body["description"], "Q2 폴리시");
        // all-day 키는 없어야 한다.
        assert!(body["start"].get("date").is_none());
    }

    /// all-day 이벤트: start/end.date(YYYY-MM-DD), description 비었으면 생략.
    #[test]
    fn build_event_payload_all_day_omits_empty_description() {
        let input = CreateEventInput {
            title: "휴가".into(),
            start: "2026-05-22".into(),
            end: "2026-05-23".into(),
            all_day: true,
            description: None,
        };
        let body = build_event_payload(&input);
        assert_eq!(body["start"]["date"], "2026-05-22");
        assert_eq!(body["end"]["date"], "2026-05-23");
        assert!(body["start"].get("dateTime").is_none());
        assert!(
            body.get("description").is_none(),
            "None이면 description 생략"
        );

        // 빈 문자열도 생략.
        let empty_desc = CreateEventInput {
            description: Some("".into()),
            ..input
        };
        assert!(build_event_payload(&empty_desc)
            .get("description")
            .is_none());
    }

    /// 생성 응답 파싱: id + htmlLink, htmlLink 누락 관용, id 누락=Terminal.
    #[test]
    fn parse_created_event_cases() {
        let ok = serde_json::json!({ "id": "evt1", "htmlLink": "https://cal/evt1" });
        assert_eq!(
            parse_created_event(&ok).unwrap(),
            ("evt1".into(), Some("https://cal/evt1".into()))
        );
        // htmlLink 누락 관용.
        let no_link = serde_json::json!({ "id": "evt2" });
        assert_eq!(
            parse_created_event(&no_link).unwrap(),
            ("evt2".into(), None)
        );
        // id 누락 → Terminal(write 검증 실패). 응답 본문은 메시지에 노출되지 않는다(스펙 §5.5).
        let bad = serde_json::json!({ "error": "insufficientPermissions", "leak": "SECRET_xyz" });
        let Err(CalendarError::Terminal(m)) = parse_created_event(&bad) else {
            panic!("id 누락 → Terminal");
        };
        assert!(
            !m.contains("SECRET_xyz") && !m.contains("insufficientPermissions"),
            "본문 내용이 메시지에 노출되면 안 됨"
        );
    }

    // ── 트레잇 seam: connect_core / refresh_core / fetch_events_core (fake provider) ──────

    use std::collections::HashMap;

    struct FakeProvider {
        exchange: Result<TokenResponse, CalendarError>,
        refresh: Result<TokenResponse, CalendarError>,
        calendars: Vec<RawCalendar>,
        /// calendar_id → 결과(없으면 빈 목록). Err로 부분 실패 격리 검증.
        events: HashMap<String, Result<Vec<RawEvent>, CalendarError>>,
        /// create_event 결과(write 트레잇 만족용). 기본은 성공 id.
        create: Result<(String, Option<String>), CalendarError>,
    }

    impl Default for FakeProvider {
        fn default() -> Self {
            FakeProvider {
                exchange: Err(CalendarError::Terminal("unset".into())),
                refresh: Err(CalendarError::Terminal("unset".into())),
                calendars: Vec::new(),
                events: HashMap::new(),
                create: Ok(("evt_new".into(), Some("https://cal/evt_new".into()))),
            }
        }
    }

    impl CalendarProvider for FakeProvider {
        async fn exchange_code(
            &self,
            _creds: &CalendarCreds,
            _code: &str,
            _verifier: &str,
            _redirect_uri: &str,
        ) -> Result<TokenResponse, CalendarError> {
            self.exchange.clone()
        }
        async fn refresh_access(
            &self,
            _creds: &CalendarCreds,
        ) -> Result<TokenResponse, CalendarError> {
            self.refresh.clone()
        }
        async fn list_calendars(
            &self,
            _access_token: &str,
        ) -> Result<Vec<RawCalendar>, CalendarError> {
            Ok(self.calendars.clone())
        }
        async fn fetch_events(
            &self,
            _access_token: &str,
            calendar_id: &str,
            _time_min: &str,
            _time_max: &str,
        ) -> Result<Vec<RawEvent>, CalendarError> {
            self.events
                .get(calendar_id)
                .cloned()
                .unwrap_or_else(|| Ok(Vec::new()))
        }
        async fn create_event(
            &self,
            _access_token: &str,
            _calendar_id: &str,
            _input: &CreateEventInput,
        ) -> Result<(String, Option<String>), CalendarError> {
            self.create.clone()
        }
    }

    fn client_only() -> CalendarCreds {
        CalendarCreds {
            client_id: "cid".into(),
            client_secret: "sec".into(),
            refresh_token: None,
        }
    }

    /// connect_core: 교환이 refresh_token을 주면 creds에 박혀 연결 완료.
    #[tokio::test]
    async fn connect_core_stores_refresh_token() {
        let provider = FakeProvider {
            exchange: Ok(TokenResponse {
                access_token: "at".into(),
                refresh_token: Some("RT".into()),
                expires_in: 3600,
            }),
            ..Default::default()
        };
        let out = connect_core(
            &provider,
            client_only(),
            "code",
            "ver",
            "http://127.0.0.1:1",
        )
        .await
        .unwrap();
        assert_eq!(out.refresh_token.as_deref(), Some("RT"));
        assert_eq!(out.client_id, "cid", "client는 보존");
    }

    /// connect_core: refresh_token 없는 교환 응답(이미 승인된 client)은 Terminal로 막힌다.
    #[tokio::test]
    async fn connect_core_errors_without_refresh_token() {
        let provider = FakeProvider {
            exchange: Ok(TokenResponse {
                access_token: "at".into(),
                refresh_token: None,
                expires_in: 3600,
            }),
            ..Default::default()
        };
        let r = connect_core(
            &provider,
            client_only(),
            "code",
            "ver",
            "http://127.0.0.1:1",
        )
        .await;
        assert!(matches!(r, Err(CalendarError::Terminal(_))));
    }

    /// refresh_core: 새 access 발급 + refresh 응답 누락 시 기존 refresh_token 보존.
    #[tokio::test]
    async fn refresh_core_preserves_refresh_when_absent() {
        let connected = CalendarCreds {
            client_id: "cid".into(),
            client_secret: "sec".into(),
            refresh_token: Some("OLD".into()),
        };
        let provider = FakeProvider {
            refresh: Ok(TokenResponse {
                access_token: "fresh".into(),
                refresh_token: None,
                expires_in: 3600,
            }),
            ..Default::default()
        };
        let (access, updated) = refresh_core(&provider, connected).await.unwrap();
        assert_eq!(access, "fresh");
        assert_eq!(
            updated.refresh_token.as_deref(),
            Some("OLD"),
            "refresh 보존"
        );
    }

    /// refresh_core: refresh_token 없으면(미연결) Terminal — provider 호출 없이 막힌다.
    #[tokio::test]
    async fn refresh_core_errors_when_not_connected() {
        let provider = FakeProvider::default();
        let r = refresh_core(&provider, client_only()).await;
        assert!(matches!(r, Err(CalendarError::Terminal(_))));
    }

    // ── Phase 10b: 캘린더/이벤트 read 순수 함수 + fetch_events_core ──────────────────

    /// calendarList 파싱: id/summary/primary, summary 누락은 id 폴백, id 없는 항목 스킵.
    #[test]
    fn parse_calendar_list_extracts_items() {
        let body = serde_json::json!({
            "items": [
                { "id": "primary", "summary": "내 캘린더", "primary": true },
                { "id": "team@group.calendar.google.com", "summary": "팀" },
                { "summary": "id 없음 — 스킵" }
            ]
        });
        let cals = parse_calendar_list(&body);
        assert_eq!(cals.len(), 2);
        assert_eq!(cals[0].id, "primary");
        assert!(cals[0].primary);
        assert_eq!(cals[1].id, "team@group.calendar.google.com");
        assert!(!cals[1].primary);
        // summary 폴백.
        let no_summary = serde_json::json!({ "items": [ { "id": "x" } ] });
        assert_eq!(parse_calendar_list(&no_summary)[0].summary, "x");
    }

    /// 이벤트 파싱: timed(dateTime) vs all-day(date), end 누락 관용, id/start 없으면 None.
    #[test]
    fn parse_calendar_event_timed_and_all_day() {
        let timed = serde_json::json!({
            "id": "e1", "summary": "스탠드업",
            "start": { "dateTime": "2026-05-21T09:00:00+09:00" },
            "end": { "dateTime": "2026-05-21T09:30:00+09:00" },
            "location": "Zoom", "htmlLink": "https://cal/e1"
        });
        let r = parse_calendar_event(&timed).unwrap();
        assert!(!r.all_day);
        assert_eq!(r.start, "2026-05-21T09:00:00+09:00");
        assert_eq!(r.location.as_deref(), Some("Zoom"));
        assert_eq!(r.url.as_deref(), Some("https://cal/e1"));

        let all_day = serde_json::json!({
            "id": "e2", "summary": "휴가", "start": { "date": "2026-05-21" }
        });
        let r2 = parse_calendar_event(&all_day).unwrap();
        assert!(r2.all_day);
        assert_eq!(r2.start, "2026-05-21");
        assert_eq!(r2.end, "2026-05-21", "end 누락 시 start 폴백");

        // 제목 누락 관용.
        let no_title = serde_json::json!({ "id": "e3", "start": { "date": "2026-05-21" } });
        assert_eq!(
            parse_calendar_event(&no_title).unwrap().title,
            "(제목 없음)"
        );
        // id/start 없으면 None.
        assert!(parse_calendar_event(&serde_json::json!({ "summary": "x" })).is_none());
        assert!(parse_calendar_event(&serde_json::json!({ "id": "x" })).is_none());
    }

    /// today_window: 주어진 오프셋으로 [00:00:00, 23:59:59] RFC3339.
    #[test]
    fn today_window_builds_rfc3339_bounds() {
        assert_eq!(
            today_window("2026-05-21", "+09:00"),
            (
                "2026-05-21T00:00:00+09:00".into(),
                "2026-05-21T23:59:59+09:00".into()
            )
        );
        assert_eq!(
            today_window("2026-05-21", "-05:00"),
            (
                "2026-05-21T00:00:00-05:00".into(),
                "2026-05-21T23:59:59-05:00".into()
            )
        );
    }

    /// range_window(P7): 임의 [start,end] → [start 00:00:00, end 23:59:59] RFC3339, 주어진 오프셋.
    /// 일/주/월 각 범위가 단일 윈도우 한 쌍으로 감싸지는지(주/월도 단발 range 콜) 경계 검증.
    #[test]
    fn range_window_day_week_month_bounds() {
        // 일(日) 뷰: start == end == 같은 날 → today_window와 동일 경계.
        assert_eq!(
            range_window("2026-05-21", "2026-05-21", "+09:00"),
            (
                "2026-05-21T00:00:00+09:00".into(),
                "2026-05-21T23:59:59+09:00".into()
            )
        );
        // 주(週) 뷰: 월요일 시작 ~ 일요일 끝(7일). 2026-05-18(월)~2026-05-24(일).
        assert_eq!(
            range_window("2026-05-18", "2026-05-24", "+09:00"),
            (
                "2026-05-18T00:00:00+09:00".into(),
                "2026-05-24T23:59:59+09:00".into()
            )
        );
        // 월(月) 뷰: 1일 ~ 말일(31일). 2026-05-01 ~ 2026-05-31.
        assert_eq!(
            range_window("2026-05-01", "2026-05-31", "+09:00"),
            (
                "2026-05-01T00:00:00+09:00".into(),
                "2026-05-31T23:59:59+09:00".into()
            )
        );
        // 음수 오프셋(타임존)도 동일 처리.
        assert_eq!(
            range_window("2026-02-01", "2026-02-28", "-05:00"),
            (
                "2026-02-01T00:00:00-05:00".into(),
                "2026-02-28T23:59:59-05:00".into()
            )
        );
    }

    /// path segment 인코딩: unreserved 보존, @·# 등은 %XX.
    #[test]
    fn encode_path_segment_escapes_reserved() {
        assert_eq!(encode_path_segment("primary"), "primary");
        assert_eq!(
            encode_path_segment("a@b.com"),
            "a%40b.com",
            "@→%40, .은 보존"
        );
        assert_eq!(encode_path_segment("#contacts"), "%23contacts");
    }

    fn ev(id: &str, start: &str, all_day: bool) -> RawEvent {
        RawEvent {
            id: id.into(),
            title: id.into(),
            start: start.into(),
            end: start.into(),
            all_day,
            location: None,
            url: None,
        }
    }

    /// fetch_events_core: 다중 캘린더 병합·시간순 정렬(all-day 먼저)·캘린더별 실패 격리.
    #[tokio::test]
    async fn fetch_events_core_merges_sorts_isolates() {
        let mut events = HashMap::new();
        events.insert(
            "calA".into(),
            Ok(vec![
                ev("noon", "2026-05-21T12:00:00+09:00", false),
                ev("morning", "2026-05-21T09:00:00+09:00", false),
            ]),
        );
        events.insert("calAllDay".into(), Ok(vec![ev("vac", "2026-05-21", true)]));
        events.insert(
            "calBoom".into(),
            Err(CalendarError::Terminal("boom".into())),
        );
        let provider = FakeProvider {
            events,
            ..Default::default()
        };
        let projects = vec![
            ProjectCalendars {
                project_id: "pA".into(),
                access_token: "a".into(),
                calendars: vec![
                    ("calA".into(), "업무".into()),
                    ("calAllDay".into(), "개인".into()),
                ],
            },
            ProjectCalendars {
                project_id: "pB".into(),
                access_token: "b".into(),
                calendars: vec![("calBoom".into(), "깨짐".into())], // 실패 → 격리
            },
        ];
        let out = fetch_events_core(&provider, projects, "min", "max").await;
        // calBoom은 격리, 나머지 3건. all-day 먼저 → 09:00 → 12:00.
        let ids: Vec<&str> = out.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["vac", "morning", "noon"]);
        assert_eq!(out[0].calendar_summary, "개인");
        assert_eq!(out[0].project_id, "pA");
        assert!(out[0].all_day);
    }

    /// fetch_events_core: 빈 선택은 빈 결과(미연결/선택 없음 graceful).
    #[tokio::test]
    async fn fetch_events_core_empty_selection_is_empty() {
        let provider = FakeProvider::default();
        let out = fetch_events_core(
            &provider,
            vec![ProjectCalendars {
                project_id: "p".into(),
                access_token: "a".into(),
                calendars: vec![],
            }],
            "min",
            "max",
        )
        .await;
        assert!(out.is_empty());
    }
}
