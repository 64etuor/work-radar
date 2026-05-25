//! 외부 뉴스 소스(HN/GeekNews/Lobsters) 통합 페치 백엔드.
//!
//! INVARIANT #1(결정 레일 자동화 금지): 뉴스는 표시만 — 큐/매트릭스에 자동 주입 절대 금지.
//! INVARIANT #5(bounded retry): fetcher.rs에서 페치 실패 시 최대 3회 지수 백오프 + jitter.
//! INVARIANT #7(SSOT 분리): 원본 SSOT=외부 사이트, SQLite=캐시(`fetched_at` 7일 만료).

pub mod fetcher;
pub mod filter_store;
pub mod geeknews;
pub mod hn;
pub mod lobsters;
pub mod pref_store;
pub mod store;

use async_trait::async_trait;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

/// 비-2xx HTTP status + (잘린) 응답 본문을 AppError로 분류한다.
///
/// 정책: 5xx + 429만 Transient(retryable, warn 레벨), 나머지 비-2xx는 Terminal(error 레벨).
/// 기본 `From<reqwest::Error>`(error.rs)는 timeout/connect만 Transient라 5xx 응답이
/// Terminal로 떨어져 `errors.log`에 노이즈를 만들었음(follow-up #1). 이 함수는 순수 — HTTP
/// I/O 없이 분기 로직만 담당해 단위 테스트 가능.
fn classify_http_status(status: StatusCode, code_prefix: &str, body_snip: &str) -> AppError {
    let snip: String = body_snip.chars().take(200).collect();
    let msg = format!("HTTP {status}: {snip}");
    let code = format!("{code_prefix}.http_{}", status.as_u16());
    if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
        AppError::transient(code, msg)
    } else {
        AppError::terminal(code, msg)
    }
}

/// HTTP 응답을 받아 status 분류 후 JSON으로 디코드한다. 비-2xx면 본문 200자까지
/// 잘라 `classify_http_status`로 분류, 2xx면 reqwest의 기본 `From<reqwest::Error>`로
/// JSON 디코드 실패를 Terminal로 처리.
pub(crate) async fn http_json<T: serde::de::DeserializeOwned>(
    resp: Response,
    code_prefix: &str,
) -> Result<T, AppError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_http_status(status, code_prefix, &body));
    }
    let value = resp.json::<T>().await?;
    Ok(value)
}

/// http_json의 bytes 변종(RSS 파싱 등 binary stream용). `bytes::Bytes`를 노출하지 않기 위해
/// `Vec<u8>`로 반환(직접 dep 추가 회피). 호출자는 `&[u8]`로 슬라이스해 사용.
pub(crate) async fn http_bytes(resp: Response, code_prefix: &str) -> Result<Vec<u8>, AppError> {
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(classify_http_status(status, code_prefix, &body));
    }
    Ok(resp.bytes().await?.to_vec())
}

/// 정규화된 뉴스 아이템 — 모든 소스가 이 형태로 반환.
/// `posted_at`은 RFC3339 문자열(코드베이스 patterns: IPC 타입은 chrono 노출 없이 문자열).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    /// 소스 id (예: "hn", "geeknews", "lobsters"). registry id와 동일.
    pub source: String,
    /// 소스 내 안정적 id (HN: story id, RSS: guid).
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub comments_url: Option<String>,
    pub comment_count: Option<u32>,
    /// RFC3339 (e.g. `2026-05-25T10:00:00+00:00`).
    pub posted_at: String,
}

/// 소스 메타 정보 — IPC `news_sources_available`이 반환.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsSourceMeta {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[async_trait]
pub trait NewsSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// 페치. 실패는 AppError로 — 호출자(fetcher.rs)가 retry 결정.
    /// 네트워크 실패는 transient(retryable)로 마크해 fetcher가 backoff 후 재시도하게 한다.
    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError>;
}

/// 컴파일 시 고정 — 새 소스 추가 = 한 줄.
pub fn registry() -> Vec<Box<dyn NewsSource>> {
    vec![
        Box::new(hn::HnSource),
        Box::new(geeknews::GeekNewsSource),
        Box::new(lobsters::LobstersSource),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    // classify_http_status 단위 테스트 — http_json/http_bytes 두 helper의 핵심 정책 보호.
    // (이 분기 로직이 회귀하면 `errors.log` 노이즈가 다시 들어와도 정적 게이트가 못 잡음.)

    #[test]
    fn classify_5xx_is_transient_warn() {
        let e = classify_http_status(StatusCode::INTERNAL_SERVER_ERROR, "hn.top", "oops");
        assert_eq!(e.kind, ErrorKind::Transient, "5xx은 Transient(retry+warn)");
        assert!(e.retryable);
        assert_eq!(e.code, "hn.top.http_500");
        assert!(e.message.contains("HTTP 500"));
        assert!(e.message.contains("oops"));
    }

    #[test]
    fn classify_503_is_transient() {
        let e = classify_http_status(StatusCode::SERVICE_UNAVAILABLE, "geeknews", "");
        assert_eq!(e.kind, ErrorKind::Transient);
        assert_eq!(e.code, "geeknews.http_503");
    }

    #[test]
    fn classify_429_is_transient() {
        let e = classify_http_status(StatusCode::TOO_MANY_REQUESTS, "lobsters", "rate limited");
        assert_eq!(e.kind, ErrorKind::Transient, "429는 명시적으로 Transient");
        assert!(e.retryable);
        assert_eq!(e.code, "lobsters.http_429");
    }

    #[test]
    fn classify_404_is_terminal_not_retryable() {
        let e = classify_http_status(StatusCode::NOT_FOUND, "hn.item", "not found");
        assert_eq!(e.kind, ErrorKind::Terminal, "4xx(429 제외)는 Terminal");
        assert!(!e.retryable);
        assert_eq!(e.code, "hn.item.http_404");
    }

    #[test]
    fn classify_400_is_terminal() {
        let e = classify_http_status(StatusCode::BAD_REQUEST, "hn.top", "bad");
        assert_eq!(e.kind, ErrorKind::Terminal);
        assert_eq!(e.code, "hn.top.http_400");
    }

    #[test]
    fn classify_403_is_terminal() {
        let e = classify_http_status(StatusCode::FORBIDDEN, "geeknews", "");
        assert_eq!(e.kind, ErrorKind::Terminal);
        assert_eq!(e.code, "geeknews.http_403");
    }

    #[test]
    fn classify_truncates_body_to_200_chars() {
        let body = "x".repeat(500);
        let e = classify_http_status(StatusCode::INTERNAL_SERVER_ERROR, "hn", &body);
        // "HTTP 500 Internal Server Error: " 접두 + 잘린 본문.
        let snip_start = e
            .message
            .find(": ")
            .expect("colon-space in HTTP error message")
            + 2;
        let snip = &e.message[snip_start..];
        assert_eq!(snip.len(), 200, "본문은 200자로 잘림");
    }

    #[test]
    fn classify_handles_multibyte_safely() {
        // chars().take(200)은 grapheme이 아니라 char 단위지만 UTF-8 경계는 안전.
        let body = "가".repeat(300); // 각 '가'는 3바이트
        let e = classify_http_status(StatusCode::INTERNAL_SERVER_ERROR, "geeknews", &body);
        // 패닉 없이 끝나면 OK + 메시지 길이가 비어있지 않음.
        assert!(e.message.contains("HTTP 500"));
    }
}
