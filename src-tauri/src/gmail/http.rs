//! 실 HTTP provider (reqwest, rustls) + 에러 분류(`classify_http`/`classify_reqwest`).
//! bounded retry(`with_retry` + reqwest timeout). calendar/http.rs와 동일 패턴.
//!
//! send-only 스코프(`gmail.send`)라 읽기/getProfile/메시지 리스트 API가 전혀 없다(읽기 스코프 0,
//! PII 0). **이 모듈은 어떤 Gmail read 엔드포인트도 추가하지 않는다.** 발송 토큰은 게이트의
//! `access_token_for_cref`(통합 Google access token)가 공급한다.

use std::time::Duration;

use crate::retry::with_retry;

use super::{GmailError, GmailProvider};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// 쓰기(messages.send POST) 재시도 횟수 = 1(재시도 안 함). messages.send는 **멱등하지 않다** — 요청이
/// Gmail에 도달한 뒤 응답만 유실되면(transport drop=transient) 재시도가 **중복 발송**을 낸다(이메일은
/// 캘린더 중복보다 비대칭적으로 위험). 그래서 AI-origin 게이트 write(`send_message_once`)는 재시도 대신
/// 실패를 노출한다(calendar create_event_once / github WRITE_MAX_ATTEMPTS=1 선례, INVARIANT #5 정신).
const WRITE_MAX_ATTEMPTS: u32 = 1;

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
