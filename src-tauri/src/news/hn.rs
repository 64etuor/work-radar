//! Hacker News (Firebase v0). 무인증, JSON, top stories 30건 병렬 페치.

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;
use tokio::task::JoinSet;

use super::{http_json, NewsItem, NewsSource};
use crate::error::AppError;

const TOP_URL: &str = "https://hacker-news.firebaseio.com/v0/topstories.json";
const ITEM_URL: &str = "https://hacker-news.firebaseio.com/v0/item";
const TAKE: usize = 30;

#[derive(Deserialize)]
struct Item {
    id: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    descendants: Option<u32>,
    /// Unix seconds.
    #[serde(default)]
    time: Option<i64>,
    /// "story" / "comment" / ...
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

pub struct HnSource;

#[async_trait]
impl NewsSource for HnSource {
    fn id(&self) -> &'static str {
        "hn"
    }
    fn label(&self) -> &'static str {
        "Hacker News"
    }

    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError> {
        let resp = client.get(TOP_URL).send().await?;
        let ids: Vec<u64> = http_json(resp, "hn.top").await?;

        let mut set: JoinSet<Result<Option<NewsItem>, AppError>> = JoinSet::new();
        for id in ids.into_iter().take(TAKE) {
            let client = client.clone();
            set.spawn(async move {
                let resp = client.get(format!("{ITEM_URL}/{id}.json")).send().await?;
                let item: Item = http_json(resp, "hn.item").await?;
                Ok(item_to_news(item))
            });
        }

        let mut out = Vec::with_capacity(TAKE);
        while let Some(j) = set.join_next().await {
            match j {
                Ok(Ok(Some(n))) => out.push(n),
                Ok(Ok(None)) => {}
                Ok(Err(e)) => tracing::warn!(error = %e, "HN item skip"),
                Err(e) => tracing::warn!(error = %e, "HN join error"),
            }
        }
        Ok(out)
    }
}

fn item_to_news(it: Item) -> Option<NewsItem> {
    if it.kind.as_deref() != Some("story") {
        return None;
    }
    let title = it.title?;
    let url = it
        .url
        .unwrap_or_else(|| format!("https://news.ycombinator.com/item?id={}", it.id));
    let posted_at: DateTime<Utc> = it
        .time
        .and_then(|t| Utc.timestamp_opt(t, 0).single())
        .unwrap_or_else(Utc::now);
    Some(NewsItem {
        source: "hn".into(),
        external_id: it.id.to_string(),
        title,
        url,
        comments_url: Some(format!("https://news.ycombinator.com/item?id={}", it.id)),
        comment_count: it.descendants,
        posted_at: posted_at.to_rfc3339(),
    })
}
