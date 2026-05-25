//! 일반 RSS/Atom 소스 어댑터. `feed-rs`로 통합 파싱. NewsCategory + 선택 헤더 지원.
//!
//! 정책(critic feedback 반영):
//! - `published`/`updated` 둘 다 없는 entry는 **drop**(Utc::now() 폴백 금지 — 영원히
//!   top 차지 회귀 방지).
//! - per-source `TAKE` 캡(default 30) — arXiv처럼 한 번에 100+ 보내는 소스가 DB와
//!   ticker를 독점하지 못하게.
//! - `headers`로 Reddit 같이 UA 강제하는 소스만 override(보안: build-time 상수만).

use async_trait::async_trait;
use feed_rs::parser;
use reqwest::{header::HeaderMap, header::HeaderName, header::HeaderValue, Client};

use super::{http_bytes, NewsCategory, NewsItem, NewsSource};
use crate::error::AppError;

const DEFAULT_TAKE: usize = 30;

pub struct GenericRssSource {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    pub category: NewsCategory,
    /// Optional per-source HTTP headers (예: Reddit UA override). build-time 상수 only.
    pub headers: &'static [(&'static str, &'static str)],
    /// 한 페치당 take 최대. 0이면 DEFAULT_TAKE.
    pub take: usize,
}

#[async_trait]
impl NewsSource for GenericRssSource {
    fn id(&self) -> &'static str {
        self.id
    }
    fn label(&self) -> &'static str {
        self.label
    }
    fn category(&self) -> NewsCategory {
        self.category
    }

    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError> {
        let take = if self.take == 0 {
            DEFAULT_TAKE
        } else {
            self.take
        };
        let mut req = client.get(self.url);
        if !self.headers.is_empty() {
            let mut map = HeaderMap::with_capacity(self.headers.len());
            for (k, v) in self.headers {
                // 정적 상수 → unwrap OK(컴파일 시 검증). 실패는 burnt-in 버그.
                let name = HeaderName::from_static(k);
                let value = HeaderValue::from_static(v);
                map.insert(name, value);
            }
            req = req.headers(map);
        }
        let resp = req.send().await?;
        let bytes = http_bytes(resp, &format!("rss.{}", self.id)).await?;
        let feed = parser::parse(&bytes[..])
            .map_err(|e| AppError::transient(format!("rss.{}.parse", self.id), e.to_string()))?;
        let id = self.id;
        Ok(feed
            .entries
            .into_iter()
            .take(take)
            .filter_map(|e| {
                let title = e.title.as_ref()?.content.clone();
                let url = e.links.first()?.href.clone();
                let external_id = e.id.clone();
                // critic Critical: 둘 다 없으면 drop. Utc::now() 폴백 절대 금지.
                let posted_at = e.published.or(e.updated)?;
                Some(NewsItem {
                    source: id.to_string(),
                    external_id,
                    title,
                    url,
                    comments_url: None,
                    comment_count: None,
                    posted_at: posted_at.to_rfc3339(),
                })
            })
            .collect())
    }
}
