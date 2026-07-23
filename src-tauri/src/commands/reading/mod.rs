//! Reading 도메인 IPC 글루 (docs/plans/2026-07-23-reading-domain.md).
//!
//! 파싱/정규화/스트릭은 `crate::reading` 커널(순수) — 여기는 검증 + SQL + 외부 카탈로그
//! fetch 글루만. 로컬 SQLite 기록 전용 도메인: 외부 mutate 없음 → Acceptance 게이트
//! 비대상(INVARIANT #2 예외). 카탈로그 검색만 read-only 아웃바운드(ADR-0013).

#![allow(clippy::result_large_err)]

pub mod books;
pub mod catalog;
pub mod quotes;
pub mod sessions;
pub mod stats;

pub use books::*;
pub use catalog::*;
pub use quotes::*;
pub use sessions::*;
pub use stats::*;

use crate::error::AppError;
use crate::models::{Book, ReadingStatus};

/// 32자 lower-hex id — diet 선례와 동일(멀티-statement에서 Rust가 id를 미리 알아야 함).
pub(crate) fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub(crate) fn clean_required(
    raw: &str,
    code: &'static str,
    label: &'static str,
) -> Result<String, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::validation(code, format!("{label} is required")));
    }
    Ok(value.to_string())
}

pub(crate) fn clean_optional(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

pub(crate) fn validate_date(raw: &str, code: &'static str) -> Result<chrono::NaiveDate, AppError> {
    chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::validation(code, "date must be YYYY-MM-DD"))
}

/// rating 0..10 (옵시디언 my_rate 호환). NaN/음수/10 초과 거부.
pub(crate) fn validate_rating(value: f64) -> Result<f64, AppError> {
    if !value.is_finite() || !(0.0..=10.0).contains(&value) {
        return Err(AppError::validation(
            "reading.rating",
            "rating must be between 0 and 10",
        ));
    }
    Ok(value)
}

pub(crate) fn validate_non_negative_i32(value: i32, code: &'static str) -> Result<i32, AppError> {
    if value < 0 {
        return Err(AppError::validation(code, "value must be >= 0"));
    }
    Ok(value)
}

/// books 테이블 SELECT 컬럼 정본(books.rs/stats.rs 공유).
pub(crate) const BOOK_COLS: &str = "id, title, subtitle, authors, publisher, published_date, \
     isbn13, isbn10, page_count, cover_url, description, categories, language, source, \
     source_ref, status, rating, review, started_on, finished_on, current_page, favorite, \
     created_at, updated_at";

/// DB 행 — authors/categories는 JSON TEXT(레포 recipes.meal_tags 선례와 동일 매핑).
#[derive(Debug, sqlx::FromRow)]
pub(crate) struct BookRow {
    id: String,
    title: String,
    subtitle: Option<String>,
    authors: String,
    publisher: Option<String>,
    published_date: Option<String>,
    isbn13: Option<String>,
    isbn10: Option<String>,
    page_count: Option<i32>,
    cover_url: Option<String>,
    description: Option<String>,
    categories: String,
    language: Option<String>,
    source: String,
    source_ref: Option<String>,
    status: ReadingStatus,
    rating: Option<f64>,
    review: Option<String>,
    started_on: Option<String>,
    finished_on: Option<String>,
    current_page: i32,
    favorite: bool,
    created_at: String,
    updated_at: String,
}

pub(crate) fn parse_string_list(raw: &str, code: &'static str) -> Result<Vec<String>, AppError> {
    serde_json::from_str::<Vec<String>>(raw).map_err(|e| AppError::unexpected(code, e.to_string()))
}

pub(crate) fn serialize_string_list(values: &[String]) -> Result<String, AppError> {
    let cleaned: Vec<String> = values
        .iter()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect();
    serde_json::to_string(&cleaned)
        .map_err(|e| AppError::unexpected("reading.book.list_json", e.to_string()))
}

impl BookRow {
    pub(crate) fn into_book(self) -> Result<Book, AppError> {
        Ok(Book {
            authors: parse_string_list(&self.authors, "reading.book.authors.parse")?,
            categories: parse_string_list(&self.categories, "reading.book.categories.parse")?,
            id: self.id,
            title: self.title,
            subtitle: self.subtitle,
            publisher: self.publisher,
            published_date: self.published_date,
            isbn13: self.isbn13,
            isbn10: self.isbn10,
            page_count: self.page_count,
            cover_url: self.cover_url,
            description: self.description,
            language: self.language,
            source: self.source,
            source_ref: self.source_ref,
            status: self.status,
            rating: self.rating,
            review: self.review,
            started_on: self.started_on,
            finished_on: self.finished_on,
            current_page: self.current_page,
            favorite: self.favorite,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}
