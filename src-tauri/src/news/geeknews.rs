//! GeekNews(news.hada.io) Atom feed + topic detail enrichment.
//!
//! Atom feed에는 댓글 수가 없지만 topic detail HTML에는
//! `data-topic-comment-count='N'`가 있어 bounded per-item enrichment로 채운다.

use async_trait::async_trait;
use chrono::Utc;
use feed_rs::parser;
use reqwest::{header::USER_AGENT, Client};
use tokio::task::JoinSet;

use super::{http_bytes, NewsItem, NewsSource};
use crate::error::AppError;

const RSS_URL: &str = "https://news.hada.io/rss/news";
const TAKE: usize = 30;
const TOPIC_USER_AGENT: &str = "Mozilla/5.0 WorkRadar/0.1";

pub struct GeekNewsSource;

#[async_trait]
impl NewsSource for GeekNewsSource {
    fn id(&self) -> &'static str {
        "geeknews"
    }
    fn label(&self) -> &'static str {
        "GeekNews"
    }
    fn category(&self) -> super::NewsCategory {
        super::NewsCategory::KoreanTech
    }

    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError> {
        let resp = client.get(RSS_URL).send().await?;
        let bytes = http_bytes(resp, "geeknews").await?;
        let feed = parser::parse(&bytes[..])
            .map_err(|e| AppError::transient("news.parse.geeknews", e.to_string()))?;

        let items: Vec<NewsItem> = feed
            .entries
            .into_iter()
            .take(TAKE)
            .filter_map(|e| {
                let title = e.title.as_ref()?.content.clone();
                let url = e.links.first()?.href.clone();
                let external_id = e.id.clone();
                let posted_at = e.published.or(e.updated).unwrap_or_else(Utc::now);
                Some(NewsItem {
                    source: "geeknews".into(),
                    external_id,
                    title,
                    comments_url: Some(url.clone()),
                    url,
                    comment_count: None,
                    posted_at: posted_at.to_rfc3339(),
                })
            })
            .collect();

        let mut set: JoinSet<NewsItem> = JoinSet::new();
        for item in items {
            let client = client.clone();
            set.spawn(async move { enrich_comment_count(client, item).await });
        }

        let mut out = Vec::with_capacity(TAKE);
        while let Some(j) = set.join_next().await {
            match j {
                Ok(item) => out.push(item),
                Err(e) => tracing::warn!(error = %e, "GeekNews topic join error"),
            }
        }
        Ok(out)
    }
}

async fn enrich_comment_count(client: Client, mut item: NewsItem) -> NewsItem {
    match fetch_comment_count(&client, &item.url).await {
        Ok(count) => item.comment_count = count,
        Err(e) => tracing::warn!(url = %item.url, error = %e, "GeekNews comment count skip"),
    }
    item
}

async fn fetch_comment_count(client: &Client, url: &str) -> Result<Option<u32>, AppError> {
    let resp = client
        .get(url)
        .header(USER_AGENT, TOPIC_USER_AGENT)
        .send()
        .await?;
    let bytes = http_bytes(resp, "geeknews.topic").await?;
    let html = String::from_utf8_lossy(&bytes);
    Ok(parse_comment_count(&html))
}

fn parse_comment_count(html: &str) -> Option<u32> {
    parse_attr_u32(html, "data-topic-comment-count")
        .or_else(|| parse_jsonish_u32(html, "\"commentCount\""))
}

fn parse_attr_u32(html: &str, attr: &str) -> Option<u32> {
    let rest = html.split_once(attr)?.1.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let value: String = chars.take_while(|c| *c != quote).collect();
    value.parse().ok()
}

fn parse_jsonish_u32(html: &str, key: &str) -> Option<u32> {
    let rest = html.split_once(key)?.1.trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use reqwest::Client;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    use super::{fetch_comment_count, parse_comment_count};

    #[test]
    fn parses_comment_count_from_topic_link_attr() {
        let html = "<a data-topic-comment-count='12' href='topic?id=1'>댓글 12개</a>";
        assert_eq!(parse_comment_count(html), Some(12));
    }

    #[test]
    fn parses_comment_count_from_double_quoted_attr() {
        let html = r#"<a data-topic-comment-count="3">댓글 3개</a>"#;
        assert_eq!(parse_comment_count(html), Some(3));
    }

    #[test]
    fn parses_comment_count_from_json_ld_fallback() {
        let html = r#"<script>{"commentCount": 7}</script>"#;
        assert_eq!(parse_comment_count(html), Some(7));
    }

    #[tokio::test]
    async fn topic_request_uses_browser_compatible_work_radar_user_agent() {
        let listener = match TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) => panic!("bind test listener: {error}"),
        };
        let address = match listener.local_addr() {
            Ok(address) => address,
            Err(error) => panic!("read test listener address: {error}"),
        };
        let server = tokio::spawn(async move {
            let (mut stream, _) = match listener.accept().await {
                Ok(connection) => connection,
                Err(error) => panic!("accept test request: {error}"),
            };
            let mut request = [0_u8; 4096];
            let size = match stream.read(&mut request).await {
                Ok(size) => size,
                Err(error) => panic!("read test request: {error}"),
            };
            let request = String::from_utf8_lossy(&request[..size]);
            let allowed = request
                .lines()
                .any(|line| line.eq_ignore_ascii_case("user-agent: Mozilla/5.0 WorkRadar/0.1"));
            let (status, body) = if allowed {
                ("200 OK", "<a data-topic-comment-count='12'>댓글 12개</a>")
            } else {
                ("403 Forbidden", "forbidden")
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            if let Err(error) = stream.write_all(response.as_bytes()).await {
                panic!("write test response: {error}");
            }
        });

        let client = match Client::builder()
            .user_agent("work-radar/news-fetcher")
            .build()
        {
            Ok(client) => client,
            Err(error) => panic!("build test client: {error}"),
        };
        let result = fetch_comment_count(&client, &format!("http://{address}/topic?id=1")).await;
        if let Err(error) = server.await {
            panic!("join test server: {error}");
        }

        match result {
            Ok(count) => assert_eq!(count, Some(12)),
            Err(error) => panic!("topic request was rejected: {error}"),
        }
    }
}
