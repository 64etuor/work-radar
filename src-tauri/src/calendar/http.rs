//! 실 HTTP provider (reqwest, rustls) + 에러 분류(`classify_http`/`classify_reqwest`) +
//! path segment percent-encoding. bounded retry(`with_retry` + reqwest timeout).

use std::time::Duration;

use crate::retry::with_retry;

use super::oauth::{parse_token_response, CalendarCreds, TokenResponse};
use super::parse::{parse_calendar_event, parse_calendar_list, RawCalendar, RawEvent};
use super::write::{build_event_payload, parse_created_event, CreateEventInput};
use super::{CalendarError, CalendarProvider};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// 한 토큰 교환/갱신 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);

const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const CALENDAR_LIST_URL: &str = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_API_BASE: &str = "https://www.googleapis.com/calendar/v3/calendars";
/// events 조회 상한(bounded — 무한 페이지네이션 금지). 오늘 윈도우라 단발로 충분.
const EVENTS_MAX_RESULTS: &str = "50";

// ── 에러 분류 + bounded retry (github.rs/notion.rs와 동일 패턴) ─────────────────────

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
pub(super) fn classify_http(status: u16, body: &str) -> CalendarError {
    // 외부 응답 본문은 사용자 콘텐츠/PII 가능 → 메시지·로그에 내용을 넣지 않는다(스펙 §5.5). 크기만 노출.
    let body_len = body.len();
    if status == 429 || status >= 500 {
        CalendarError::Transient(format!("HTTP {status} (응답 {body_len}B)"))
    } else {
        CalendarError::Terminal(format!("HTTP {status} (응답 {body_len}B)"))
    }
}

/// reqwest 전송 에러 → 분류. 네트워크/타임아웃은 일시적, 디코드 실패는 영구.
pub(super) fn classify_reqwest(e: &reqwest::Error) -> CalendarError {
    if e.is_decode() {
        CalendarError::Terminal(format!("decode error: {e}"))
    } else {
        CalendarError::Transient(e.to_string())
    }
}

/// path segment percent-encoding(unreserved 외 %XX). cal_id의 @·# 등 안전 처리. 순수.
pub(super) fn encode_path_segment(s: &str) -> String {
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

    /// Bearer PATCH(JSON body) → 빈 응답 OK(204) 또는 JSON. 200대가 아니면 분류된 에러.
    /// 401/403/404 등은 Terminal로 노출. Today×Timeline PR 2 — 이벤트 부분 갱신.
    async fn patch_json(
        &self,
        url: &str,
        access_token: &str,
        body: &serde_json::Value,
    ) -> Result<(), CalendarError> {
        let resp = self
            .http
            .patch(url)
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
        Ok(())
    }

    /// Bearer DELETE → 빈 응답(204) 또는 JSON. 200대/204가 아니면 분류된 에러.
    /// Today×Timeline PR 2 — 이벤트 삭제(unschedule mirror 정리).
    async fn delete_request(&self, url: &str, access_token: &str) -> Result<(), CalendarError> {
        let resp = self
            .http
            .delete(url)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        // 410 Gone(이미 삭제됨)도 성공으로 간주 — idempotent unschedule.
        if status == 410 {
            return Ok(());
        }
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &text));
        }
        Ok(())
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

    async fn patch_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
        patch: &serde_json::Value,
    ) -> Result<(), CalendarError> {
        let url = format!(
            "{CALENDAR_API_BASE}/{}/events/{}",
            encode_path_segment(calendar_id),
            encode_path_segment(event_id)
        );
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.patch_json(&url, access_token, patch)
        })
        .await?;
        Ok(())
    }

    async fn delete_event(
        &self,
        access_token: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), CalendarError> {
        let url = format!(
            "{CALENDAR_API_BASE}/{}/events/{}",
            encode_path_segment(calendar_id),
            encode_path_segment(event_id)
        );
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.delete_request(&url, access_token)
        })
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
