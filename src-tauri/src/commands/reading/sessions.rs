//! 독서 세션 = 날짜별 사실 로그(히트맵/스트릭/진행률 SSOT). 기록 시 books.current_page를
//! 전진시키되 후퇴는 시키지 않고(정정은 update_book), to_read 책에 세션이 찍히면 "읽기
//! 시작했다"는 사실이므로 reading으로 승격한다.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::books::fetch_book;
use super::{clean_optional, new_id, validate_date, validate_non_negative_i32};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{LogReadingSessionInput, ReadingSession, ReadingStatus};

const NOTE_MAX: usize = 2000;

pub(crate) async fn log_reading_session_inner(
    db: &Db,
    input: LogReadingSessionInput,
) -> Result<ReadingSession, AppError> {
    validate_date(&input.date, "reading.session.date")?;
    if let Some(p) = input.end_page {
        validate_non_negative_i32(p, "reading.session.end_page")?;
    }
    if let Some(m) = input.minutes {
        if m <= 0 {
            return Err(AppError::validation(
                "reading.session.minutes",
                "minutes must be > 0",
            ));
        }
    }
    let note = clean_optional(input.note);
    if let Some(ref n) = note {
        if n.chars().count() > NOTE_MAX {
            return Err(AppError::validation(
                "reading.session.note",
                format!("note exceeds {NOTE_MAX} characters"),
            ));
        }
    }
    let book = fetch_book(db, &input.book_id).await?;

    // 짧은 tx: 세션 insert + 책 상태/진행 반영(두 statement — data-layer §4 규율 내).
    let mut tx = db.begin().await?;
    let session = sqlx::query_as::<_, ReadingSession>(
        "INSERT INTO reading_sessions (id, book_id, date, end_page, minutes, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         RETURNING id, book_id, date, end_page, minutes, note, created_at",
    )
    .bind(new_id())
    .bind(&input.book_id)
    .bind(input.date.trim())
    .bind(input.end_page)
    .bind(input.minutes)
    .bind(note.as_deref())
    .fetch_one(&mut *tx)
    .await?;

    let promote_to_reading = book.status == ReadingStatus::ToRead;
    sqlx::query(
        "UPDATE books SET \
           current_page = MAX(current_page, COALESCE(?2, 0)), \
           status = CASE WHEN ?3 THEN 'reading' ELSE status END, \
           started_on = CASE WHEN ?3 THEN COALESCE(started_on, ?4) ELSE started_on END, \
           updated_at = datetime('now') \
         WHERE id = ?1",
    )
    .bind(&input.book_id)
    .bind(session.end_page)
    .bind(promote_to_reading)
    .bind(input.date.trim())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(session)
}

pub(crate) async fn delete_reading_session_inner(db: &Db, id: &str) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM reading_sessions WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found(
            "reading.session.not_found",
            "session not found",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn log_reading_session(
    db: State<'_, Db>,
    input: LogReadingSessionInput,
) -> Result<ReadingSession, AppError> {
    log_reading_session_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_reading_session(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_reading_session_inner(db.inner(), &id).await
}

#[cfg(test)]
mod tests {
    use crate::commands::reading::books::tests::book_input;
    use crate::commands::reading::books::{add_book_inner, fetch_book};
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{LogReadingSessionInput, ReadingStatus};

    fn session(book_id: &str, date: &str, end_page: Option<i32>) -> LogReadingSessionInput {
        LogReadingSessionInput {
            book_id: book_id.into(),
            date: date.into(),
            end_page,
            minutes: Some(30),
            note: None,
        }
    }

    #[tokio::test]
    async fn logging_a_session_promotes_to_read_book_and_advances_progress() {
        let db = fresh_db().await;
        let book = add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap()
            .book;
        assert_eq!(book.status, ReadingStatus::ToRead);

        super::log_reading_session_inner(&db, session(&book.id, "2026-07-10", Some(80)))
            .await
            .unwrap();
        let after = fetch_book(&db, &book.id).await.unwrap();
        assert_eq!(
            after.status,
            ReadingStatus::Reading,
            "세션 = 읽기 시작 사실"
        );
        assert_eq!(after.started_on.as_deref(), Some("2026-07-10"));
        assert_eq!(after.current_page, 80);

        // 뒤 페이지 세션이 진행을 되돌리지 않는다(정정은 update_book으로).
        super::log_reading_session_inner(&db, session(&book.id, "2026-07-11", Some(40)))
            .await
            .unwrap();
        let after2 = fetch_book(&db, &book.id).await.unwrap();
        assert_eq!(after2.current_page, 80, "current_page 후퇴 금지");

        // end_page 없는 세션(시간만 기록)도 유효.
        super::log_reading_session_inner(&db, session(&book.id, "2026-07-12", None))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn session_input_is_validated_and_delete_works() {
        let db = fresh_db().await;
        let book = add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap()
            .book;
        assert!(
            super::log_reading_session_inner(&db, session(&book.id, "bad-date", None))
                .await
                .is_err()
        );
        assert!(
            super::log_reading_session_inner(&db, session("missing", "2026-07-10", None))
                .await
                .is_err(),
            "없는 책이면 not_found"
        );

        let s = super::log_reading_session_inner(&db, session(&book.id, "2026-07-10", Some(10)))
            .await
            .unwrap();
        super::delete_reading_session_inner(&db, &s.id)
            .await
            .unwrap();
        assert!(super::delete_reading_session_inner(&db, &s.id)
            .await
            .is_err());
    }
}
