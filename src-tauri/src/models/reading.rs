//! Reading 도메인 타입 (docs/plans/2026-07-23-reading-domain.md).
//!
//! 원칙: 서지는 카탈로그 스냅샷(등록 시점 복사 — 이후 API 변화 무영향), 진행은
//! `reading_sessions` 사실 로그가 SSOT, rating은 옵시디언 my_rate 호환 0..10 스케일.
//! 페이지 수는 specta i64 금지 규율에 따라 i32.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ReadingStatus {
    ToRead,
    Reading,
    Finished,
    Abandoned,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub isbn13: Option<String>,
    pub isbn10: Option<String>,
    pub page_count: Option<i32>,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub language: Option<String>,
    pub source: String,
    pub source_ref: Option<String>,
    pub status: ReadingStatus,
    /// 0..10 (옵시디언 my_rate 호환 — 별 5개 표시 시 /2).
    pub rating: Option<f64>,
    pub review: Option<String>,
    pub started_on: Option<String>,
    pub finished_on: Option<String>,
    pub current_page: i32,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 카탈로그 검색 결과(외부 API 정규화 스냅샷 — DB 미저장, 등록 시 `AddBookInput`으로 복사).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogBook {
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub isbn13: Option<String>,
    pub isbn10: Option<String>,
    pub page_count: Option<i32>,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub language: Option<String>,
    /// `google_books` | `open_library`.
    pub source: String,
    /// provider 내 볼륨/문서 식별자.
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddBookInput {
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub isbn13: Option<String>,
    pub isbn10: Option<String>,
    pub page_count: Option<i32>,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub language: Option<String>,
    /// 생략 시 `manual`.
    pub source: Option<String>,
    pub source_ref: Option<String>,
    /// 생략 시 `to_read`.
    pub status: Option<ReadingStatus>,
}

/// isbn13 dedup 결과 — `created=false`면 기존 행 반환(중복 등록 아님을 UI/에이전트에 알림).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AddBookResult {
    pub book: Book,
    pub created: bool,
}

/// 부분 갱신 — None = 유지. `Option<Option<_>>`는 specta 표면이 지저분해져 명시 클리어
/// 플래그로 대신한다(rating/review는 0값 구분이 필요 없어 None=유지, 클리어는 플래그).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBookInput {
    pub id: String,
    pub title: Option<String>,
    pub subtitle: Option<String>,
    pub authors: Option<Vec<String>>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub isbn13: Option<String>,
    pub isbn10: Option<String>,
    pub page_count: Option<i32>,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub categories: Option<Vec<String>>,
    pub language: Option<String>,
    pub rating: Option<f64>,
    pub clear_rating: Option<bool>,
    pub review: Option<String>,
    pub clear_review: Option<bool>,
    pub current_page: Option<i32>,
    pub favorite: Option<bool>,
    pub started_on: Option<String>,
    pub finished_on: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReadingSession {
    pub id: String,
    pub book_id: String,
    pub date: String,
    /// 세션 종료 시점 현재 위치(페이지 수가 아님).
    pub end_page: Option<i32>,
    pub minutes: Option<i32>,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogReadingSessionInput {
    pub book_id: String,
    /// 로컬 날짜 YYYY-MM-DD (프런트/에이전트 주입 — data-layer 규율).
    pub date: String,
    pub end_page: Option<i32>,
    pub minutes: Option<i32>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookQuote {
    pub id: String,
    pub book_id: String,
    pub quote: String,
    pub page: Option<i32>,
    pub thought: Option<String>,
    pub favorite: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddBookQuoteInput {
    pub book_id: String,
    pub quote: String,
    pub page: Option<i32>,
    pub thought: Option<String>,
    pub favorite: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookDetail {
    pub book: Book,
    pub sessions: Vec<ReadingSession>,
    pub quotes: Vec<BookQuote>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ReadingGoal {
    pub year: i32,
    pub target_books: i32,
    pub created_at: String,
    pub updated_at: String,
}

/// 히트맵 하루 셀 — 활동이 있던 날만 내려간다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingHeatmapDay {
    pub date: String,
    pub sessions: i32,
    pub finished: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub year: i32,
    // ── 전체(연도 무관) — 옵시디언 Summary 패리티 ──
    pub total_books: i32,
    pub finished_total: i32,
    pub reading_count: i32,
    pub to_read_count: i32,
    pub abandoned_count: i32,
    pub avg_rating: Option<f64>,
    /// 완독한 책 page_count 합(전체).
    pub total_pages_read: i32,
    // ── 해당 연도 ──
    pub finished_in_year: i32,
    /// 1..12월 완독 수(길이 12).
    pub monthly_finished: Vec<i32>,
    pub goal: Option<ReadingGoal>,
    pub heatmap: Vec<ReadingHeatmapDay>,
    /// 오늘(요청 date)까지 끊기지 않은 세션 연속 일수.
    pub streak_days: i32,
}
