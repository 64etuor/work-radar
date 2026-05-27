//! 루틴 트래킹 — 이행률/streak/히스토리 집계 (Phase 16 #12). 순수 read·로컬 집계(자동화 아님).

use chrono::NaiveDate;
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{AreaTag, Kind, RoutineFreq, RoutineHistoryDay, RoutineTrackingItem};

use super::schedule::{parse_weekdays, routine_due_on};

/// fetch_routine_tracking 조인 결과 (private — RoutineTrackingItem로 집계).
#[derive(sqlx::FromRow)]
struct TrackingRoutineRow {
    id: String,
    title: String,
    freq: RoutineFreq,
    weekdays: Option<String>,
    anchor_date: Option<String>,
    area: Option<AreaTag>,
    area_tags: Option<String>,
    kind: Option<Kind>,
}

/// 루틴 트래킹 집계(순수 read, 테스트 가능). 기간=[end-(days-1), end] 로컬 inclusive.
/// 루틴별로 due occurrence를 routine_due_on으로 열거하고, routine_checks와 대조해
/// 이행률·현재 streak·히스토리를 계산한다(자동화 아님 — 로컬 집계).
pub async fn fetch_routine_tracking(
    db: &Db,
    end_date: &str,
    days: u32,
) -> Result<Vec<RoutineTrackingItem>, sqlx::Error> {
    let end = NaiveDate::parse_from_str(end_date, "%Y-%m-%d")
        .map_err(|_| sqlx::Error::Protocol("bad end_date (YYYY-MM-DD)".into()))?;
    let span = days.max(1) as i64;
    let start = end - chrono::Duration::days(span - 1);

    let routines = sqlx::query_as::<_, TrackingRoutineRow>(
        "SELECT id, title, freq, weekdays, anchor_date, area, area_tags, kind FROM routines \
         WHERE active = 1 ORDER BY rank IS NULL, rank, created_at",
    )
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(routines.len());
    for TrackingRoutineRow {
        id,
        title,
        freq,
        weekdays: weekdays_json,
        anchor_date: anchor,
        area,
        area_tags,
        kind,
    } in routines
    {
        let weekdays = parse_weekdays(weekdays_json.as_deref());

        // 이 루틴의 체크 날짜 집합(기간 내).
        let check_rows: Vec<(String,)> = sqlx::query_as(
            "SELECT date FROM routine_checks WHERE routine_id = ?1 AND date BETWEEN ?2 AND ?3",
        )
        .bind(&id)
        .bind(start.format("%Y-%m-%d").to_string())
        .bind(end.format("%Y-%m-%d").to_string())
        .fetch_all(db)
        .await?;
        let checked: std::collections::HashSet<String> =
            check_rows.into_iter().map(|(d,)| d).collect();

        // due occurrence 열거(오래된→최신).
        let mut history: Vec<RoutineHistoryDay> = Vec::new();
        let mut due = 0u32;
        let mut done = 0u32;
        let mut d = start;
        while d <= end {
            if routine_due_on(freq, &weekdays, anchor.as_deref(), d) {
                let ds = d.format("%Y-%m-%d").to_string();
                let is_done = checked.contains(&ds);
                due += 1;
                if is_done {
                    done += 1;
                }
                history.push(RoutineHistoryDay {
                    date: ds,
                    done: is_done,
                });
            }
            d += chrono::Duration::days(1);
        }

        // 현재 streak: 최신 due부터 거꾸로 연속 체크.
        let mut streak = 0u32;
        for h in history.iter().rev() {
            if h.done {
                streak += 1;
            } else {
                break;
            }
        }

        let rate_pct = (done * 100).checked_div(due).unwrap_or(0).min(100);
        out.push(RoutineTrackingItem {
            id,
            title,
            freq,
            area,
            area_tags,
            kind,
            due,
            done,
            rate_pct,
            streak,
            history,
        });
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn routine_tracking(
    db: State<'_, Db>,
    end_date: String,
    days: u32,
) -> Result<Vec<RoutineTrackingItem>, AppError> {
    fetch_routine_tracking(db.inner(), &end_date, days)
        .await
        .map_err(AppError::from)
}
