//! 책 등록/조회/갱신/상태 전이. isbn13 dedup(같은 책 재등록 시 기존 행 반환 — INVARIANT #3
//! 정신), 상태 전이는 `set_book_status_inner`가 소유(started_on/finished_on 자동 스탬프).

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{
    clean_optional, clean_required, new_id, serialize_string_list, validate_date,
    validate_non_negative_i32, validate_rating, BookRow, BOOK_COLS,
};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    AddBookInput, AddBookResult, Book, BookDetail, BookQuote, ReadingSession, ReadingStatus,
    UpdateBookInput,
};

const TITLE_MAX: usize = 300;
const TEXT_MAX: usize = 8000;

pub(crate) async fn fetch_book(db: &Db, id: &str) -> Result<Book, AppError> {
    sqlx::query_as::<_, BookRow>(&format!("SELECT {BOOK_COLS} FROM books WHERE id = ?1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("reading.book.not_found", "book not found"))?
        .into_book()
}

pub(crate) async fn add_book_inner(
    db: &Db,
    input: AddBookInput,
) -> Result<AddBookResult, AppError> {
    let title = clean_required(&input.title, "reading.book.title", "title")?;
    if title.chars().count() > TITLE_MAX {
        return Err(AppError::validation(
            "reading.book.title",
            format!("title exceeds {TITLE_MAX} characters"),
        ));
    }
    // clone: 아래 dedup 경로가 `&input` 전체를 다시 빌린다(부분 move 금지).
    let isbn13 =
        clean_optional(input.isbn13.clone()).and_then(|v| crate::reading::normalize_isbn(&v));
    let isbn10 =
        clean_optional(input.isbn10.clone()).and_then(|v| crate::reading::normalize_isbn(&v));
    if let Some(pages) = input.page_count {
        if pages <= 0 {
            return Err(AppError::validation(
                "reading.book.page_count",
                "page_count must be > 0",
            ));
        }
    }

    if let Some(ref description) = input.description {
        if description.chars().count() > TEXT_MAX {
            return Err(AppError::validation(
                "reading.book.description",
                format!("description exceeds {TEXT_MAX} characters"),
            ));
        }
    }

    // 제목 dedup — ISBN이 없는 책(수기 등록·옵시디언 임포트)과의 중복 등록 방지.
    // 정규화(공백·문장부호 무시) 제목 일치만으로는 판정하지 않는다 — **코로보레이션 필수**
    // (저자 겹침 또는 ISBN 동일). 한쪽이라도 저자·ISBN이 없으면 동명 이서를 합쳐버리고
    // 기존 행 서지를 오염시킬 수 있어(2차 critic MAJOR) 그냥 새로 등록한다(안전한 방향 —
    // 다이얼로그의 서재 우선 매칭이 어차피 노출한다). 중복이면 기존 행을 돌려주되, 새
    // 입력의 서지로 **비어 있는 필드만** 채운다(백필 — 기존 값은 절대 덮지 않음).
    if let Some(existing) =
        find_duplicate_by_title(db, &title, &input.authors, isbn13.as_deref()).await?
    {
        let enriched =
            enrich_missing_fields(db, &existing, &input, isbn13.as_deref(), isbn10.as_deref())
                .await?;
        return Ok(AddBookResult {
            book: enriched,
            created: false,
        });
    }

    let status = input.status.unwrap_or(ReadingStatus::ToRead);
    let authors = serialize_string_list(&input.authors)?;
    let categories = serialize_string_list(&input.categories)?;
    let source = clean_optional(input.source).unwrap_or_else(|| "manual".to_string());
    // isbn13 dedup을 INSERT 자체에 태운다(ON CONFLICT DO NOTHING) — 선제 SELECT는 앱/MCP
    // 두 프로세스가 동시에 지나칠 수 있어 원자적이지 않다(critic Minor-1). 행이 안 돌아오면
    // 충돌 = 기존 책이므로 그 행을 돌려준다(created:false).
    let inserted = sqlx::query_as::<_, BookRow>(&format!(
        "INSERT INTO books (id, title, subtitle, authors, publisher, published_date, isbn13, \
           isbn10, page_count, cover_url, description, categories, language, source, source_ref, \
           status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
         ON CONFLICT(isbn13) WHERE isbn13 IS NOT NULL DO NOTHING \
         RETURNING {BOOK_COLS}"
    ))
    .bind(new_id())
    .bind(&title)
    .bind(clean_optional(input.subtitle))
    .bind(&authors)
    .bind(clean_optional(input.publisher))
    .bind(clean_optional(input.published_date))
    .bind(&isbn13)
    .bind(&isbn10)
    .bind(input.page_count)
    .bind(clean_optional(input.cover_url))
    .bind(clean_optional(input.description))
    .bind(&categories)
    .bind(clean_optional(input.language))
    .bind(&source)
    .bind(clean_optional(input.source_ref))
    .bind(status)
    .fetch_optional(db)
    .await?;

    match (inserted, &isbn13) {
        (Some(row), _) => Ok(AddBookResult {
            book: row.into_book()?,
            created: true,
        }),
        (None, Some(isbn)) => {
            let existing = sqlx::query_as::<_, BookRow>(&format!(
                "SELECT {BOOK_COLS} FROM books WHERE isbn13 = ?1"
            ))
            .bind(isbn)
            .fetch_one(db)
            .await?;
            Ok(AddBookResult {
                book: existing.into_book()?,
                created: false,
            })
        }
        (None, None) => Err(AppError::unexpected(
            "reading.book.insert",
            "insert returned no row without an isbn conflict",
        )),
    }
}

/// 정규화 제목 일치 + **코로보레이션**(저자 겹침 또는 ISBN 동일)으로만 중복을 판정한다.
/// 제목만 같은 경우는 중복이 아니다 — 동명 이서 병합/서지 오염 방지(2차 critic MAJOR).
/// 개인 서재 스케일(수백 행)이라 전량 스캔 후 Rust 정규화 비교가 단순·안전하다.
async fn find_duplicate_by_title(
    db: &Db,
    title: &str,
    authors: &[String],
    isbn13: Option<&str>,
) -> Result<Option<Book>, AppError> {
    let norm_title = crate::reading::normalize_for_match(title);
    if norm_title.is_empty() {
        return Ok(None);
    }
    let norm_authors: Vec<String> = authors
        .iter()
        .map(|a| crate::reading::normalize_for_match(a))
        .filter(|a| !a.is_empty())
        .collect();
    let rows = sqlx::query_as::<_, BookRow>(&format!("SELECT {BOOK_COLS} FROM books"))
        .fetch_all(db)
        .await?;
    for row in rows {
        let candidate = row.into_book()?;
        if crate::reading::normalize_for_match(&candidate.title) != norm_title {
            continue;
        }
        let cand_authors: Vec<String> = candidate
            .authors
            .iter()
            .map(|a| crate::reading::normalize_for_match(a))
            .filter(|a| !a.is_empty())
            .collect();
        // 정규화 동등만 겹침으로 본다 — contains는 "저자"⊂"다른 저자" 류 오탐을 만든다.
        let authors_corroborate = !norm_authors.is_empty()
            && !cand_authors.is_empty()
            && norm_authors.iter().any(|a| cand_authors.contains(a));
        let isbn_corroborates =
            matches!((isbn13, candidate.isbn13.as_deref()), (Some(a), Some(b)) if a == b);
        if authors_corroborate || isbn_corroborates {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// 중복 판정된 기존 책에 새 입력의 서지를 **NULL 필드만** 백필한다(COALESCE — 기존 값 불변).
/// isbn13은 unique 인덱스와 충돌할 수 있어(다른 행이 이미 보유) 실패 시 백필 없이 기존 행 반환.
/// `authors`는 의도적으로 제외 — 중복 판정의 코로보레이션 키라 백필로 바꾸면 판정이 자기
/// 입력에 오염된다. `categories`는 NOT NULL DEFAULT '[]'라 COALESCE 백필이 성립하지 않는다.
async fn enrich_missing_fields(
    db: &Db,
    existing: &Book,
    input: &AddBookInput,
    isbn13: Option<&str>,
    isbn10: Option<&str>,
) -> Result<Book, AppError> {
    let updated = sqlx::query_as::<_, BookRow>(&format!(
        "UPDATE books SET \
           subtitle = COALESCE(subtitle, ?2), publisher = COALESCE(publisher, ?3), \
           published_date = COALESCE(published_date, ?4), isbn13 = COALESCE(isbn13, ?5), \
           isbn10 = COALESCE(isbn10, ?6), page_count = COALESCE(page_count, ?7), \
           cover_url = COALESCE(cover_url, ?8), description = COALESCE(description, ?9), \
           language = COALESCE(language, ?10), \
           updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {BOOK_COLS}"
    ))
    .bind(&existing.id)
    .bind(
        input
            .subtitle
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        input
            .publisher
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        input
            .published_date
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(isbn13)
    .bind(isbn10)
    .bind(input.page_count.filter(|p| *p > 0))
    .bind(
        input
            .cover_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(
        input
            .language
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .fetch_one(db)
    .await;
    match updated {
        Ok(row) => row.into_book(),
        Err(e) => {
            // 유일한 예상 실패 = isbn13 unique 충돌(같은 ISBN을 다른 행이 보유). 백필만 포기.
            tracing::warn!(error = %e, "book enrich skipped (likely isbn13 unique clash)");
            Ok(existing.clone())
        }
    }
}

pub(crate) async fn list_books_inner(
    db: &Db,
    status: Option<ReadingStatus>,
    query: Option<String>,
) -> Result<Vec<Book>, AppError> {
    let like = clean_optional(query).map(|q| format!("%{q}%"));
    let rows = match (&status, &like) {
        (Some(s), Some(q)) => {
            sqlx::query_as::<_, BookRow>(&format!(
                "SELECT {BOOK_COLS} FROM books WHERE status = ?1 AND (title LIKE ?2 OR authors LIKE ?2) \
                 ORDER BY updated_at DESC"
            ))
            .bind(s)
            .bind(q)
            .fetch_all(db)
            .await?
        }
        (Some(s), None) => {
            sqlx::query_as::<_, BookRow>(&format!(
                "SELECT {BOOK_COLS} FROM books WHERE status = ?1 ORDER BY updated_at DESC"
            ))
            .bind(s)
            .fetch_all(db)
            .await?
        }
        (None, Some(q)) => {
            sqlx::query_as::<_, BookRow>(&format!(
                "SELECT {BOOK_COLS} FROM books WHERE title LIKE ?1 OR authors LIKE ?1 \
                 ORDER BY updated_at DESC"
            ))
            .bind(q)
            .fetch_all(db)
            .await?
        }
        (None, None) => {
            sqlx::query_as::<_, BookRow>(&format!(
                "SELECT {BOOK_COLS} FROM books ORDER BY updated_at DESC"
            ))
            .fetch_all(db)
            .await?
        }
    };
    rows.into_iter().map(BookRow::into_book).collect()
}

pub(crate) async fn get_book_detail_inner(db: &Db, id: &str) -> Result<BookDetail, AppError> {
    let book = fetch_book(db, id).await?;
    let sessions = sqlx::query_as::<_, ReadingSession>(
        "SELECT id, book_id, date, end_page, minutes, note, created_at \
         FROM reading_sessions WHERE book_id = ?1 ORDER BY date DESC, created_at DESC",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let quotes = sqlx::query_as::<_, BookQuote>(
        "SELECT id, book_id, quote, page, thought, favorite, created_at \
         FROM book_quotes WHERE book_id = ?1 ORDER BY created_at DESC",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(BookDetail {
        book,
        sessions,
        quotes,
    })
}

/// 부분 갱신 — None 필드는 유지. rating/review 클리어는 명시 플래그.
pub(crate) async fn update_book_inner(db: &Db, input: UpdateBookInput) -> Result<Book, AppError> {
    let current = fetch_book(db, &input.id).await?;

    let title = match input.title {
        Some(t) => clean_required(&t, "reading.book.title", "title")?,
        None => current.title,
    };
    if let Some(r) = input.rating {
        validate_rating(r)?;
    }
    if let Some(p) = input.page_count {
        if p <= 0 {
            return Err(AppError::validation(
                "reading.book.page_count",
                "page_count must be > 0",
            ));
        }
    }
    if let Some(p) = input.current_page {
        validate_non_negative_i32(p, "reading.book.current_page")?;
    }
    for (value, code) in [
        (&input.started_on, "reading.book.started_on"),
        (&input.finished_on, "reading.book.finished_on"),
    ] {
        if let Some(v) = value {
            validate_date(v, code)?;
        }
    }
    if let Some(ref review) = input.review {
        if review.chars().count() > TEXT_MAX {
            return Err(AppError::validation(
                "reading.book.review",
                format!("review exceeds {TEXT_MAX} characters"),
            ));
        }
    }

    let authors = match input.authors {
        Some(list) => serialize_string_list(&list)?,
        None => serialize_string_list(&current.authors)?,
    };
    let categories = match input.categories {
        Some(list) => serialize_string_list(&list)?,
        None => serialize_string_list(&current.categories)?,
    };
    let rating = if input.clear_rating.unwrap_or(false) {
        None
    } else {
        input.rating.or(current.rating)
    };
    let review = if input.clear_review.unwrap_or(false) {
        None
    } else {
        clean_optional(input.review).or(current.review)
    };

    let row = sqlx::query_as::<_, BookRow>(&format!(
        "UPDATE books SET title = ?2, subtitle = ?3, authors = ?4, publisher = ?5, \
           published_date = ?6, isbn13 = ?7, isbn10 = ?8, page_count = ?9, cover_url = ?10, \
           description = ?11, categories = ?12, language = ?13, rating = ?14, review = ?15, \
           current_page = ?16, favorite = ?17, started_on = ?18, finished_on = ?19, \
           updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {BOOK_COLS}"
    ))
    .bind(&input.id)
    .bind(&title)
    .bind(clean_optional(input.subtitle).or(current.subtitle))
    .bind(&authors)
    .bind(clean_optional(input.publisher).or(current.publisher))
    .bind(clean_optional(input.published_date).or(current.published_date))
    .bind(
        clean_optional(input.isbn13)
            .and_then(|v| crate::reading::normalize_isbn(&v))
            .or(current.isbn13),
    )
    .bind(
        clean_optional(input.isbn10)
            .and_then(|v| crate::reading::normalize_isbn(&v))
            .or(current.isbn10),
    )
    .bind(input.page_count.or(current.page_count))
    .bind(clean_optional(input.cover_url).or(current.cover_url))
    .bind(clean_optional(input.description).or(current.description))
    .bind(&categories)
    .bind(clean_optional(input.language).or(current.language))
    .bind(rating)
    .bind(review)
    .bind(input.current_page.unwrap_or(current.current_page))
    .bind(input.favorite.unwrap_or(current.favorite))
    .bind(clean_optional(input.started_on).or(current.started_on))
    .bind(clean_optional(input.finished_on).or(current.finished_on))
    .fetch_one(db)
    .await?;
    row.into_book()
}

/// 상태 전이 소유자. `date` = 호출자 로컬 오늘(YYYY-MM-DD — data-layer 규율).
/// reading 진입: started_on 스탬프(없으면) + finished_on 클리어.
/// finished 진입: finished_on = date, started_on 스탬프(없으면), current_page = page_count.
/// to_read 복귀: 날짜 둘 다 클리어. abandoned: finished_on만 클리어.
pub(crate) async fn set_book_status_inner(
    db: &Db,
    id: &str,
    status: ReadingStatus,
    date: &str,
) -> Result<Book, AppError> {
    validate_date(date, "reading.book.status_date")?;
    let sql = match status {
        ReadingStatus::Reading => {
            "UPDATE books SET status = ?2, started_on = COALESCE(started_on, ?3), \
               finished_on = NULL, updated_at = datetime('now') WHERE id = ?1"
        }
        ReadingStatus::Finished => {
            "UPDATE books SET status = ?2, started_on = COALESCE(started_on, ?3), \
               finished_on = ?3, current_page = COALESCE(page_count, current_page), \
               updated_at = datetime('now') WHERE id = ?1"
        }
        ReadingStatus::ToRead => {
            "UPDATE books SET status = ?2, started_on = NULL, finished_on = NULL, \
               current_page = 0, updated_at = datetime('now') WHERE id = ?1"
        }
        ReadingStatus::Abandoned => {
            "UPDATE books SET status = ?2, finished_on = NULL, updated_at = datetime('now') \
             WHERE id = ?1"
        }
    };
    let result = sqlx::query(sql)
        .bind(id)
        .bind(status)
        .bind(date.trim())
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(
            "reading.book.not_found",
            "book not found",
        ));
    }
    fetch_book(db, id).await
}

/// 하드 삭제(CASCADE로 세션/인용 동반 삭제) — 앱 UI confirm 뒤에서만. MCP 표면에 없다.
pub(crate) async fn delete_book_inner(db: &Db, id: &str) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM books WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(
            "reading.book.not_found",
            "book not found",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn add_book(db: State<'_, Db>, input: AddBookInput) -> Result<AddBookResult, AppError> {
    add_book_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_books(
    db: State<'_, Db>,
    status: Option<ReadingStatus>,
    query: Option<String>,
) -> Result<Vec<Book>, AppError> {
    list_books_inner(db.inner(), status, query).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_book_detail(db: State<'_, Db>, id: String) -> Result<BookDetail, AppError> {
    get_book_detail_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_book(db: State<'_, Db>, input: UpdateBookInput) -> Result<Book, AppError> {
    update_book_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_book_status(
    db: State<'_, Db>,
    id: String,
    status: ReadingStatus,
    date: String,
) -> Result<Book, AppError> {
    set_book_status_inner(db.inner(), &id, status, &date).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_book(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_book_inner(db.inner(), &id).await
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{AddBookInput, ReadingStatus, UpdateBookInput};

    pub(crate) fn book_input(title: &str, isbn13: Option<&str>) -> AddBookInput {
        AddBookInput {
            title: title.into(),
            subtitle: None,
            authors: vec!["저자".into()],
            publisher: None,
            published_date: None,
            isbn13: isbn13.map(Into::into),
            isbn10: None,
            page_count: Some(412),
            cover_url: None,
            description: None,
            categories: vec!["Business".into()],
            language: Some("ko".into()),
            source: None,
            source_ref: None,
            status: None,
        }
    }

    fn patch(id: &str) -> UpdateBookInput {
        UpdateBookInput {
            id: id.into(),
            title: None,
            subtitle: None,
            authors: None,
            publisher: None,
            published_date: None,
            isbn13: None,
            isbn10: None,
            page_count: None,
            cover_url: None,
            description: None,
            categories: None,
            language: None,
            rating: None,
            clear_rating: None,
            review: None,
            clear_review: None,
            current_page: None,
            favorite: None,
            started_on: None,
            finished_on: None,
        }
    }

    #[tokio::test]
    async fn add_book_dedups_by_isbn13() {
        let db = fresh_db().await;
        let first = super::add_book_inner(&db, book_input("하드씽", Some("978-89-654-0330-2")))
            .await
            .unwrap();
        assert!(first.created);
        assert_eq!(
            first.book.isbn13.as_deref(),
            Some("9788965403302"),
            "ISBN 정규화 저장"
        );

        let dup = super::add_book_inner(&db, book_input("하드씽(중복)", Some("9788965403302")))
            .await
            .unwrap();
        assert!(!dup.created, "같은 isbn13 재등록 = 기존 행 반환");
        assert_eq!(dup.book.id, first.book.id);
        assert_eq!(
            super::list_books_inner(&db, None, None)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn add_book_dedups_by_normalized_title_and_backfills_missing_fields() {
        let db = fresh_db().await;
        // 임포트 책 모사: ISBN·쪽수·표지 없음, 저자만 있음.
        let imported = super::add_book_inner(
            &db,
            AddBookInput {
                page_count: None,
                ..book_input("바보들은 항상 남의 탓만 한다", None)
            },
        )
        .await
        .unwrap();
        assert!(imported.created);
        assert!(imported.book.isbn13.is_none());

        // 카탈로그 재등록: 띄어쓰기·문장부호 다르고 서지가 더 풍부하다.
        let dup = super::add_book_inner(
            &db,
            AddBookInput {
                title: "바보들은 항상남의 탓만 한다!".into(),
                isbn13: Some("978-89-6086-093-8".into()),
                page_count: Some(252),
                cover_url: Some("https://image.aladin.co.kr/x.jpg".into()),
                ..book_input("ignored", None)
            },
        )
        .await
        .unwrap();
        assert!(!dup.created, "정규화 제목 일치 = 중복");
        assert_eq!(dup.book.id, imported.book.id);
        assert_eq!(
            dup.book.isbn13.as_deref(),
            Some("9788960860938"),
            "빈 필드는 백필"
        );
        assert_eq!(dup.book.page_count, Some(252));
        assert!(dup.book.cover_url.is_some());

        // 같은 제목이라도 저자가 안 겹치면 다른 책.
        let other = super::add_book_inner(
            &db,
            AddBookInput {
                authors: vec!["완전히 다른 저자".into()],
                ..book_input("바보들은 항상 남의 탓만 한다", None)
            },
        )
        .await
        .unwrap();
        assert!(other.created, "동명 이서는 새 행");

        // 2차 critic MAJOR 가드: 코로보레이션(저자 겹침/ISBN 동일) 없으면 중복 아님.
        // 저자 없는 신규 + 같은 제목 → 새 행 + 기존 행 서지 무오염.
        let bare = super::add_book_inner(
            &db,
            AddBookInput {
                authors: vec![],
                isbn13: Some("9788983711892".into()),
                cover_url: Some("https://x.jpg".into()),
                ..book_input("바보들은 항상 남의 탓만 한다", None)
            },
        )
        .await
        .unwrap();
        assert!(bare.created, "제목만 일치(한쪽 저자 없음)는 병합 금지");
        let original = super::fetch_book(&db, &imported.book.id).await.unwrap();
        assert_eq!(
            original.isbn13.as_deref(),
            Some("9788960860938"),
            "기존 행 서지는 다른 책 입력에 오염되지 않는다"
        );

        // ISBN 동일은 저자 없이도 코로보레이션 성립 = 중복(백필 포함).
        let isbn_dup = super::add_book_inner(
            &db,
            AddBookInput {
                authors: vec![],
                isbn13: Some("978-89-8371-189-2".into()),
                page_count: Some(719),
                ..book_input("바보들은 항상남의 탓만 한다", None)
            },
        )
        .await
        .unwrap();
        assert!(!isbn_dup.created, "제목+ISBN 일치 = 중복");
        assert_eq!(isbn_dup.book.id, bare.book.id);
        assert_eq!(
            isbn_dup.book.page_count,
            Some(412),
            "이미 있는 값은 백필이 덮지 않는다"
        );

        assert_eq!(
            super::list_books_inner(&db, None, None)
                .await
                .unwrap()
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn status_transitions_stamp_and_clear_dates() {
        let db = fresh_db().await;
        let book = super::add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap()
            .book;

        let reading =
            super::set_book_status_inner(&db, &book.id, ReadingStatus::Reading, "2026-07-01")
                .await
                .unwrap();
        assert_eq!(reading.started_on.as_deref(), Some("2026-07-01"));
        assert!(reading.finished_on.is_none());

        let finished =
            super::set_book_status_inner(&db, &book.id, ReadingStatus::Finished, "2026-07-20")
                .await
                .unwrap();
        assert_eq!(finished.started_on.as_deref(), Some("2026-07-01"), "유지");
        assert_eq!(finished.finished_on.as_deref(), Some("2026-07-20"));
        assert_eq!(finished.current_page, 412, "완독 시 page_count까지 전진");

        // 완독 취소 → 다시 읽는 중: finished_on 클리어, started_on 유지.
        let reopened =
            super::set_book_status_inner(&db, &book.id, ReadingStatus::Reading, "2026-07-21")
                .await
                .unwrap();
        assert_eq!(reopened.started_on.as_deref(), Some("2026-07-01"));
        assert!(reopened.finished_on.is_none());

        // 읽을 책으로 되돌리면 진행 상태 전체 리셋.
        let shelved =
            super::set_book_status_inner(&db, &book.id, ReadingStatus::ToRead, "2026-07-22")
                .await
                .unwrap();
        assert!(shelved.started_on.is_none());
        assert_eq!(shelved.current_page, 0);
    }

    #[tokio::test]
    async fn update_book_patches_only_given_fields_and_clears_by_flag() {
        let db = fresh_db().await;
        let book = super::add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap()
            .book;

        let rated = super::update_book_inner(
            &db,
            UpdateBookInput {
                rating: Some(8.5),
                review: Some("전권 추천".into()),
                ..patch(&book.id)
            },
        )
        .await
        .unwrap();
        assert_eq!(rated.rating, Some(8.5));
        assert_eq!(rated.title, "하드씽", "미지정 필드 유지");

        let cleared = super::update_book_inner(
            &db,
            UpdateBookInput {
                clear_rating: Some(true),
                ..patch(&book.id)
            },
        )
        .await
        .unwrap();
        assert!(cleared.rating.is_none(), "클리어 플래그로만 제거");
        assert_eq!(cleared.review.as_deref(), Some("전권 추천"), "리뷰는 유지");

        assert!(super::update_book_inner(
            &db,
            UpdateBookInput {
                rating: Some(11.0),
                ..patch(&book.id)
            }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn list_filters_by_status_and_query() {
        let db = fresh_db().await;
        super::add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap();
        let other = super::add_book_inner(&db, book_input("블루오션 시프트", None))
            .await
            .unwrap()
            .book;
        super::set_book_status_inner(&db, &other.id, ReadingStatus::Reading, "2026-07-01")
            .await
            .unwrap();

        let reading = super::list_books_inner(&db, Some(ReadingStatus::Reading), None)
            .await
            .unwrap();
        assert_eq!(reading.len(), 1);
        assert_eq!(reading[0].title, "블루오션 시프트");

        let found = super::list_books_inner(&db, None, Some("하드".into()))
            .await
            .unwrap();
        assert_eq!(found.len(), 1);

        super::delete_book_inner(&db, &other.id).await.unwrap();
        assert_eq!(
            super::list_books_inner(&db, None, None)
                .await
                .unwrap()
                .len(),
            1
        );
    }
}
