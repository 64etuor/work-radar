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
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

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
