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
use serde::Deserialize;
use tokio::task::JoinSet;

use super::{http_bytes, NewsCategory, NewsItem, NewsSource};
use crate::error::AppError;

const DEFAULT_TAKE: usize = 30;

/// 피드 title/summary는 종종 HTML 엔티티(`&amp;`, `&#39;`, `&#x27;`, 숫자 엔티티 등)를
/// 그대로 담고 있다. React는 escape만 하고 decode는 안 하므로 ingest 시 한 번 decode해
/// 저장 텍스트를 깨끗하게 만든다(렌더러가 아닌 ingest에서 1회). 이미 깨끗한 텍스트엔 no-op.
fn decode_entities(s: &str) -> String {
    html_escape::decode_html_entities(s).into_owned()
}

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
        let parser_id = self.id;
        let feed = tokio::task::spawn_blocking(move || {
            parser::parse(&bytes[..]).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| {
            AppError::unexpected(
                format!("rss.{parser_id}.parse_task"),
                format!("RSS parser task failed: {error}"),
            )
        })?
        .map_err(|e| AppError::transient(format!("rss.{}.parse", self.id), e.to_string()))?;
        let id = self.id;
        let items: Vec<NewsItem> = feed
            .entries
            .into_iter()
            .take(take)
            .filter_map(|e| {
                let title = decode_entities(&e.title.as_ref()?.content);
                let url = e.links.first()?.href.clone();
                let external_id = e.id.clone();
                // critic Critical: 둘 다 없으면 drop. Utc::now() 폴백 절대 금지.
                let posted_at = e.published.or(e.updated)?;
                let comments_url = extract_comments_url(&e);
                Some(NewsItem {
                    source: id.to_string(),
                    external_id,
                    title,
                    url,
                    comments_url,
                    comment_count: None,
                    posted_at: posted_at.to_rfc3339(),
                })
            })
            .collect();

        if id == "reddit_programming" {
            let mut set: JoinSet<NewsItem> = JoinSet::new();
            for item in items {
                let client = client.clone();
                set.spawn(async move { enrich_reddit_comment_count(client, item).await });
            }
            let mut out = Vec::with_capacity(take);
            while let Some(j) = set.join_next().await {
                match j {
                    Ok(item) => out.push(item),
                    Err(e) => tracing::warn!(error = %e, "reddit comment join error"),
                }
            }
            return Ok(out);
        }

        Ok(items)
    }
}

fn extract_comments_url(entry: &feed_rs::model::Entry) -> Option<String> {
    entry
        .links
        .iter()
        .find(|link| link.rel.as_deref() == Some("comments"))
        .map(|link| link.href.clone())
        .or_else(|| {
            entry
                .content
                .as_ref()
                .and_then(|c| c.body.as_deref())
                .and_then(extract_comments_href_from_html)
        })
        .or_else(|| {
            entry
                .summary
                .as_ref()
                .map(|s| s.content.as_str())
                .and_then(extract_comments_href_from_html)
        })
}

fn extract_comments_href_from_html(html: &str) -> Option<String> {
    let marker = "[comments]";
    let marker_pos = html.find(marker)?;
    let prefix = &html[..marker_pos];
    let href_pos = prefix.rfind("href=")?;
    let after = &prefix[href_pos + "href=".len()..];
    let mut chars = after.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = chars.as_str();
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

#[derive(Debug, Deserialize)]
struct RedditListing {
    data: RedditListingData,
}

#[derive(Debug, Deserialize)]
struct RedditListingData {
    children: Vec<RedditChild>,
}

#[derive(Debug, Deserialize)]
struct RedditChild {
    data: RedditPostData,
}

#[derive(Debug, Deserialize)]
struct RedditPostData {
    num_comments: u32,
}

async fn enrich_reddit_comment_count(client: Client, mut item: NewsItem) -> NewsItem {
    match fetch_reddit_comment_count(&client, &item.url).await {
        Ok(count) => item.comment_count = count,
        Err(e) => tracing::warn!(url = %item.url, error = %e, "reddit comment count skip"),
    }
    item
}

async fn fetch_reddit_comment_count(client: &Client, url: &str) -> Result<Option<u32>, AppError> {
    let api_url = format!("{url}.json?raw_json=1");
    let resp = client.get(api_url).send().await?;
    let posts: Vec<RedditListing> = super::http_json(resp, "reddit_programming.post").await?;
    Ok(posts
        .first()
        .and_then(|listing| listing.data.children.first())
        .map(|child| child.data.num_comments))
}

#[cfg(test)]
mod tests {
    use super::{
        decode_entities, extract_comments_href_from_html, RedditChild, RedditListing,
        RedditListingData, RedditPostData,
    };

    #[test]
    fn decode_entities_unescapes_named_and_numeric() {
        assert_eq!(
            decode_entities("Rust &amp; C &#39;23 &#x2014; &quot;hi&quot;"),
            "Rust & C '23 — \"hi\""
        );
    }

    #[test]
    fn decode_entities_is_noop_on_clean_text() {
        assert_eq!(decode_entities("plain text"), "plain text");
    }

    #[test]
    fn extracts_comments_href_from_inline_html() {
        let html = r#"<span><a href="https://example.com/comments/1">[comments]</a></span>"#;
        assert_eq!(
            extract_comments_href_from_html(html),
            Some("https://example.com/comments/1".into())
        );
    }

    #[test]
    fn reddit_listing_shape_matches_num_comments() {
        let listing = RedditListing {
            data: RedditListingData {
                children: vec![RedditChild {
                    data: RedditPostData { num_comments: 42 },
                }],
            },
        };
        assert_eq!(
            listing.data.children.first().map(|c| c.data.num_comments),
            Some(42)
        );
    }
}
