//! 대시보드 집계(옵시디언 독서 대시보드 패리티) — KPI/연간 완독/월별/히트맵/스트릭/목표.
//! 페이스(예상 대비 앞섬/뒤짐) 계산은 프런트(오늘 날짜 주입 규율 — data-layer).

#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;

use tauri::State;

use super::validate_date;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{ReadingGoal, ReadingHeatmapDay, ReadingStats, ReadingStatus};

pub(crate) async fn reading_stats_inner(
    db: &Db,
    year: i32,
    today: &str,
) -> Result<ReadingStats, AppError> {
    let today_date = validate_date(today, "reading.stats.today")?;
    if !(2000..=2100).contains(&year) {
        return Err(AppError::validation(
            "reading.stats.year",
            "year must be between 2000 and 2100",
        ));
    }
    let year_start = format!("{year}-01-01");
    let year_end = format!("{year}-12-31");

    let status_counts: Vec<(ReadingStatus, i64)> =
        sqlx::query_as("SELECT status, COUNT(*) FROM books GROUP BY status")
            .fetch_all(db)
            .await?;
    let count_of = |wanted: ReadingStatus| -> i32 {
        status_counts
            .iter()
            .find(|(s, _)| *s == wanted)
            .map(|(_, n)| *n as i32)
            .unwrap_or(0)
    };

    let avg_rating: Option<f64> =
        sqlx::query_scalar("SELECT AVG(rating) FROM books WHERE rating IS NOT NULL")
            .fetch_one(db)
            .await?;

    let total_pages_read: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(page_count), 0) FROM books WHERE status = 'finished'",
    )
    .fetch_one(db)
    .await?;

    // 연도 완독 — finished_on을 Rust에서 파싱해 월별 버킷.
    let finished_dates: Vec<(String,)> = sqlx::query_as(
        "SELECT finished_on FROM books \
         WHERE status = 'finished' AND finished_on IS NOT NULL \
           AND finished_on >= ?1 AND finished_on <= ?2",
    )
    .bind(&year_start)
    .bind(&year_end)
    .fetch_all(db)
    .await?;
    let mut monthly_finished = vec![0i32; 12];
    let mut finish_by_day: BTreeMap<String, i32> = BTreeMap::new();
    for (date,) in &finished_dates {
        if let Ok(parsed) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
            use chrono::Datelike;
            monthly_finished[(parsed.month0()) as usize] += 1;
            *finish_by_day.entry(date.clone()).or_insert(0) += 1;
        }
    }

    let session_days: Vec<(String, i64)> = sqlx::query_as(
        "SELECT date, COUNT(*) FROM reading_sessions \
         WHERE date >= ?1 AND date <= ?2 GROUP BY date",
    )
    .bind(&year_start)
    .bind(&year_end)
    .fetch_all(db)
    .await?;

    let mut heatmap: BTreeMap<String, ReadingHeatmapDay> = BTreeMap::new();
    for (date, count) in session_days {
        heatmap.insert(
            date.clone(),
            ReadingHeatmapDay {
                date,
                sessions: count as i32,
                finished: 0,
            },
        );
    }
    for (date, count) in finish_by_day {
        heatmap
            .entry(date.clone())
            .or_insert(ReadingHeatmapDay {
                date,
                sessions: 0,
                finished: 0,
            })
            .finished += count;
    }

    // 스트릭은 연도 경계를 넘는다 — 전체 세션 날짜에서 계산(개인 스케일이라 저비용).
    let all_session_dates: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT date FROM reading_sessions")
            .fetch_all(db)
            .await?;
    let parsed_dates: Vec<chrono::NaiveDate> = all_session_dates
        .iter()
        .filter_map(|(d,)| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .collect();
    let streak_days = crate::reading::streak_days(parsed_dates, today_date);

    let goal = sqlx::query_as::<_, ReadingGoal>(
        "SELECT year, target_books, created_at, updated_at FROM reading_goals WHERE year = ?1",
    )
    .bind(year)
    .fetch_optional(db)
    .await?;

    Ok(ReadingStats {
        year,
        total_books: status_counts.iter().map(|(_, n)| *n as i32).sum(),
        finished_total: count_of(ReadingStatus::Finished),
        reading_count: count_of(ReadingStatus::Reading),
        to_read_count: count_of(ReadingStatus::ToRead),
        abandoned_count: count_of(ReadingStatus::Abandoned),
        avg_rating,
        total_pages_read: total_pages_read as i32,
        finished_in_year: finished_dates.len() as i32,
        monthly_finished,
        goal,
        heatmap: heatmap.into_values().collect(),
        streak_days,
    })
}

pub(crate) async fn set_reading_goal_inner(
    db: &Db,
    year: i32,
    target_books: i32,
) -> Result<ReadingGoal, AppError> {
    if !(2000..=2100).contains(&year) {
        return Err(AppError::validation(
            "reading.goal.year",
            "year must be between 2000 and 2100",
        ));
    }
    if !(1..=1000).contains(&target_books) {
        return Err(AppError::validation(
            "reading.goal.target",
            "target_books must be between 1 and 1000",
        ));
    }
    Ok(sqlx::query_as::<_, ReadingGoal>(
        "INSERT INTO reading_goals (year, target_books) VALUES (?1, ?2) \
         ON CONFLICT(year) DO UPDATE SET target_books = excluded.target_books, \
           updated_at = datetime('now') \
         RETURNING year, target_books, created_at, updated_at",
    )
    .bind(year)
    .bind(target_books)
    .fetch_one(db)
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn reading_stats(
    db: State<'_, Db>,
    year: i32,
    today: String,
) -> Result<ReadingStats, AppError> {
    reading_stats_inner(db.inner(), year, &today).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_reading_goal(
    db: State<'_, Db>,
    year: i32,
    target_books: i32,
) -> Result<ReadingGoal, AppError> {
    set_reading_goal_inner(db.inner(), year, target_books).await
}

#[cfg(test)]
mod tests {
    use crate::commands::reading::books::tests::book_input;
    use crate::commands::reading::books::{add_book_inner, set_book_status_inner};
    use crate::commands::reading::sessions::log_reading_session_inner;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{LogReadingSessionInput, ReadingStatus, UpdateBookInput};

    #[tokio::test]
    async fn stats_aggregate_counts_monthly_heatmap_streak_and_goal() {
        let db = fresh_db().await;

        let a = add_book_inner(&db, book_input("하드씽", None))
            .await
            .unwrap()
            .book;
        let b = add_book_inner(&db, book_input("블루오션 시프트", None))
            .await
            .unwrap()
            .book;
        add_book_inner(&db, book_input("읽을 책", None))
            .await
            .unwrap();

        // a: 3월 완독 + 평점. b: 7월 읽는 중 + 세션 2일 연속.
        set_book_status_inner(&db, &a.id, ReadingStatus::Finished, "2026-03-10")
            .await
            .unwrap();
        crate::commands::reading::books::update_book_inner(
            &db,
            UpdateBookInput {
                id: a.id.clone(),
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
                rating: Some(9.0),
                clear_rating: None,
                review: None,
                clear_review: None,
                current_page: None,
                favorite: None,
                started_on: None,
                finished_on: None,
                clear: Vec::new(),
            },
        )
        .await
        .unwrap();
        for (date, page) in [("2026-07-22", 50), ("2026-07-23", 90)] {
            log_reading_session_inner(
                &db,
                LogReadingSessionInput {
                    book_id: b.id.clone(),
                    date: date.into(),
                    end_page: Some(page),
                    minutes: Some(25),
                    note: None,
                },
            )
            .await
            .unwrap();
        }
        super::set_reading_goal_inner(&db, 2026, 52).await.unwrap();

        let stats = super::reading_stats_inner(&db, 2026, "2026-07-23")
            .await
            .unwrap();
        assert_eq!(stats.total_books, 3);
        assert_eq!(stats.finished_total, 1);
        assert_eq!(stats.reading_count, 1, "세션이 to_read를 승격");
        assert_eq!(stats.to_read_count, 1);
        assert_eq!(stats.avg_rating, Some(9.0));
        assert_eq!(stats.total_pages_read, 412);
        assert_eq!(stats.finished_in_year, 1);
        assert_eq!(stats.monthly_finished[2], 1, "3월 버킷");
        assert_eq!(stats.goal.as_ref().map(|g| g.target_books), Some(52));
        assert_eq!(stats.streak_days, 2);

        // 히트맵: 세션 2일 + 완독일 1일 = 3셀, 완독일은 finished 카운트.
        assert_eq!(stats.heatmap.len(), 3);
        let finish_cell = stats
            .heatmap
            .iter()
            .find(|d| d.date == "2026-03-10")
            .unwrap();
        assert_eq!(finish_cell.finished, 1);
        assert_eq!(finish_cell.sessions, 0);

        // goal upsert 갱신.
        let updated = super::set_reading_goal_inner(&db, 2026, 40).await.unwrap();
        assert_eq!(updated.target_books, 40);
        assert!(super::set_reading_goal_inner(&db, 2026, 0).await.is_err());
    }

    #[tokio::test]
    async fn stats_on_empty_db_are_zeroed() {
        let db = fresh_db().await;
        let stats = super::reading_stats_inner(&db, 2026, "2026-07-23")
            .await
            .unwrap();
        assert_eq!(stats.total_books, 0);
        assert_eq!(stats.total_pages_read, 0);
        assert!(stats.avg_rating.is_none());
        assert!(stats.goal.is_none());
        assert!(stats.heatmap.is_empty());
        assert_eq!(stats.streak_days, 0);
    }
}
