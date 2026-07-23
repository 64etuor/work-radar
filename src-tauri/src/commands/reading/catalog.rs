//! 서지 카탈로그 검색 — 유일한 아웃바운드 표면(read-only, ADR-0013).
//!
//! Provider 우선순위(2026-07-23 사용자 결정 "한국 책이 먼저 나와야 — 구글 기본은 별로"):
//! 1. **Aladin TTB** (keychain에 TTB 키가 있을 때) — 국내 서지 최적.
//! 2. **Google Books** — 한글 쿼리는 `langRestrict=ko`로 한국어판 우선. 키리스 익명 쿼터가
//!    쉽게 고갈되므로(관측: 429 Queries-per-day) 429는 **terminal**로 분류해 즉시 다음
//!    폴백으로 넘어간다(ms 백오프 재시도는 일일 쿼터에 무의미 + 소진 가속).
//! 3. **Open Library** — 최종 폴백(영문 위주).
//!
//! 각 provider 안에서 쿼리 사다리(원문 → 공백 제거 → 앞쪽 절반 토큰)를 시도하고, 결과는
//! 커널 유사도 랭킹(정규화 매칭 + 한국어판 우선)으로 정렬한다 — 띄어쓰기/부제 차이에 강인.
//!
//! 고정 엔드포인트만(caller 입력은 검색어 텍스트뿐 — URL/host에 닿지 않음), timeout +
//! bounded retry(INVARIANT #5) + 응답 크기 상한. 로그는 상태코드+크기만(본문·TTB 키 금지).

#![allow(clippy::result_large_err)]

use std::time::Duration;

use crate::error::AppError;
use crate::keychain;
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

const ALADIN_SEARCH_URL: &str = "https://www.aladin.co.kr/ttb/api/ItemSearch.aspx";
const ALADIN_LOOKUP_URL: &str = "https://www.aladin.co.kr/ttb/api/ItemLookUp.aspx";
const GOOGLE_BOOKS_URL: &str = "https://www.googleapis.com/books/v1/volumes";
const OPEN_LIBRARY_URL: &str = "https://openlibrary.org/search.json";
const OPEN_LIBRARY_FIELDS: &str =
    "key,title,author_name,publisher,first_publish_year,isbn,number_of_pages_median,cover_i,language";

/// keychain 앱 전역 시크릿 이름 — 알라딘 TTB 키(설정 → 통합에서 등록).
pub(crate) const ALADIN_TTB_SECRET: &str = "aladin_ttb";

/// fetch 실패 분류 — 네트워크/5xx=재시도 가능. **429는 terminal**: 관측된 실패 모드가
/// "Queries per day" 일일 쿼터 고갈이라 짧은 백오프 재시도가 무의미하고 소진만 가속한다.
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

/// 단일 GET → 본문 텍스트. 상태/크기만 분류·로그(본문·쿼리스트링의 키 비노출).
async fn fetch_text(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, String)],
) -> Result<String, CatalogFetchError> {
    let resp = client.get(url).query(query).send().await.map_err(|e| {
        // reqwest 에러를 그대로 포맷하지 않는다 — URL(쿼리의 TTB 키 포함 가능)이 담긴다.
        let kind = if e.is_timeout() { "timeout" } else { "network" };
        CatalogFetchError::Transient(format!("catalog request failed ({kind})"))
    })?;
    let status = resp.status();
    if !status.is_success() {
        let msg = format!("catalog responded {}", status.as_u16());
        return if status.is_server_error() {
            Err(CatalogFetchError::Transient(msg))
        } else {
            // 429 포함 4xx — 키리스 일일 쿼터(429)는 재시도로 안 풀린다.
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

async fn fetch_with_retry(
    client: &reqwest::Client,
    url: &str,
    params: &[(&str, String)],
) -> Result<String, CatalogFetchError> {
    with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
        fetch_text(client, url, params)
    })
    .await
}

async fn fetch_aladin(
    client: &reqwest::Client,
    ttb_key: &str,
    q: &str,
    limit: u32,
    isbn: Option<&str>,
) -> Result<Vec<CatalogBook>, CatalogFetchError> {
    let common = [
        ("ttbkey", ttb_key.to_string()),
        ("output", "js".to_string()),
        ("Version", "20131101".to_string()),
        ("Cover", "Big".to_string()),
    ];
    let (url, mut params): (&str, Vec<(&str, String)>) = match isbn {
        // ISBN은 정밀 조회 API — 13자리는 ISBN13, 10자리는 ISBN 타입.
        Some(code) => (
            ALADIN_LOOKUP_URL,
            vec![
                (
                    "ItemIdType",
                    if code.len() == 13 { "ISBN13" } else { "ISBN" }.to_string(),
                ),
                ("ItemId", code.to_string()),
            ],
        ),
        None => (
            ALADIN_SEARCH_URL,
            vec![
                ("Query", q.to_string()),
                ("QueryType", "Keyword".to_string()),
                ("SearchTarget", "Book".to_string()),
                ("MaxResults", limit.to_string()),
                ("start", "1".to_string()),
            ],
        ),
    };
    params.extend(common);
    let body = fetch_with_retry(client, url, &params).await?;
    reading::parse_aladin(&body).map_err(CatalogFetchError::Terminal)
}

async fn fetch_google_books(
    client: &reqwest::Client,
    q: &str,
    limit: u32,
    korean: bool,
) -> Result<Vec<CatalogBook>, CatalogFetchError> {
    let mut params = vec![
        ("q", q.to_string()),
        ("maxResults", limit.to_string()),
        ("country", "KR".to_string()),
    ];
    if korean {
        // 한글 쿼리는 한국어판만 — "코스모스"에 영문판이 앞서는 문제의 직접 원인 제거.
        params.push(("langRestrict", "ko".to_string()));
    }
    let body = fetch_with_retry(client, GOOGLE_BOOKS_URL, &params).await?;
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
    let body = fetch_with_retry(client, OPEN_LIBRARY_URL, &params).await?;
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
    let isbn = reading::normalize_isbn(trimmed);
    let korean = reading::contains_hangul(trimmed);
    let variants = match &isbn {
        Some(code) => vec![code.clone()],
        None => reading::query_variants(trimmed),
    };

    let client = reqwest::Client::builder()
        .timeout(REQ_TIMEOUT)
        .user_agent("work-radar/reading-catalog")
        .build()
        .map_err(|e| AppError::unexpected("reading.catalog.client", e.to_string()))?;

    let mut last_err: Option<CatalogFetchError> = None;
    let mut any_provider_succeeded = false;

    // 1) Aladin — TTB 키가 등록돼 있으면 국내 서지 우선.
    if let Ok(Some(ttb_key)) = keychain::get_app_secret(ALADIN_TTB_SECRET) {
        for variant in &variants {
            match fetch_aladin(&client, &ttb_key, variant, limit, isbn.as_deref()).await {
                Ok(list) if !list.is_empty() => {
                    return Ok(reading::rank_catalog_results(trimmed, list));
                }
                Ok(_) => any_provider_succeeded = true,
                Err(e) => {
                    tracing::warn!(error = %e.message(), "aladin fetch failed; falling back");
                    last_err = Some(e);
                    break; // 키/쿼터 문제면 나머지 variant도 같은 실패 — 다음 provider로.
                }
            }
        }
    }

    // 2) Google Books — 한글 쿼리는 langRestrict=ko.
    for variant in &variants {
        match fetch_google_books(&client, variant, limit, korean).await {
            Ok(list) if !list.is_empty() => {
                return Ok(reading::rank_catalog_results(trimmed, list));
            }
            Ok(_) => any_provider_succeeded = true,
            Err(e) => {
                tracing::warn!(error = %e.message(), "google books fetch failed; falling back");
                last_err = Some(e);
                break;
            }
        }
    }

    // 3) Open Library — 최종 폴백(원문 쿼리만 — 영문 위주라 변형 사다리 무의미).
    match fetch_open_library(&client, isbn.as_deref().unwrap_or(trimmed), limit).await {
        Ok(list) => Ok(reading::rank_catalog_results(trimmed, list)),
        Err(ol_err) => {
            // 앞선 provider가 정상 0건이었다면 검색 자체는 성공 — 폴백 실패로 에러화하지 않는다.
            if any_provider_succeeded {
                tracing::warn!(error = %ol_err.message(), "open library fallback failed; returning empty");
                Ok(Vec::new())
            } else {
                Err(last_err.unwrap_or(ol_err).into_app_error())
            }
        }
    }
}

/// TTB 키 저장/해제 — 키는 입력으로만 받아 즉시 keychain 저장, 반환은 존재 여부뿐
/// (INVARIANT: 토큰 렌더러 미반환). 빈 문자열 = 해제.
pub(crate) fn set_aladin_ttb_key_inner(key: &str) -> Result<bool, AppError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        keychain::delete_app_secret(ALADIN_TTB_SECRET)?;
        return Ok(false);
    }
    if trimmed.chars().count() > 100 {
        return Err(AppError::validation(
            "reading.catalog.ttb_key",
            "key is too long",
        ));
    }
    keychain::set_app_secret(ALADIN_TTB_SECRET, trimmed)?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub async fn search_book_catalog(
    query: String,
    limit: Option<u32>,
) -> Result<Vec<CatalogBook>, AppError> {
    search_book_catalog_inner(&query, limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_aladin_ttb_key(key: String) -> Result<bool, AppError> {
    set_aladin_ttb_key_inner(&key)
}

#[tauri::command]
#[specta::specta]
pub async fn aladin_ttb_status() -> Result<bool, AppError> {
    Ok(keychain::has_app_secret(ALADIN_TTB_SECRET)?)
}

#[cfg(test)]
mod tests {
    /// 네트워크 없는 검증만 — 파싱/변형/랭킹은 `crate::reading` 커널 테스트가, 실 API
    /// 라운드트립은 사용자 라이브 스모크가 커버한다(plan §검증).
    #[tokio::test]
    async fn query_is_validated_before_any_network() {
        assert!(super::search_book_catalog_inner("   ", None).await.is_err());
        let too_long = "가".repeat(201);
        assert!(super::search_book_catalog_inner(&too_long, None)
            .await
            .is_err());
    }

    #[test]
    fn ttb_key_input_is_validated() {
        let too_long = "a".repeat(101);
        assert!(super::set_aladin_ttb_key_inner(&too_long).is_err());
    }
}
