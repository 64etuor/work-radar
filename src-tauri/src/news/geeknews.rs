//! GeekNews(news.hada.io) RSS. feed-rs 통합 파서. 댓글 수는 RSS에 없음 → None.

use async_trait::async_trait;
use chrono::Utc;
use feed_rs::parser;
use reqwest::Client;

use super::{NewsItem, NewsSource};
use crate::error::AppError;

const RSS_URL: &str = "https://news.hada.io/rss/news";

pub struct GeekNewsSource;

#[async_trait]
impl NewsSource for GeekNewsSource {
    fn id(&self) -> &'static str {
        "geeknews"
    }
    fn label(&self) -> &'static str {
        "GeekNews"
    }

    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError> {
        let bytes = client.get(RSS_URL).send().await?.bytes().await?;
        let feed = parser::parse(&bytes[..])
            .map_err(|e| AppError::transient("news.parse.geeknews", e.to_string()))?;

        Ok(feed
            .entries
            .into_iter()
            .filter_map(|e| {
                let title = e.title.as_ref()?.content.clone();
                let url = e.links.first()?.href.clone();
                let external_id = e.id.clone();
                let posted_at = e.published.or(e.updated).unwrap_or_else(Utc::now);
                Some(NewsItem {
                    source: "geeknews".into(),
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
