//! Reading 툴 — **사용자 결정(2026-07-23)으로 독서 도메인 로컬 write를 에이전트에 위임**:
//! "읽은 책과 읽을 책 등을 등록하고 완독했는지 트래킹하는 기능 + MCP에도" (diet/bookkeeping
//! 위임 선례를 따르는 도메인 단위 위임 — mcp-server-conventions §1.1).
//!
//! 결정레일 논증: 이 표면의 write는 전부 **독서 사실의 기록/집행 대행**(책 등록, 상태 전이 =
//! "읽기 시작했다/다 읽었다", 세션 = "오늘 N쪽까지 읽었다", 인용 채록)이고 로컬 SQLite뿐이다
//! (외부 mutate 0 — INVARIANT #2 비대상). 사람 게이트는 각 MCP 호스트의 승인 UI(ADR-0012).
//! `delete_book`/`delete_*`는 표면에 없다 — 파괴 동작은 앱 UI confirm 전용.
//!
//! `wr_reading_search_catalog`만 아웃바운드가 있다: Google Books/Open Library **고정
//! 엔드포인트 read-only GET**(caller 입력은 검색어 텍스트뿐, 자격증명 0) — ADR-0013이 정본.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::reading as reading_commands;
use crate::mcp::{enum_wire_string, mcp_tool_error, parse_iso_date, truncate_preview, WrServer};
use crate::models::{AddBookInput, AddBookQuoteInput, Book, LogReadingSessionInput, ReadingStatus};

const TEXT_PREVIEW_CHARS: usize = 200;
const TITLE_MAX_CHARS: usize = 300;
const QUOTE_MAX_CHARS: usize = 2000;
const THOUGHT_MAX_CHARS: usize = 1000;
const NOTE_MAX_CHARS: usize = 500;
const MAX_AUTHORS: usize = 10;
const MAX_CATEGORIES: usize = 10;
const LIST_LIMIT: usize = 100;
const SESSIONS_PREVIEW: usize = 20;
const QUOTES_PREVIEW: usize = 50;

#[allow(clippy::result_large_err)]
fn cap_chars(value: Option<&str>, max: usize, label: &str) -> Result<(), rmcp::ErrorData> {
    if let Some(v) = value {
        if v.chars().count() > max {
            return Err(rmcp::ErrorData::invalid_params(
                format!("{label} exceeds {max} characters"),
                None,
            ));
        }
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
fn cap_list(list: &[String], max: usize, label: &str) -> Result<(), rmcp::ErrorData> {
    if list.len() > max {
        return Err(rmcp::ErrorData::invalid_params(
            format!("{label} exceeds {max} items"),
            None,
        ));
    }
    for item in list {
        cap_chars(Some(item), TITLE_MAX_CHARS, label)?;
    }
    Ok(())
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ReadingStatusParam {
    ToRead,
    Reading,
    Finished,
    Abandoned,
}

impl From<ReadingStatusParam> for ReadingStatus {
    fn from(v: ReadingStatusParam) -> Self {
        match v {
            ReadingStatusParam::ToRead => ReadingStatus::ToRead,
            ReadingStatusParam::Reading => ReadingStatus::Reading,
            ReadingStatusParam::Finished => ReadingStatus::Finished,
            ReadingStatusParam::Abandoned => ReadingStatus::Abandoned,
        }
    }
}

// ── 파라미터 ─────────────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingCatalogSearchParams {
    /// 제목/저자 검색어 또는 ISBN-10/13(하이픈 허용 — ISBN이면 정밀 조회).
    pub query: String,
    /// 결과 개수 상한(1..40, 기본 10).
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingAddBookParams {
    /// 책 제목(필수). 카탈로그 검색 결과를 그대로 옮겨도 된다.
    pub title: String,
    pub subtitle: Option<String>,
    /// 저자 목록(최대 10).
    pub authors: Option<Vec<String>>,
    pub publisher: Option<String>,
    /// 출간일(자유 형식 — 예: 2021-03-15 또는 2021).
    pub published_date: Option<String>,
    /// ISBN-13(하이픈 허용). 같은 ISBN이 이미 등록돼 있으면 기존 책을 반환한다.
    pub isbn13: Option<String>,
    pub isbn10: Option<String>,
    /// 총 페이지 수(> 0).
    pub page_count: Option<i32>,
    /// 표지 이미지 URL(카탈로그 결과의 cover_url).
    pub cover_url: Option<String>,
    /// 책 소개(≤4000자).
    pub description: Option<String>,
    /// 카테고리 목록(최대 10).
    pub categories: Option<Vec<String>>,
    /// 언어 코드(예: ko, en).
    pub language: Option<String>,
    /// 서지 출처: google_books | open_library | manual(기본).
    pub source: Option<String>,
    /// provider 내 식별자(카탈로그 결과의 source_ref).
    pub source_ref: Option<String>,
    /// 초기 상태(기본 to_read).
    pub status: Option<ReadingStatusParam>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingListBooksParams {
    /// 상태 필터(생략 = 전체).
    pub status: Option<ReadingStatusParam>,
    /// 제목/저자 부분 일치 검색어.
    pub query: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingBookIdParams {
    /// `wr_reading_list_books`로 찾은 책 id.
    pub book_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingSetStatusParams {
    pub book_id: String,
    /// 새 상태. reading = 시작일 스탬프, finished = 완독일 스탬프 + 진행 100%.
    pub status: ReadingStatusParam,
    /// 상태 전이 기준 로컬 날짜 YYYY-MM-DD(생략 = 오늘).
    pub date: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingLogSessionParams {
    pub book_id: String,
    /// 읽은 로컬 날짜 YYYY-MM-DD(생략 = 오늘).
    pub date: Option<String>,
    /// 세션 종료 시점 현재 페이지(진행 위치 — 읽은 분량이 아님).
    pub end_page: Option<i32>,
    /// 읽은 시간(분, > 0).
    pub minutes: Option<i32>,
    /// 짧은 메모(≤500자).
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingAddQuoteParams {
    pub book_id: String,
    /// 발췌 문장(≤2000자).
    pub quote: String,
    /// 페이지(선택).
    pub page: Option<i32>,
    /// 발췌에 대한 내 생각(≤1000자, 선택).
    pub thought: Option<String>,
    /// 즐겨찾기 표시.
    pub favorite: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingStatsParams {
    /// 대상 연도(생략 = 올해).
    pub year: Option<i32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReadingSetGoalParams {
    /// 대상 연도.
    pub year: i32,
    /// 연간 목표 권수(1..1000).
    pub target_books: i32,
}

// ── DTO (sanitized — 장문은 truncated preview) ───────────────────────

/// MCP output 루트는 object여야 한다(스펙) — 배열을 감싼다.
#[derive(Serialize, JsonSchema)]
pub struct ReadingCatalogListDto {
    pub results: Vec<ReadingCatalogBookDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingCatalogBookDto {
    pub title: String,
    pub subtitle: Option<String>,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub isbn13: Option<String>,
    pub isbn10: Option<String>,
    pub page_count: Option<i32>,
    pub cover_url: Option<String>,
    /// 소개 미리보기(≤200자).
    pub description_preview: Option<String>,
    pub categories: Vec<String>,
    pub language: Option<String>,
    pub source: String,
    pub source_ref: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingBookDto {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub publisher: Option<String>,
    pub page_count: Option<i32>,
    pub status: String,
    /// 0..10.
    pub rating: Option<f64>,
    pub current_page: i32,
    pub started_on: Option<String>,
    pub finished_on: Option<String>,
    pub isbn13: Option<String>,
    pub favorite: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingBookListDto {
    pub books: Vec<ReadingBookDto>,
    /// LIST_LIMIT로 잘렸으면 true(전체는 query/status로 좁혀 재조회).
    pub truncated: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingSessionDto {
    pub id: String,
    pub date: String,
    pub end_page: Option<i32>,
    pub minutes: Option<i32>,
    pub note_preview: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingQuoteDto {
    pub id: String,
    pub quote_preview: String,
    pub page: Option<i32>,
    pub thought_preview: Option<String>,
    pub favorite: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingBookDetailDto {
    pub book: ReadingBookDto,
    pub review_preview: Option<String>,
    pub description_preview: Option<String>,
    pub sessions: Vec<ReadingSessionDto>,
    pub quotes: Vec<ReadingQuoteDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingAddBookDto {
    pub book: ReadingBookDto,
    /// false = 같은 ISBN이 이미 있어 기존 책을 돌려줬다(새로 만들지 않음).
    pub created: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingGoalDto {
    pub year: i32,
    pub target_books: i32,
}

#[derive(Serialize, JsonSchema)]
pub struct ReadingStatsDto {
    pub year: i32,
    pub total_books: i32,
    pub finished_total: i32,
    pub reading_count: i32,
    pub to_read_count: i32,
    pub abandoned_count: i32,
    pub avg_rating: Option<f64>,
    pub total_pages_read: i32,
    pub finished_in_year: i32,
    /// 1..12월 완독 수(길이 12).
    pub monthly_finished: Vec<i32>,
    pub goal_target_books: Option<i32>,
    pub streak_days: i32,
}

fn book_dto(book: &Book) -> ReadingBookDto {
    ReadingBookDto {
        id: book.id.clone(),
        title: truncate_preview(&book.title, TITLE_MAX_CHARS),
        authors: book.authors.clone(),
        publisher: book.publisher.clone(),
        page_count: book.page_count,
        status: enum_wire_string(&book.status),
        rating: book.rating,
        current_page: book.current_page,
        started_on: book.started_on.clone(),
        finished_on: book.finished_on.clone(),
        isbn13: book.isbn13.clone(),
        favorite: book.favorite,
    }
}

#[tool_router(router = tool_router_reading, vis = "pub(crate)")]
impl WrServer {
    #[tool(
        name = "wr_reading_search_catalog",
        description = "Search the public book catalog (Google Books, Open Library fallback) by title/author text or ISBN. Read-only outbound GET to fixed endpoints; returns bibliographic candidates to pass into wr_reading_add_book. Nothing is stored."
    )]
    pub async fn reading_search_catalog(
        &self,
        Parameters(p): Parameters<ReadingCatalogSearchParams>,
    ) -> Result<Json<ReadingCatalogListDto>, rmcp::ErrorData> {
        let limit = p.limit.unwrap_or(10).clamp(1, 40);
        let results = reading_commands::search_book_catalog_inner(&p.query, Some(limit))
            .await
            .map_err(|e| mcp_tool_error("wr_reading_search_catalog", &e))?;
        Ok(Json(ReadingCatalogListDto {
            results: results
                .into_iter()
                .map(|c| ReadingCatalogBookDto {
                    title: truncate_preview(&c.title, TITLE_MAX_CHARS),
                    subtitle: c.subtitle.map(|s| truncate_preview(&s, TITLE_MAX_CHARS)),
                    authors: c.authors,
                    publisher: c.publisher,
                    published_date: c.published_date,
                    isbn13: c.isbn13,
                    isbn10: c.isbn10,
                    page_count: c.page_count,
                    cover_url: c.cover_url,
                    description_preview: c
                        .description
                        .map(|d| truncate_preview(&d, TEXT_PREVIEW_CHARS)),
                    categories: c.categories,
                    language: c.language,
                    source: c.source,
                    source_ref: c.source_ref,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_reading_add_book",
        description = "Register a book in the local reading log (local SQLite write). Pass bibliographic fields from wr_reading_search_catalog or manual input. Duplicates are rejected softly: same ISBN-13, or same normalized title with overlapping authors, returns the existing book (created=false) and backfills its missing bibliographic fields."
    )]
    pub async fn reading_add_book(
        &self,
        Parameters(p): Parameters<ReadingAddBookParams>,
    ) -> Result<Json<ReadingAddBookDto>, rmcp::ErrorData> {
        cap_chars(Some(&p.title), TITLE_MAX_CHARS, "title")?;
        cap_chars(p.subtitle.as_deref(), TITLE_MAX_CHARS, "subtitle")?;
        cap_chars(p.description.as_deref(), 4000, "description")?;
        let authors = p.authors.unwrap_or_default();
        let categories = p.categories.unwrap_or_default();
        cap_list(&authors, MAX_AUTHORS, "authors")?;
        cap_list(&categories, MAX_CATEGORIES, "categories")?;
        let result = reading_commands::add_book_inner(
            &self.db,
            AddBookInput {
                title: p.title,
                subtitle: p.subtitle,
                authors,
                publisher: p.publisher,
                published_date: p.published_date,
                isbn13: p.isbn13,
                isbn10: p.isbn10,
                page_count: p.page_count,
                cover_url: p.cover_url,
                description: p.description,
                categories,
                language: p.language,
                source: p.source,
                source_ref: p.source_ref,
                status: p.status.map(Into::into),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_reading_add_book", &e))?;
        Ok(Json(ReadingAddBookDto {
            book: book_dto(&result.book),
            created: result.created,
        }))
    }

    #[tool(
        name = "wr_reading_list_books",
        description = "List books in the reading log, optionally filtered by status (to_read/reading/finished/abandoned) and/or title-author text. Read-only."
    )]
    pub async fn reading_list_books(
        &self,
        Parameters(p): Parameters<ReadingListBooksParams>,
    ) -> Result<Json<ReadingBookListDto>, rmcp::ErrorData> {
        cap_chars(p.query.as_deref(), TITLE_MAX_CHARS, "query")?;
        let books = reading_commands::list_books_inner(&self.db, p.status.map(Into::into), p.query)
            .await
            .map_err(|e| mcp_tool_error("wr_reading_list_books", &e))?;
        let truncated = books.len() > LIST_LIMIT;
        Ok(Json(ReadingBookListDto {
            books: books.iter().take(LIST_LIMIT).map(book_dto).collect(),
            truncated,
        }))
    }

    #[tool(
        name = "wr_reading_get_book",
        description = "Full record for one book: bibliographic data, review/description previews, recent reading sessions, and saved quotes. Read-only."
    )]
    pub async fn reading_get_book(
        &self,
        Parameters(p): Parameters<ReadingBookIdParams>,
    ) -> Result<Json<ReadingBookDetailDto>, rmcp::ErrorData> {
        let detail = reading_commands::get_book_detail_inner(&self.db, &p.book_id)
            .await
            .map_err(|e| mcp_tool_error("wr_reading_get_book", &e))?;
        Ok(Json(ReadingBookDetailDto {
            book: book_dto(&detail.book),
            review_preview: detail
                .book
                .review
                .as_deref()
                .map(|r| truncate_preview(r, TEXT_PREVIEW_CHARS)),
            description_preview: detail
                .book
                .description
                .as_deref()
                .map(|d| truncate_preview(d, TEXT_PREVIEW_CHARS)),
            sessions: detail
                .sessions
                .iter()
                .take(SESSIONS_PREVIEW)
                .map(|s| ReadingSessionDto {
                    id: s.id.clone(),
                    date: s.date.clone(),
                    end_page: s.end_page,
                    minutes: s.minutes,
                    note_preview: s
                        .note
                        .as_deref()
                        .map(|n| truncate_preview(n, TEXT_PREVIEW_CHARS)),
                })
                .collect(),
            quotes: detail
                .quotes
                .iter()
                .take(QUOTES_PREVIEW)
                .map(|q| ReadingQuoteDto {
                    id: q.id.clone(),
                    quote_preview: truncate_preview(&q.quote, TEXT_PREVIEW_CHARS),
                    page: q.page,
                    thought_preview: q
                        .thought
                        .as_deref()
                        .map(|t| truncate_preview(t, TEXT_PREVIEW_CHARS)),
                    favorite: q.favorite,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_reading_set_status",
        description = "Record a reading-status fact for a book: to_read / reading (stamps start date) / finished (stamps finish date, marks fully read) / abandoned. Local SQLite write; reversible."
    )]
    pub async fn reading_set_status(
        &self,
        Parameters(p): Parameters<ReadingSetStatusParams>,
    ) -> Result<Json<ReadingBookDto>, rmcp::ErrorData> {
        let date = match p.date {
            Some(d) => {
                parse_iso_date(&d)?;
                d
            }
            None => crate::timezone::local_today_string(),
        };
        let book =
            reading_commands::set_book_status_inner(&self.db, &p.book_id, p.status.into(), &date)
                .await
                .map_err(|e| mcp_tool_error("wr_reading_set_status", &e))?;
        Ok(Json(book_dto(&book)))
    }

    #[tool(
        name = "wr_reading_log_session",
        description = "Log a reading session fact: date, current page reached, minutes read, optional note. Advances the book's progress (never backwards) and moves a to_read book to reading. Local SQLite write."
    )]
    pub async fn reading_log_session(
        &self,
        Parameters(p): Parameters<ReadingLogSessionParams>,
    ) -> Result<Json<ReadingSessionDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let date = match p.date {
            Some(d) => {
                parse_iso_date(&d)?;
                d
            }
            None => crate::timezone::local_today_string(),
        };
        let session = reading_commands::log_reading_session_inner(
            &self.db,
            LogReadingSessionInput {
                book_id: p.book_id,
                date,
                end_page: p.end_page,
                minutes: p.minutes,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_reading_log_session", &e))?;
        Ok(Json(ReadingSessionDto {
            id: session.id,
            date: session.date,
            end_page: session.end_page,
            minutes: session.minutes,
            note_preview: session
                .note
                .as_deref()
                .map(|n| truncate_preview(n, TEXT_PREVIEW_CHARS)),
        }))
    }

    #[tool(
        name = "wr_reading_add_quote",
        description = "Save a quote/excerpt from a book with optional page and your own thought. Local SQLite write, append-only."
    )]
    pub async fn reading_add_quote(
        &self,
        Parameters(p): Parameters<ReadingAddQuoteParams>,
    ) -> Result<Json<ReadingQuoteDto>, rmcp::ErrorData> {
        cap_chars(Some(&p.quote), QUOTE_MAX_CHARS, "quote")?;
        cap_chars(p.thought.as_deref(), THOUGHT_MAX_CHARS, "thought")?;
        let quote = reading_commands::add_book_quote_inner(
            &self.db,
            AddBookQuoteInput {
                book_id: p.book_id,
                quote: p.quote,
                page: p.page,
                thought: p.thought,
                favorite: p.favorite,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_reading_add_quote", &e))?;
        Ok(Json(ReadingQuoteDto {
            id: quote.id,
            quote_preview: truncate_preview(&quote.quote, TEXT_PREVIEW_CHARS),
            page: quote.page,
            thought_preview: quote
                .thought
                .as_deref()
                .map(|t| truncate_preview(t, TEXT_PREVIEW_CHARS)),
            favorite: quote.favorite,
        }))
    }

    #[tool(
        name = "wr_reading_stats",
        description = "Reading dashboard aggregates: status counts, average rating (0..10), pages read, finishes for the year with monthly buckets, yearly goal, and current daily reading streak. Read-only."
    )]
    pub async fn reading_stats(
        &self,
        Parameters(p): Parameters<ReadingStatsParams>,
    ) -> Result<Json<ReadingStatsDto>, rmcp::ErrorData> {
        let today = crate::timezone::local_today_string();
        let year = p.year.unwrap_or_else(|| {
            today
                .get(..4)
                .and_then(|y| y.parse::<i32>().ok())
                .unwrap_or(2026)
        });
        let stats = reading_commands::reading_stats_inner(&self.db, year, &today)
            .await
            .map_err(|e| mcp_tool_error("wr_reading_stats", &e))?;
        Ok(Json(ReadingStatsDto {
            year: stats.year,
            total_books: stats.total_books,
            finished_total: stats.finished_total,
            reading_count: stats.reading_count,
            to_read_count: stats.to_read_count,
            abandoned_count: stats.abandoned_count,
            avg_rating: stats.avg_rating,
            total_pages_read: stats.total_pages_read,
            finished_in_year: stats.finished_in_year,
            monthly_finished: stats.monthly_finished,
            goal_target_books: stats.goal.map(|g| g.target_books),
            streak_days: stats.streak_days,
        }))
    }

    #[tool(
        name = "wr_reading_set_goal",
        description = "Set (upsert) the yearly reading goal in books — a conversational proxy for the user's own target. Local SQLite write."
    )]
    pub async fn reading_set_goal(
        &self,
        Parameters(p): Parameters<ReadingSetGoalParams>,
    ) -> Result<Json<ReadingGoalDto>, rmcp::ErrorData> {
        let goal = reading_commands::set_reading_goal_inner(&self.db, p.year, p.target_books)
            .await
            .map_err(|e| mcp_tool_error("wr_reading_set_goal", &e))?;
        Ok(Json(ReadingGoalDto {
            year: goal.year,
            target_books: goal.target_books,
        }))
    }
}
