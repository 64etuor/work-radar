//! 오늘 해당하는 루틴 조회 + 날짜별 완료 상태. 조회 시 due·시각 루틴 알림을 멱등 enqueue한다.

use chrono::NaiveDate;
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{Kind, RoutineFreq, RoutineToday, Weekday};

use super::reminders::sync_reminders;
use super::schedule::{parse_weekdays, routine_due_on};

/// list_today_routines 조인 결과 (private — RoutineToday로 매핑).
#[derive(sqlx::FromRow)]
struct RoutineRow {
    id: String,
    title: String,
    freq: RoutineFreq,
    weekdays: Option<String>,
    anchor_date: Option<String>,
    time_of_day: Option<String>,
    reminder_offset_min: Option<i64>,
    area: Option<crate::models::AreaTag>,
    kind: Option<Kind>,
    done: bool,
}

/// 오늘 해당하는 루틴 + 날짜별 완료 상태. 신규 freq는 routine_due_on으로 계산한다.
pub async fn fetch_today_routines(
    db: &Db,
    date: &str,
    _weekday: Weekday,
) -> Result<Vec<RoutineToday>, sqlx::Error> {
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| sqlx::Error::Protocol("bad date (YYYY-MM-DD)".into()))?;
    let rows = sqlx::query_as::<_, RoutineRow>(
        "SELECT r.id, r.title, r.freq, r.weekdays, r.anchor_date, r.time_of_day, \
                r.reminder_offset_min, r.area, r.kind, \
                (rc.id IS NOT NULL) AS done \
         FROM routines r \
         LEFT JOIN routine_checks rc ON rc.routine_id = r.id AND rc.date = ?1 \
         WHERE r.active = 1 ORDER BY r.rank IS NULL, r.rank, r.created_at",
    )
    .bind(date)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let weekdays = parse_weekdays(r.weekdays.as_deref());
            if !routine_due_on(r.freq, &weekdays, r.anchor_date.as_deref(), parsed) {
                return None;
            }
            Some(RoutineToday {
                id: r.id,
                title: r.title,
                freq: r.freq,
                weekdays,
                anchor_date: r.anchor_date,
                time_of_day: r.time_of_day,
                reminder_offset_min: r.reminder_offset_min.map(|v| v.max(0) as u32),
                area: r.area,
                kind: r.kind,
                done: r.done,
            })
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn list_today_routines(
    db: State<'_, Db>,
    date: String,
    weekday: Weekday,
) -> Result<Vec<RoutineToday>, AppError> {
    let routines = fetch_today_routines(db.inner(), &date, weekday)
        .await
        .map_err(AppError::from)?;
    // 오늘 due이고 시각이 있는 루틴의 알림을 멱등 enqueue(스케줄러가 발사). 실패해도 목록은 반환.
    if let Err(e) = sync_reminders(db.inner(), &date, &routines).await {
        eprintln!("[routines] reminder sync failed (date={date}): {e}");
    }
    Ok(routines)
}
