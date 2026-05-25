//! 외부 뉴스 소스(HN/GeekNews/Lobsters) 통합 페치 백엔드.
//!
//! INVARIANT #1(결정 레일 자동화 금지): 뉴스는 표시만 — 큐/매트릭스에 자동 주입 절대 금지.
//! INVARIANT #5(bounded retry): fetcher.rs에서 페치 실패 시 최대 3회 지수 백오프 + jitter.
//! INVARIANT #7(SSOT 분리): 원본 SSOT=외부 사이트, SQLite=캐시(`fetched_at` 7일 만료).

pub mod fetcher;
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

/// HTTP 응답을 받아 status 분류 후 JSON으로 디코드한다.
///
/// 기본 `From<reqwest::Error>`(error.rs)는 timeout/connect만 Transient로 분류 →
/// 5xx/429는 Terminal로 떨어져 `errors.log`에 error 레벨 노이즈가 생긴다(follow-up #1).
/// `fetch_with_retry`는 `retryable`을 무시하고 항상 3회 시도하므로 동작은 정상이지만
/// 로그 위계가 잘못된다. 여기서 5xx + 429만 Transient로 명시 분류해 `warn` 레벨로 떨어뜨린다.
pub(crate) async fn http_json<T: serde::de::DeserializeOwned>(
    resp: Response,
    code_prefix: &str,
) -> Result<T, AppError> {
    let status = resp.status();
    if !status.is_success() {
        let body_snip = resp.text().await.unwrap_or_default();
        let snip: String = body_snip.chars().take(200).collect();
        let msg = format!("HTTP {status}: {snip}");
        if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
            return Err(AppError::transient(
                format!("{code_prefix}.http_{}", status.as_u16()),
                msg,
            ));
        }
        return Err(AppError::terminal(
            format!("{code_prefix}.http_{}", status.as_u16()),
            msg,
        ));
    }
    let value = resp.json::<T>().await?; // 기본 From<reqwest::Error> — JSON 디코드 실패는 Terminal
    Ok(value)
}

/// http_json의 bytes 변종(RSS 파싱 등 binary stream용). `bytes::Bytes`를 노출하지 않기 위해
/// `Vec<u8>`로 반환(직접 dep 추가 회피). 호출자는 `&[u8]`로 슬라이스해 사용.
pub(crate) async fn http_bytes(resp: Response, code_prefix: &str) -> Result<Vec<u8>, AppError> {
    let status = resp.status();
    if !status.is_success() {
        let body_snip = resp.text().await.unwrap_or_default();
        let snip: String = body_snip.chars().take(200).collect();
        let msg = format!("HTTP {status}: {snip}");
        if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
            return Err(AppError::transient(
                format!("{code_prefix}.http_{}", status.as_u16()),
                msg,
            ));
        }
        return Err(AppError::terminal(
            format!("{code_prefix}.http_{}", status.as_u16()),
            msg,
        ));
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
