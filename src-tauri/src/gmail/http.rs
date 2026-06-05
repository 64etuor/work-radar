//! 실 HTTP provider (reqwest, rustls) + 에러 분류(`classify_http`/`classify_reqwest`).
//! bounded retry(`with_retry` + reqwest timeout). calendar/http.rs와 동일 패턴.
//!
//! 연결 라이브니스 검증은 **`refresh_core` 토큰 갱신 라운드트립**으로 한다 — send-only 스코프
//! (`gmail.send`)라 읽기/getProfile/메시지 리스트 API가 전혀 없고(읽기 스코프 0, PII 0), refresh
//! 성공 = 자격증명·refresh_token 유효 신호로 충분하다. **이 모듈은 어떤 Gmail read 엔드포인트도
//! 추가하지 않는다.** 별도 `ping` 커맨드는 없다(읽기 스코프를 끌어들일 위험 회피) — refresh는
//! connect 흐름(`commands::gmail` connect)과 게이트의 `access_token_for_cref`가 소비한다.

use std::time::Duration;

use crate::retry::with_retry;

use super::oauth::{parse_token_response, GmailCreds, TokenResponse};
use super::{GmailError, GmailProvider};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// 한 토큰 교환/갱신 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// 쓰기(messages.send POST) 재시도 횟수 = 1(재시도 안 함). messages.send는 **멱등하지 않다** — 요청이
/// Gmail에 도달한 뒤 응답만 유실되면(transport drop=transient) 재시도가 **중복 발송**을 낸다(이메일은
/// 캘린더 중복보다 비대칭적으로 위험). 그래서 AI-origin 게이트 write(`send_message_once`)는 재시도 대신
/// 실패를 노출한다(calendar create_event_once / github WRITE_MAX_ATTEMPTS=1 선례, INVARIANT #5 정신).
const WRITE_MAX_ATTEMPTS: u32 = 1;

const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
/// send-only write 엔드포인트(messages.send). 읽기/getProfile/리스트 엔드포인트는 의도적으로 없다.
const SEND_ENDPOINT: &str = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// ── 에러 분류 + bounded retry (calendar/http.rs와 동일 패턴) ──────────────────────────

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
pub(super) fn classify_http(status: u16, body: &str) -> GmailError {
    // 외부 응답 본문은 사용자 콘텐츠/PII 가능(send 4xx의 수신자 echo 등) → 메시지·로그에 내용을
    // 넣지 않는다(스펙 §5.5). 크기만 노출.
    let body_len = body.len();
    if status == 429 || status >= 500 {
        GmailError::Transient(format!("HTTP {status} (응답 {body_len}B)"))
    } else {
        GmailError::Terminal(format!("HTTP {status} (응답 {body_len}B)"))
    }
}

/// 토큰 엔드포인트(exchange_code/refresh_access) 비-2xx 응답 분류. 순수.
/// status 400 + body가 `invalid_grant`(refresh_token 취소/만료 신호)면 ReconnectRequired —
/// 사용자가 Google에서 앱 접근을 취소하면 refresh가 400/invalid_grant로 오므로 재연결 유도가 필요하다.
/// 그 외 비-2xx는 `classify_http`(429/5xx=Transient, 4xx=Terminal).
/// **body는 분류용으로만 검사**한다 — 반환 메시지는 정적 문자열만(INVARIANT #7, body 미노출).
/// send-path 403(rate-limit 가능)은 여기 대상이 아니다 — send는 `classify_http` 유지.
pub(super) fn classify_token_error(status: u16, body: &str) -> GmailError {
    if status == 400 && body.contains("invalid_grant") {
        GmailError::ReconnectRequired("Gmail 재연결이 필요합니다 (자격 증명이 만료/취소됨)".into())
    } else {
        classify_http(status, body)
    }
}

/// reqwest 전송 에러 → 분류. 네트워크/타임아웃은 일시적, 디코드 실패는 영구.
pub(super) fn classify_reqwest(e: &reqwest::Error) -> GmailError {
    if e.is_decode() {
        GmailError::Terminal(format!("decode error: {e}"))
    } else {
        GmailError::Transient(e.to_string())
    }
}

/// send 응답 JSON에서 메시지 id(external_ref)를 뽑는다. 누락/빈 값은 Terminal. 순수.
/// 응답 본문 내용은 메시지에 넣지 않는다(스펙 §5.5) — 정적 사유만.
pub(super) fn parse_send_response(json: &serde_json::Value) -> Result<String, GmailError> {
    json.get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .ok_or_else(|| GmailError::Terminal("send 응답에 message id 없음".into()))
}

/// 실제 Gmail send provider. reqwest(rustls) + bounded retry.
pub struct HttpGmailProvider {
    http: reqwest::Client,
}

impl HttpGmailProvider {
    pub fn new() -> Result<Self, GmailError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| GmailError::Terminal(format!("client build: {e}")))?;
        Ok(Self { http })
    }

    /// 토큰 엔드포인트 form POST 1회. 200대가 아니면 분류된 에러.
    async fn post_token(&self, form: &[(&str, &str)]) -> Result<TokenResponse, GmailError> {
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
            // 400 + invalid_grant → ReconnectRequired(재연결 nav), 그 외 → classify_http. body는
            // 분류용으로만 검사하고 메시지엔 넣지 않는다(INVARIANT #7).
            return Err(classify_token_error(status, &body));
        }
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| GmailError::Terminal(format!("token parse: {e}")))?;
        parse_token_response(&json)
    }

    /// messages.send POST 1회. `raw`는 base64url RFC822(message.rs build_raw_message 산출).
    /// 200대면 응답에서 message id를 뽑고, 아니면 분류된 에러(본문 내용 미노출).
    async fn post_send(&self, access_token: &str, raw: &str) -> Result<String, GmailError> {
        let body = serde_json::json!({ "raw": raw });
        let resp = self
            .http
            .post(SEND_ENDPOINT)
            .bearer_auth(access_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        // 응답 본문(send 4xx는 수신자/입력 echo 가능)은 내용을 메시지에 넣지 않는다 — 크기만.
        let text = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &text));
        }
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| GmailError::Terminal(format!("send parse: {e}")))?;
        parse_send_response(&json)
    }
}

impl GmailProvider for HttpGmailProvider {
    async fn exchange_code(
        &self,
        creds: &GmailCreds,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, GmailError> {
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

    async fn refresh_access(&self, creds: &GmailCreds) -> Result<TokenResponse, GmailError> {
        let refresh_token = creds
            .refresh_token
            .as_deref()
            .ok_or_else(|| GmailError::Terminal("refresh_token 없음".into()))?;
        let form = [
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ];
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_token(&form)).await
    }

    async fn send_message_once(&self, access_token: &str, raw: &str) -> Result<String, GmailError> {
        // 시도 횟수 1(WRITE_MAX_ATTEMPTS) — 비멱등 write라 재시도 금지(중복 발송 차단). 근거는
        // 트레잇 doc / WRITE_MAX_ATTEMPTS 주석 참조. bounded-retry send 변종은 의도적으로 없다.
        with_retry(WRITE_MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.post_send(access_token, raw)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HTTP 분류: 429/5xx=Transient, 그 외 4xx=Terminal + send-error-path 본문 스크럽.
    #[test]
    fn classify_http_buckets() {
        assert!(matches!(
            classify_http(429, "rate"),
            GmailError::Transient(_)
        ));
        assert!(matches!(
            classify_http(503, "down"),
            GmailError::Transient(_)
        ));
        assert!(matches!(
            classify_http(401, "auth"),
            GmailError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(403, "scope"),
            GmailError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(400, "invalid"),
            GmailError::Terminal(_)
        ));
        // send-error-path 본문 스크럽(스펙 §5.5 / M2): Gmail 400 응답 본문에 echo된 수신자가
        // 에러 메시지에 절대 새지 않는다 — `HTTP {status} ({len}B)`만 노출.
        let GmailError::Terminal(m) = classify_http(400, "recipient leak@x.test echoed") else {
            panic!("400 → Terminal");
        };
        assert!(
            !m.contains("leak@x.test"),
            "send 4xx 응답 본문이 메시지에 새면 안 됨: {m}"
        );
        assert!(m.contains("HTTP 400"), "상태/크기만 노출: {m}");
    }

    /// 토큰-엔드포인트 에러 분류: 400+invalid_grant=ReconnectRequired, 그 외는 classify_http 위임.
    /// ReconnectRequired 메시지에 body가 새지 않는다(INVARIANT #7 — 분류용으로만 검사).
    #[test]
    fn classify_token_error_reconnect_on_invalid_grant() {
        // 400 + invalid_grant → ReconnectRequired + body 미노출.
        let GmailError::ReconnectRequired(m) = classify_token_error(
            400,
            "{\"error\":\"invalid_grant\",\"leak\":\"DISTINCT_BODY_xyz\"}",
        ) else {
            panic!("400+invalid_grant → ReconnectRequired");
        };
        assert!(
            !m.contains("DISTINCT_BODY_xyz") && !m.contains("invalid_grant"),
            "응답 본문이 ReconnectRequired 메시지에 새면 안 됨: {m}"
        );
        // 400인데 invalid_grant 아님 → Terminal(classify_http).
        assert!(matches!(
            classify_token_error(400, "{\"error\":\"invalid_request\"}"),
            GmailError::Terminal(_)
        ));
        // 401(invalid_grant 문자열 있어도 status 400 아님) → Terminal.
        assert!(matches!(
            classify_token_error(401, "invalid_grant"),
            GmailError::Terminal(_)
        ));
        // 429/5xx → Transient(분류 위임).
        assert!(matches!(
            classify_token_error(429, "rate"),
            GmailError::Transient(_)
        ));
        assert!(matches!(
            classify_token_error(503, "down"),
            GmailError::Transient(_)
        ));
    }

    /// send 응답 id 파싱: 정상 추출 / id 누락=Terminal(본문 내용 미노출).
    #[test]
    fn parse_send_response_cases() {
        let ok = serde_json::json!({ "id": "abc", "threadId": "t" });
        assert_eq!(parse_send_response(&ok).unwrap(), "abc");
        // id 누락 → Terminal. 응답 본문 내용(threadId 값 등)은 메시지에 노출되지 않는다.
        let no_id = serde_json::json!({ "threadId": "SECRET_thread_xyz" });
        let Err(GmailError::Terminal(m)) = parse_send_response(&no_id) else {
            panic!("id 누락 → Terminal");
        };
        assert!(
            !m.contains("SECRET_thread_xyz"),
            "응답 본문 내용이 메시지에 새면 안 됨: {m}"
        );
        // 빈 id도 Terminal.
        let empty = serde_json::json!({ "id": "" });
        assert!(matches!(
            parse_send_response(&empty),
            Err(GmailError::Terminal(_))
        ));
    }
}
