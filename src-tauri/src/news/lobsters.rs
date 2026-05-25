//! Lobsters hottest.json — title/url/comments_url/comment_count/created_at 모두 한 번에.

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use super::{http_json, NewsItem, NewsSource};
use crate::error::AppError;

const URL: &str = "https://lobste.rs/hottest.json";

#[derive(Deserialize)]
struct Story {
    short_id: String,
    title: String,
    url: String,
    comments_url: String,
    comment_count: u32,
    /// Lobsters는 ISO 8601 문자열(`2026-05-25T10:00:00.000-07:00`)을 그대로 보낸다.
    /// 우리는 NewsItem.posted_at도 문자열이라 파싱/재포맷 없이 그대로 통과.
    created_at: String,
}

pub struct LobstersSource;

#[async_trait]
impl NewsSource for LobstersSource {
    fn id(&self) -> &'static str {
        "lobsters"
    }
    fn label(&self) -> &'static str {
        "Lobsters"
    }
    fn category(&self) -> super::NewsCategory {
        super::NewsCategory::EnglishTech
    }

    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError> {
        let resp = client.get(URL).send().await?;
        let stories: Vec<Story> = http_json(resp, "lobsters").await?;

        Ok(stories
            .into_iter()
            .map(|s| NewsItem {
                source: "lobsters".into(),
                external_id: s.short_id,
                title: s.title,
                url: s.url,
                comments_url: Some(s.comments_url),
                comment_count: Some(s.comment_count),
                posted_at: s.created_at,
            })
            .collect())
    }
}
