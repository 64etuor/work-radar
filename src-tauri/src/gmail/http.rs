//! 실 HTTP provider (reqwest, rustls) + 에러 분류(`classify_http`/`classify_reqwest`).
//! bounded retry(`with_retry` + reqwest timeout). calendar/http.rs와 동일 패턴.
//!
//! 발송/읽기 토큰은 게이트와 ingest 경로의 `access_token_for_cref`(통합 Google access token)가 공급한다.

use std::time::Duration;

use crate::retry::with_retry;

use super::{
    GmailError, GmailMessageSearch, GmailProvider, GmailReadProvider, GmailReceiptCandidate,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
const READ_MAX_ATTEMPTS: u32 = 3;
/// 쓰기(messages.send POST) 재시도 횟수 = 1(재시도 안 함). messages.send는 **멱등하지 않다** — 요청이
/// Gmail에 도달한 뒤 응답만 유실되면(transport drop=transient) 재시도가 **중복 발송**을 낸다(이메일은
/// 캘린더 중복보다 비대칭적으로 위험). 그래서 AI-origin 게이트 write(`send_message_once`)는 재시도 대신
/// 실패를 노출한다(calendar create_event_once / github WRITE_MAX_ATTEMPTS=1 선례, INVARIANT #5 정신).
const WRITE_MAX_ATTEMPTS: u32 = 1;

const SEND_ENDPOINT: &str = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const LABELS_ENDPOINT: &str = "https://gmail.googleapis.com/gmail/v1/users/me/labels";
const MESSAGES_ENDPOINT: &str = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

// ── 에러 분류 + bounded retry (calendar/http.rs와 동일 패턴) ──────────────────────────

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
pub(super) fn classify_http(status: u16, body: &str) -> GmailError {
    // 외부 응답 본문은 사용자 콘텐츠/PII 가능(send 4xx의 수신자 echo 등) → 메시지·로그에 내용을
    // 넣지 않는다(스펙 §5.5). 크기만 노출.
    let body_len = body.len();
    if status == 403 {
        GmailError::ReconnectRequired(
            "Gmail 영수증 권한이 필요합니다. 설정 > Google 계정에서 권한을 갱신하세요".into(),
        )
    } else if status == 429 || status >= 500 {
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

    async fn get_json(
        &self,
        url: &str,
        access_token: &str,
        query: &[(&str, String)],
    ) -> Result<serde_json::Value, GmailError> {
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
        serde_json::from_str(&body).map_err(|e| GmailError::Terminal(format!("gmail parse: {e}")))
    }

    async fn get_labels(
        &self,
        access_token: &str,
    ) -> Result<Vec<super::GmailLabelInfo>, GmailError> {
        let no_query: [(&str, String); 0] = [];
        let json = self
            .get_json(LABELS_ENDPOINT, access_token, &no_query)
            .await?;
        Ok(super::read::parse_labels(&json))
    }

    async fn get_message_ids(
        &self,
        access_token: &str,
        search: &GmailMessageSearch,
    ) -> Result<Vec<String>, GmailError> {
        // Paginate through nextPageToken so a tick can't silently drop in-window messages older than
        // one page. Bounded by MAX_PAGES/MAX_TOTAL so this can never become an unbounded fetch.
        const MAX_PAGES: usize = 20;
        const MAX_TOTAL: usize = 1000;
        let per_page = search.max_results.clamp(1, 500).to_string();
        let mut ids: Vec<String> = Vec::new();
        let mut page_token: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut query = vec![
                ("maxResults", per_page.clone()),
                ("includeSpamTrash", "false".to_string()),
            ];
            if let Some(q) = search.query.as_deref().filter(|q| !q.trim().is_empty()) {
                query.push(("q", q.trim().to_string()));
            }
            for id in &search.label_ids {
                query.push(("labelIds", id.clone()));
            }
            if let Some(token) = &page_token {
                query.push(("pageToken", token.clone()));
            }
            let json = self
                .get_json(MESSAGES_ENDPOINT, access_token, &query)
                .await?;
            ids.extend(super::read::parse_message_ids(&json));
            if ids.len() >= MAX_TOTAL {
                ids.truncate(MAX_TOTAL);
                break;
            }
            match super::read::parse_next_page_token(&json) {
                Some(token) => page_token = Some(token),
                None => break,
            }
        }
        Ok(ids)
    }

    async fn get_message(
        &self,
        access_token: &str,
        message_id: &str,
    ) -> Result<GmailReceiptCandidate, GmailError> {
        let url = format!("{MESSAGES_ENDPOINT}/{}", encode_path_segment(message_id));
        let query = [("format", "full".to_string())];
        let json = self.get_json(&url, access_token, &query).await?;
        super::read::parse_receipt_candidate(message_id, &json)
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

impl GmailReadProvider for HttpGmailProvider {
    async fn list_labels(
        &self,
        access_token: &str,
    ) -> Result<Vec<super::GmailLabelInfo>, GmailError> {
        with_retry(READ_MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.get_labels(access_token)
        })
        .await
    }

    async fn list_message_ids(
        &self,
        access_token: &str,
        search: &GmailMessageSearch,
    ) -> Result<Vec<String>, GmailError> {
        with_retry(READ_MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.get_message_ids(access_token, search)
        })
        .await
    }

    async fn get_receipt_candidate(
        &self,
        access_token: &str,
        message_id: &str,
    ) -> Result<GmailReceiptCandidate, GmailError> {
        with_retry(READ_MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.get_message(access_token, message_id)
        })
        .await
    }
}

fn encode_path_segment(s: &str) -> String {
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
        let GmailError::ReconnectRequired(message) = classify_http(403, "scope") else {
            panic!("403 → ReconnectRequired");
        };
        assert!(message.contains("설정 > Google 계정"));
        assert!(!message.contains("재동의"));
        assert!(!message.contains("다시 연결"));
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
