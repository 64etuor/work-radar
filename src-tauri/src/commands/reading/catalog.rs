//! 서지 카탈로그 검색 — 유일한 아웃바운드 표면(read-only, ADR-0013).
//!
//! Google Books(기본, 키 불요) → 결과 0건/실패 시 Open Library 폴백. 고정 엔드포인트만
//! (caller 입력은 검색어 텍스트뿐 — URL/host에 닿지 않음), timeout + bounded retry
//! (INVARIANT #5) + 응답 크기 상한. 로그는 상태코드+크기만(응답 본문 금지 — ipc-conventions).

#![allow(clippy::result_large_err)]

use std::time::Duration;

use crate::error::AppError;
use crate::models::CatalogBook;
use crate::reading;
use crate::retry::{with_retry, Retryable};

const REQ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;
const BASE_DELAY: Duration = Duration::from_millis(300);
/// 응답 크기 상한(2MB) — 카탈로그 JSON은 수십 KB 스케일이라 넉넉한 방어선.
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const QUERY_MAX_CHARS: usize = 200;
const DEFAULT_LIMIT: u32 = 20;
const MAX_LIMIT: u32 = 40;

const GOOGLE_BOOKS_URL: &str = "https://www.googleapis.com/books/v1/volumes";
const OPEN_LIBRARY_URL: &str = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_FIELDS: &str =
    "key,title,author_name,publisher,first_publish_year,isbn,number_of_pages_median,cover_i,language";

/// fetch 실패 분류 — 네트워크/5xx/429=재시도 가능, 그 외 4xx/파싱=terminal.
#[derive(Debug)]
enum CatalogFetchError {
    Transient(String),
    Terminal(String),
}

impl Retryable for CatalogFetchError {
    fn is_retryable(&self) -> bool {
        matches!(self, CatalogFetchError::Transient(_))
    }
}

impl CatalogFetchError {
    fn message(&self) -> &str {
        match self {
            CatalogFetchError::Transient(m) | CatalogFetchError::Terminal(m) => m,
        }
    }

    fn into_app_error(self) -> AppError {
        match self {
            CatalogFetchError::Transient(m) => AppError::transient("reading.catalog.fetch", m),
            CatalogFetchError::Terminal(m) => AppError::terminal("reading.catalog.fetch", m),
        }
    }
}

/// 단일 GET → 본문 텍스트. 상태/크기만 분류·로그(본문 비노출).
async fn fetch_text(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, String)],
) -> Result<String, CatalogFetchError> {
    let resp = client.get(url).query(query).send().await.map_err(|e| {
        // reqwest 에러 메시지는 URL만 담는다(본문/토큰 없음) — 그래도 종류만 남긴다.
        let kind = if e.is_timeout() { "timeout" } else { "network" };
        CatalogFetchError::Transient(format!("catalog request failed ({kind})"))
    })?;
    let status = resp.status();
    if !status.is_success() {
        let msg = format!("catalog responded {}", status.as_u16());
        return if status.as_u16() == 429 || status.is_server_error() {
            Err(CatalogFetchError::Transient(msg))
        } else {
            Err(CatalogFetchError::Terminal(msg))
        };
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|_| CatalogFetchError::Transient("catalog body read failed".into()))?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(CatalogFetchError::Terminal(format!(
            "catalog response too large ({}B)",
            bytes.len()
        )));
    }
    String::from_utf8(bytes.to_vec())
        .map_err(|_| CatalogFetchError::Terminal("catalog response not utf-8".into()))
}

async fn fetch_google_books(
    client: &reqwest::Client,
    q: &str,
    limit: u32,
) -> Result<Vec<CatalogBook>, CatalogFetchError> {
    let params = [("q", q.to_string()), ("maxResults", limit.to_string())];
    let body = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
        fetch_text(client, GOOGLE_BOOKS_URL, &params)
    })
    .await?;
    reading::parse_google_books(&body)
        .map_err(|_| CatalogFetchError::Terminal("google books parse failed".into()))
}

async fn fetch_open_library(
    client: &reqwest::Client,
    q: &str,
    limit: u32,
) -> Result<Vec<CatalogBook>, CatalogFetchError> {
    let params = [
        ("q", q.to_string()),
        ("limit", limit.to_string()),
        ("fields", OPEN_LIBRARY_FIELDS.to_string()),
    ];
    let body = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
        fetch_text(client, OPEN_LIBRARY_URL, &params)
    })
    .await?;
    reading::parse_open_library(&body)
        .map_err(|_| CatalogFetchError::Terminal("open library parse failed".into()))
}

pub(crate) async fn search_book_catalog_inner(
    query: &str,
    limit: Option<u32>,
) -> Result<Vec<CatalogBook>, AppError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(AppError::validation(
            "reading.catalog.query",
            "query is required",
        ));
    }
    if trimmed.chars().count() > QUERY_MAX_CHARS {
        return Err(AppError::validation(
            "reading.catalog.query",
            format!("query exceeds {QUERY_MAX_CHARS} characters"),
        ));
    }
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);

    // ISBN이면 정밀 조회 쿼리로 전환(Google `isbn:` 연산자 / OL은 원문 그대로도 매칭).
    let isbn = reading::normalize_isbn(trimmed);
    let google_q = match &isbn {
        Some(code) => format!("isbn:{code}"),
        None => trimmed.to_string(),
    };
    let ol_q = isbn.clone().unwrap_or_else(|| trimmed.to_string());

    let client = reqwest::Client::builder()
        .timeout(REQ_TIMEOUT)
        .user_agent("work-radar/reading-catalog")
        .build()
        .map_err(|e| AppError::unexpected("reading.catalog.client", e.to_string()))?;

    let google_err = match fetch_google_books(&client, &google_q, limit).await {
        Ok(list) if !list.is_empty() => return Ok(list),
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(error = %e.message(), "google books fetch failed; trying open library");
            Some(e)
        }
    };

    match fetch_open_library(&client, &ol_q, limit).await {
        Ok(list) => Ok(list),
        Err(ol_err) => match google_err {
            // Google이 정상 0건이었다면 검색 자체는 성공 — 폴백 실패로 에러화하지 않는다.
            None => {
                tracing::warn!(error = %ol_err.message(), "open library fallback failed; returning empty");
                Ok(Vec::new())
            }
            Some(google_err) => Err(google_err.into_app_error()),
        },
    }
}

#[tauri::command]
#[specta::specta]
pub async fn search_book_catalog(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<CatalogBook>, AppError> {
    search_book_catalog_inner(&query, limit).await
}

#[cfg(test)]
mod tests {
    /// 네트워크 없는 검증만 — 파싱은 `crate::reading` 커널 테스트가, 실 API 라운드트립은
    /// 사용자 라이브 스모크가 커버한다(plan §검증).
    #[tokio::test]
    async fn query_is_validated_before_any_network() {
        assert!(super::search_book_catalog_inner("   ", None).await.is_err());
        let too_long = "가".repeat(201);
        assert!(super::search_book_catalog_inner(&too_long, None)
            .await
            .is_err());
    }
}
