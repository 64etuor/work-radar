//! 발췌/인용 + 내 생각. append + delete만(수정은 삭제 후 재기록 — 개인 메모 스케일).

#![allow(clippy::result_large_err)]

use tauri::State;

use super::books::fetch_book;
use super::{clean_optional, clean_required, new_id, validate_non_negative_i32};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{AddBookQuoteInput, BookQuote};

const QUOTE_MAX: usize = 4000;
const THOUGHT_MAX: usize = 4000;

pub(crate) async fn add_book_quote_inner(
    db: &Db,
    input: AddBookQuoteInput,
) -> Result<BookQuote, AppError> {
    let quote = clean_required(&input.quote, "reading.quote.text", "quote")?;
    if quote.chars().count() > QUOTE_MAX {
        return Err(AppError::validation(
            "reading.quote.text",
            format!("quote exceeds {QUOTE_MAX} characters"),
        ));
    }
    if let Some(p) = input.page {
        validate_non_negative_i32(p, "reading.quote.page")?;
    }
    let thought = clean_optional(input.thought);
    if let Some(ref t) = thought {
        if t.chars().count() > THOUGHT_MAX {
            return Err(AppError::validation(
                "reading.quote.thought",
                format!("thought exceeds {THOUGHT_MAX} characters"),
            ));
        }
    }
    fetch_book(db, &input.book_id).await?;
    Ok(sqlx::query_as::<_, BookQuote>(
        "INSERT INTO book_quotes (id, book_id, quote, page, thought, favorite) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         RETURNING id, book_id, quote, page, thought, favorite, created_at",
    )
    .bind(new_id())
    .bind(&input.book_id)
    .bind(&quote)
    .bind(input.page)
    .bind(thought.as_deref())
    .bind(input.favorite.unwrap_or(false))
    .fetch_one(db)
    .await?)
}

pub(crate) async fn delete_book_quote_inner(db: &Db, id: &str) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM book_quotes WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(
            "reading.quote.not_found",
            "quote not found",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn add_book_quote(
    db: State<'_, Db>,
    input: AddBookQuoteInput,
) -> Result<BookQuote, AppError> {
    add_book_quote_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_book_quote(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_book_quote_inner(db.inner(), &id).await
}

#[cfg(test)]
mod tests {
    use crate::commands::reading::books::add_book_inner;
    use crate::commands::reading::books::tests::book_input;
    use crate::commands::reading::get_book_detail_inner;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::AddBookQuoteInput;

    #[tokio::test]
    async fn quote_roundtrip_and_validation() {
        let db = fresh_db().await;
        let book = add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap()
            .book;

        let q = super::add_book_quote_inner(
            &db,
            AddBookQuoteInput {
                book_id: book.id.clone(),
                quote: "어려운 일에는 공식이 없다".into(),
                page: Some(42),
                thought: Some("경영 난제의 본질".into()),
                favorite: Some(true),
            },
        )
        .await
        .unwrap();
        assert!(q.favorite);

        let detail = get_book_detail_inner(&db, &book.id).await.unwrap();
        assert_eq!(detail.quotes.len(), 1);

        assert!(super::add_book_quote_inner(
            &db,
            AddBookQuoteInput {
                book_id: book.id.clone(),
                quote: "   ".into(),
                page: None,
                thought: None,
                favorite: None,
            },
        )
        .await
        .is_err());

        super::delete_book_quote_inner(&db, &q.id).await.unwrap();
        assert!(super::delete_book_quote_inner(&db, &q.id).await.is_err());
    }
}
