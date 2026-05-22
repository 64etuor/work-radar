use chrono::{Datelike, NaiveDate};
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    CreateRoutineInput, Kind, RoutineFreq, RoutineHistoryDay, RoutineToday, RoutineTrackingItem,
    UpdateRoutineInput, Weekday,
};
use crate::scheduler::utc_now_string;

// ── Routines (반복 작업, 별개 엔티티) ─────────────────────────────────────────

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

/// fetch_routine_tracking 조인 결과 (private — RoutineTrackingItem로 집계).
#[derive(sqlx::FromRow)]
struct TrackingRoutineRow {
    id: String,
    title: String,
    freq: RoutineFreq,
    weekdays: Option<String>,
    anchor_date: Option<String>,
}

/// weekdays JSON 컬럼('["wed","fri"]') → Vec<Weekday>. 누락/형식오류는 빈 목록.
pub fn parse_weekdays(raw: Option<&str>) -> Vec<Weekday> {
    raw.and_then(|s| serde_json::from_str::<Vec<Weekday>>(s).ok())
        .unwrap_or_default()
}

/// chrono Weekday → 루틴 weekdays JSON에 쓰는 소문자 3글자 키.
fn weekday_key(d: chrono::Weekday) -> &'static str {
    use chrono::Weekday::*;
    match d {
        Mon => "mon",
        Tue => "tue",
        Wed => "wed",
        Thu => "thu",
        Fri => "fri",
        Sat => "sat",
        Sun => "sun",
    }
}

/// 한 날짜의 day-of-month가 monthly anchor day에 해당하는가 (월말 클램프).
/// anchor day 31은 30일 달에선 30일에, 2월엔 28/29일에 due가 된다(그달 말일로 클램프).
fn monthly_due(anchor: NaiveDate, date: NaiveDate) -> bool {
    let last_dom = last_day_of_month(date.year(), date.month());
    let target = anchor.day().min(last_dom);
    date.day() == target
}

/// 주어진 연/월의 말일(28..=31).
fn last_day_of_month(year: i32, month: u32) -> u32 {
    // 다음 달 1일에서 하루 빼면 이번 달 말일.
    let (ny, nm) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_next = NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid first-of-month");
    (first_next - chrono::Duration::days(1)).day()
}

/// **순수 due-calc** — 주어진 날짜에 루틴이 해당(due)하는지. Daily/Weekly/Biweekly/Monthly.
/// weekdays는 weekly/biweekly에서만 의미, anchor는 biweekly(주 parity)·monthly(day) 기준.
/// anchor가 없거나 날짜 파싱 실패면 보수적으로 false(스케줄 불명 → 표시 안 함).
pub fn routine_due_on(
    freq: RoutineFreq,
    weekdays: &[Weekday],
    anchor: Option<&str>,
    date: NaiveDate,
) -> bool {
    let wk = weekday_key(date.weekday());
    match freq {
        RoutineFreq::Daily => true,
        RoutineFreq::Weekly => weekdays.iter().any(|w| weekday_enum_key(*w) == wk),
        RoutineFreq::Biweekly => {
            // 선택 요일이면서 anchor 기준 주 parity가 맞을 때만(14일 주기).
            if !weekdays.iter().any(|w| weekday_enum_key(*w) == wk) {
                return false;
            }
            let Some(anchor) = anchor.and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            else {
                return false;
            };
            // 주 경계 parity: 각 날짜를 일요일 기준 주 인덱스로 환산해 14일(2주) parity 비교.
            // (days_since_anchor_week / 7) % 2 == 0 과 등가지만, 음수/요일 어긋남에 안정적이도록
            // 두 날짜의 "월요일 기준 주 시작"의 일수 차이로 계산한다.
            let anchor_week = week_start(anchor);
            let date_week = week_start(date);
            let weeks = (date_week - anchor_week).num_days() / 7;
            weeks % 2 == 0
        }
        RoutineFreq::Monthly => {
            let Some(anchor) = anchor.and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            else {
                return false;
            };
            monthly_due(anchor, date)
        }
    }
}

/// 그 날이 속한 주의 월요일(주 시작) 날짜. parity 계산 기준을 요일과 무관하게 만든다.
fn week_start(d: NaiveDate) -> NaiveDate {
    let days_from_mon = d.weekday().num_days_from_monday() as i64;
    d - chrono::Duration::days(days_from_mon)
}

/// Weekday enum → 소문자 키 (weekdays JSON 매칭용).
fn weekday_enum_key(w: Weekday) -> &'static str {
    match w {
        Weekday::Mon => "mon",
        Weekday::Tue => "tue",
        Weekday::Wed => "wed",
        Weekday::Thu => "thu",
        Weekday::Fri => "fri",
        Weekday::Sat => "sat",
        Weekday::Sun => "sun",
    }
}

/// 루틴 추가. weekly/biweekly면 weekdays, biweekly/monthly면 anchor_date(비면 오늘) 사용.
pub async fn insert_routine(
    db: &Db,
    input: &CreateRoutineInput,
) -> Result<RoutineToday, sqlx::Error> {
    let weekdays_json = serde_json::to_string(&input.weekdays).unwrap_or_else(|_| "[]".into());
    // biweekly/monthly는 anchor가 필요하다 — 입력이 없으면 오늘(로컬 날짜)로 채운다.
    let anchor = match input.freq {
        RoutineFreq::Biweekly | RoutineFreq::Monthly => Some(
            input
                .anchor_date
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(local_today),
        ),
        RoutineFreq::Daily | RoutineFreq::Weekly => None,
    };
    let time_of_day = input.time_of_day.clone().filter(|s| !s.trim().is_empty());
    let offset = input.reminder_offset_min.map(|v| v as i64);

    let row: (String,) = sqlx::query_as(
        "INSERT INTO routines \
           (id, title, freq, weekdays, anchor_date, time_of_day, reminder_offset_min, area, kind) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id",
    )
    .bind(input.title.trim())
    .bind(input.freq)
    .bind(&weekdays_json)
    .bind(&anchor)
    .bind(&time_of_day)
    .bind(offset)
    .bind(input.area)
    .bind(input.kind)
    .fetch_one(db)
    .await?;

    Ok(RoutineToday {
        id: row.0,
        title: input.title.trim().to_string(),
        freq: input.freq,
        weekdays: input.weekdays.clone(),
        anchor_date: anchor,
        time_of_day,
        reminder_offset_min: input.reminder_offset_min,
        area: input.area,
        kind: input.kind,
        done: false,
    })
}

/// 로컬 오늘 날짜(YYYY-MM-DD).
fn local_today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[tauri::command]
#[specta::specta]
pub async fn create_routine(
    db: State<'_, Db>,
    input: CreateRoutineInput,
) -> Result<RoutineToday, AppError> {
    insert_routine(db.inner(), &input)
        .await
        .map_err(AppError::from)
}

/// 루틴 수정. 필드 업데이트 후 미발사 루틴 알림을 삭제(다음 list_today_routines에서 재enqueue).
#[tauri::command]
#[specta::specta]
pub async fn update_routine(db: State<'_, Db>, input: UpdateRoutineInput) -> Result<(), AppError> {
    update_routine_inner(db.inner(), input)
        .await
        .map_err(AppError::from)
}

pub async fn update_routine_inner(db: &Db, input: UpdateRoutineInput) -> Result<(), sqlx::Error> {
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err(sqlx::Error::Protocol("title must not be empty".into()));
    }
    let weekdays_json = serde_json::to_string(&input.weekdays).unwrap_or_else(|_| "[]".into());

    // biweekly/monthly는 anchor 필요 — 입력이 비면 기존 anchor 유지, 없으면 오늘로.
    let anchor = match input.freq {
        RoutineFreq::Biweekly | RoutineFreq::Monthly => {
            if let Some(a) = input.anchor_date.as_ref().filter(|s| !s.trim().is_empty()) {
                Some(a.clone())
            } else {
                // 기존 anchor 조회.
                let row: Option<(Option<String>,)> =
                    sqlx::query_as("SELECT anchor_date FROM routines WHERE id = ?1")
                        .bind(&input.id)
                        .fetch_optional(db)
                        .await?;
                match row {
                    None => return Err(sqlx::Error::RowNotFound),
                    Some((existing,)) => Some(existing.unwrap_or_else(local_today)),
                }
            }
        }
        RoutineFreq::Daily | RoutineFreq::Weekly => None,
    };

    let time_of_day = input.time_of_day.clone().filter(|s| !s.trim().is_empty());
    let offset = input.reminder_offset_min.map(|v| v as i64);

    let result = sqlx::query(
        "UPDATE routines SET title=?2, freq=?3, weekdays=?4, anchor_date=?5, \
         time_of_day=?6, reminder_offset_min=?7, area=?8, kind=?9 WHERE id=?1",
    )
    .bind(&input.id)
    .bind(&title)
    .bind(input.freq)
    .bind(&weekdays_json)
    .bind(&anchor)
    .bind(&time_of_day)
    .bind(offset)
    .bind(input.area)
    .bind(input.kind)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    // 미발사 루틴 알림 삭제 — 다음 list_today_routines 호출 시 새 시간으로 재enqueue됨.
    // LIKE 패턴: 'routine:{id}:%' (발사된 rows는 보존 — 히스토리).
    let pattern = format!("routine:{}:%", input.id);
    sqlx::query(
        "DELETE FROM scheduled_notifications \
         WHERE source='routine' AND source_id LIKE ?1 AND fired_at IS NULL",
    )
    .bind(&pattern)
    .execute(db)
    .await?;

    Ok(())
}

/// 루틴 삭제. 트랜잭션: 미발사 알림 + routine_checks + routines 행 삭제.
/// 발사된 알림 행(히스토리)은 보존. 루틴 없으면 오류 반환.
#[tauri::command]
#[specta::specta]
pub async fn delete_routine(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_routine_inner(db.inner(), id)
        .await
        .map_err(AppError::from)
}

pub async fn delete_routine_inner(db: &Db, id: String) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;

    // 미발사 루틴 알림 삭제 (발사된 rows는 보존).
    let pattern = format!("routine:{id}:%");
    sqlx::query(
        "DELETE FROM scheduled_notifications \
         WHERE source='routine' AND source_id LIKE ?1 AND fired_at IS NULL",
    )
    .bind(&pattern)
    .execute(&mut *tx)
    .await?;

    // routine_checks 삭제 (FK ON DELETE CASCADE로도 처리되지만 명시적으로).
    sqlx::query("DELETE FROM routine_checks WHERE routine_id = ?1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;

    // 루틴 본체 삭제.
    let result = sqlx::query("DELETE FROM routines WHERE id = ?1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;

    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    tx.commit().await?;
    Ok(())
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

/// 루틴 완료 토글 (날짜별). done이면 RoutineCheck 추가, 아니면 삭제 → 다음날 자동 리셋.
/// 완료(done=true) 시 그 루틴의 오늘 알림을 fired 처리해 더는 발사되지 않게 한다(완료=알림 불필요).
#[tauri::command]
#[specta::specta]
pub async fn toggle_routine_check(
    db: State<'_, Db>,
    routine_id: String,
    date: String,
    done: bool,
) -> Result<(), AppError> {
    if done {
        sqlx::query(
            "INSERT OR IGNORE INTO routine_checks (id, routine_id, date) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2)",
        )
        .bind(&routine_id)
        .bind(&date)
        .execute(db.inner())
        .await
        .map_err(AppError::from)?;

        // 완료된 루틴은 오늘 알림을 발사하지 않는다 — 미발사 행을 fired로 마킹(skip).
        let source_id = reminder_source_id(&routine_id, &date);
        sqlx::query(
            "UPDATE scheduled_notifications SET fired_at = ?2 \
             WHERE source = 'routine' AND source_id = ?1 AND fired_at IS NULL",
        )
        .bind(&source_id)
        .bind(utc_now_string())
        .execute(db.inner())
        .await
        .map_err(AppError::from)?;
    } else {
        sqlx::query("DELETE FROM routine_checks WHERE routine_id = ?1 AND date = ?2")
            .bind(&routine_id)
            .bind(&date)
            .execute(db.inner())
            .await
            .map_err(AppError::from)?;
    }
    Ok(())
}

/// 루틴 재정렬 (드래그, 공용 useListReorder). ordered_ids 순서대로 rank 부여.
#[tauri::command]
#[specta::specta]
pub async fn reorder_routines(db: State<'_, Db>, ordered_ids: Vec<String>) -> Result<(), AppError> {
    let mut tx = db.inner().begin().await.map_err(AppError::from)?;
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE routines SET rank = ?2 WHERE id = ?1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await
            .map_err(AppError::from)?;
    }
    tx.commit().await.map_err(AppError::from)
}

// ── 알림 enqueue (시간 + 오프셋, Phase 16 #6) ──────────────────────────────────
//
// INVARIANT #5: 스케줄러는 Phase 13 스파인이 bounded tick으로 발사한다 — 여기선 행 INSERT만.
//   deterministic source_id로 멱등(하루 한 번만 enqueue). 발사·재시도는 스케줄러가 담당.

/// 한 루틴의 하루치 알림 식별자 (멱등 dedup·완료 skip 키).
fn reminder_source_id(routine_id: &str, date: &str) -> String {
    format!("routine:{routine_id}:{date}")
}

/// `date`(로컬, YYYY-MM-DD) + `time_of_day`(HH:MM) - offset 의 발사 시각을 UTC 'YYYY-MM-DD HH:MM:SS'로.
/// 파싱 실패면 None(스케줄 불명 → enqueue 안 함, graceful).
fn compute_fire_at(date: &str, time_of_day: &str, offset_min: u32) -> Option<String> {
    use chrono::{Local, NaiveDateTime, TimeZone};
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let t = chrono::NaiveTime::parse_from_str(time_of_day, "%H:%M").ok()?;
    let naive = NaiveDateTime::new(d, t) - chrono::Duration::minutes(offset_min as i64);
    // 로컬 벽시계 시각 → UTC. (DST 모호/불가 시 단일 결과를 취해 graceful.)
    let local_dt = Local.from_local_datetime(&naive).single()?;
    Some(
        local_dt
            .with_timezone(&chrono::Utc)
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
    )
}

/// 오늘 due이고 time_of_day가 있는 루틴들의 알림을 멱등 enqueue한다(INSERT OR IGNORE on source_id).
/// 이미 완료(체크)된 루틴은 enqueue하지 않는다(완료=알림 불필요). source_id UNIQUE 보장이 없으므로
/// "존재하면 skip"으로 멱등을 강제한다 — 하루 한 번만 행이 생긴다.
pub async fn sync_reminders(
    db: &Db,
    date: &str,
    routines: &[RoutineToday],
) -> Result<(), sqlx::Error> {
    for r in routines {
        let Some(time) = r.time_of_day.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if r.done {
            continue; // 완료된 루틴은 알림 불필요.
        }
        let offset = r.reminder_offset_min.unwrap_or(0);
        let Some(fire_at) = compute_fire_at(date, time, offset) else {
            continue;
        };
        let source_id = reminder_source_id(&r.id, date);

        // 멱등: 같은 source_id 행이 (미발사든 발사든) 이미 있으면 새로 만들지 않는다.
        let exists: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM scheduled_notifications WHERE source = 'routine' AND source_id = ?1 LIMIT 1",
        )
        .bind(&source_id)
        .fetch_optional(db)
        .await?;
        if exists.is_some() {
            continue;
        }

        let title = format!("루틴: {}", r.title);
        let body = if offset > 0 {
            format!("{time} 예정 ({offset}분 전 알림)")
        } else {
            format!("{time} 예정")
        };
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'routine', ?4)",
        )
        .bind(&fire_at)
        .bind(&title)
        .bind(&body)
        .bind(&source_id)
        .execute(db)
        .await?;
    }
    Ok(())
}

// ── 트래킹 (이행률/streak/히스토리, Phase 16 #12) ──────────────────────────────

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
        "SELECT id, title, freq, weekdays, anchor_date FROM routines \
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::models::RoutineFreq;

    fn nd(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// 루틴: 오늘 요일 매칭 + 날짜별 완료 토글 → 다음날 리셋.
    #[tokio::test]
    async fn routine_today_matching_and_per_date_check() {
        let db = fresh_db().await;
        // 수·금 루틴.
        insert_routine(
            &db,
            &CreateRoutineInput {
                title: "주간 회고".into(),
                freq: RoutineFreq::Weekly,
                weekdays: vec![Weekday::Wed, Weekday::Fri],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: Some(Kind::Work),
            },
        )
        .await
        .unwrap();

        // 금요일이면 표시, 목요일이면 미표시.
        let fri = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(fri.len(), 1);
        assert!(!fri[0].done);
        let thu = fetch_today_routines(&db, "2026-05-21", Weekday::Thu)
            .await
            .unwrap();
        assert!(thu.is_empty(), "목요일엔 수·금 루틴 미표시");

        // 금요일 완료 체크 → 그날만 done.
        let rid = fri[0].id.clone();
        toggle_check(&db, &rid, "2026-05-22", true).await;
        let fri_done = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert!(fri_done[0].done);
    }

    /// monthly: anchor day와 같은 day-of-month면 due. 월말 클램프(31 → 그달 말일).
    #[test]
    fn monthly_due_calc_with_month_end_clamp() {
        // anchor=1/15 → 매월 15일.
        let a15 = nd("2026-01-15");
        assert!(routine_due_on(
            RoutineFreq::Monthly,
            &[],
            Some("2026-01-15"),
            nd("2026-03-15")
        ));
        assert!(!routine_due_on(
            RoutineFreq::Monthly,
            &[],
            Some("2026-01-15"),
            nd("2026-03-14")
        ));
        let _ = a15;

        // anchor=1/31 → 2월(28일)엔 28일에 due(클램프), 31일짜리 달엔 31일.
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-02-28")
            ),
            "2월 말일로 클램프"
        );
        assert!(
            !routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-02-27")
            ),
            "2/27은 due 아님"
        );
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-03-31")
            ),
            "3월 31일은 그대로 due"
        );
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-04-30")
            ),
            "4월(30일)은 30일로 클램프"
        );
        // 윤년 2/29.
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2024-01-31"),
                nd("2024-02-29")
            ),
            "윤년 2월은 29일로 클램프"
        );
    }

    /// monthly: anchor 없으면 보수적으로 due 아님.
    #[test]
    fn monthly_without_anchor_is_not_due() {
        assert!(!routine_due_on(
            RoutineFreq::Monthly,
            &[],
            None,
            nd("2026-05-15")
        ));
    }

    /// biweekly: 선택 요일 + anchor 기준 14일 parity. anchor 주는 due, 다음 주는 아님, 그 다음 주 due.
    #[test]
    fn biweekly_parity_calc() {
        // anchor=금 2026-05-22, 요일=금. 같은 주(앵커 주) due.
        let anchor = "2026-05-22";
        let days = [Weekday::Fri];
        assert!(
            routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-05-22")),
            "앵커 당일(금) due"
        );
        // 1주 뒤 금(5/29) → parity off → 아님.
        assert!(
            !routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-05-29")),
            "1주 뒤는 격주 off"
        );
        // 2주 뒤 금(6/5) → parity on → due.
        assert!(
            routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-06-05")),
            "2주 뒤는 격주 on"
        );
        // 앵커 주여도 다른 요일이면 아님(목 5/21).
        assert!(
            !routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-05-21")),
            "선택 요일 아니면 아님"
        );
    }

    /// biweekly: anchor 이전 날짜(과거)도 parity가 맞으면 due (음수 weeks 안정).
    #[test]
    fn biweekly_parity_before_anchor() {
        let anchor = "2026-05-22"; // 금
        let days = [Weekday::Fri];
        // 2주 전 금(5/8) → parity on.
        assert!(routine_due_on(
            RoutineFreq::Biweekly,
            &days,
            Some(anchor),
            nd("2026-05-08")
        ));
        // 1주 전 금(5/15) → parity off.
        assert!(!routine_due_on(
            RoutineFreq::Biweekly,
            &days,
            Some(anchor),
            nd("2026-05-15")
        ));
    }

    /// daily는 항상 due, weekly는 요일만.
    #[test]
    fn daily_and_weekly_due() {
        assert!(routine_due_on(
            RoutineFreq::Daily,
            &[],
            None,
            nd("2026-05-22")
        ));
        assert!(routine_due_on(
            RoutineFreq::Weekly,
            &[Weekday::Fri],
            None,
            nd("2026-05-22")
        ));
        assert!(!routine_due_on(
            RoutineFreq::Weekly,
            &[Weekday::Mon],
            None,
            nd("2026-05-22")
        ));
    }

    /// 트래킹: daily 7일, 체크 3 → 이행률 42%, 최신 연속 체크면 streak 반영.
    #[tokio::test]
    async fn tracking_adherence_streak_history() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "물 마시기".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();
        // end=2026-05-22, days=7 → 5/16..5/22. 최근 3일(5/20,21,22) 체크.
        for d in ["2026-05-20", "2026-05-21", "2026-05-22"] {
            toggle_check(&db, &r.id, d, true).await;
        }
        let tracking = fetch_routine_tracking(&db, "2026-05-22", 7).await.unwrap();
        assert_eq!(tracking.len(), 1);
        let t = &tracking[0];
        assert_eq!(t.due, 7, "daily × 7일");
        assert_eq!(t.done, 3);
        assert_eq!(t.rate_pct, 42, "3/7 = 42%");
        assert_eq!(t.streak, 3, "최신 3일 연속");
        assert_eq!(t.history.len(), 7);
        assert!(t.history.last().unwrap().done, "5/22 체크됨");
        assert!(!t.history[0].done, "5/16 미체크");
    }

    /// 알림 enqueue: time_of_day 있는 due 루틴은 fire_at 행을 멱등 INSERT(두 번 호출해도 1행).
    #[tokio::test]
    async fn reminder_enqueue_idempotent() {
        let db = fresh_db().await;
        insert_routine(
            &db,
            &CreateRoutineInput {
                title: "아침 운동".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: Some(30),
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();

        // list_today_routines 경로가 sync를 호출한다 — fetch + sync 두 번.
        let r1 = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &r1).await.unwrap();
        sync_reminders(&db, "2026-05-22", &r1).await.unwrap();

        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM scheduled_notifications WHERE source = 'routine'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 1, "멱등 — 하루 한 행만");
    }

    /// 완료한 루틴은 알림을 발사하지 않는다: toggle done이 미발사 행을 fired로 마킹.
    #[tokio::test]
    async fn completed_routine_marks_reminder_fired() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "약 먹기".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("21:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();
        let today = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &today).await.unwrap();

        // 완료 토글 → 미발사 행이 fired로.
        toggle_done(&db, &r.id, "2026-05-22").await;

        let (unfired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications \
             WHERE source = 'routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired, 0, "완료 루틴 알림은 fired로 skip");
    }

    /// 정렬: reorder_routines가 rank를 부여하고 list가 rank 순으로 반환.
    #[tokio::test]
    async fn reorder_persists_rank_order() {
        let db = fresh_db().await;
        let a = insert_daily(&db, "A").await;
        let b = insert_daily(&db, "B").await;
        let c = insert_daily(&db, "C").await;
        // 순서 C, A, B로 재정렬.
        reorder(&db, &[&c, &a, &b]).await;
        let list = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        let titles: Vec<&str> = list.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["C", "A", "B"]);
    }

    /// update_routine: 필드 변경 후 미발사 알림 삭제, 발사된 알림은 보존.
    #[tokio::test]
    async fn update_routine_clears_unfired_keeps_fired() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "기존 루틴".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("08:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();

        // 미발사 알림 enqueue.
        let routines = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &routines).await.unwrap();

        // 발사된 알림 행을 수동 삽입 (fired_at 있음).
        let fired_source_id = format!("routine:{}:2026-05-21", r.id);
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id, fired_at) \
             VALUES (lower(hex(randomblob(16))), '2026-05-21 08:00:00', '루틴: 기존 루틴', 'test', \
             'routine', ?1, '2026-05-21 08:00:01')",
        )
        .bind(&fired_source_id)
        .execute(&db)
        .await
        .unwrap();

        // 미발사 1개, 발사 1개.
        let (unfired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired, 1);

        // 루틴 수정 (제목 + 시간 변경).
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: r.id.clone(),
                title: "수정된 루틴".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("09:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();

        // 미발사 알림 삭제됨.
        let (unfired_after,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired_after, 0, "미발사 알림은 삭제됨");

        // 발사된 알림은 보존됨.
        let (fired_after,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NOT NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(fired_after, 1, "발사된 알림은 보존됨");

        // 제목 변경 확인.
        let updated = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(updated[0].title, "수정된 루틴");
    }

    /// delete_routine: 루틴 + routine_checks + 미발사 알림 삭제, 발사된 알림 보존, 다른 루틴 무손상.
    #[tokio::test]
    async fn delete_routine_removes_checks_and_unfired_keeps_fired_and_others() {
        let db = fresh_db().await;
        let r1 = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "삭제 대상".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();

        let r2 = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "다른 루틴".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();

        // r1 체크 추가.
        toggle_check(&db, &r1.id, "2026-05-22", true).await;

        // r1 미발사 알림 enqueue.
        let routines = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &routines).await.unwrap();

        // r1의 발사된 알림 행 수동 삽입.
        let fired_source_id = format!("routine:{}:2026-05-21", r1.id);
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id, fired_at) \
             VALUES (lower(hex(randomblob(16))), '2026-05-21 07:00:00', '루틴: 삭제 대상', 'test', \
             'routine', ?1, '2026-05-21 07:00:01')",
        )
        .bind(&fired_source_id)
        .execute(&db)
        .await
        .unwrap();

        // 삭제 전: r1 체크 1개, r1 미발사 1개, r1 발사 1개.
        let (checks,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM routine_checks WHERE routine_id = ?1")
                .bind(&r1.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(checks, 1);

        // r1 삭제.
        delete_routine_inner(&db, r1.id.clone()).await.unwrap();

        // 루틴 행 삭제 확인.
        let (r1_exists,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM routines WHERE id = ?1")
            .bind(&r1.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(r1_exists, 0, "루틴 행 삭제됨");

        // routine_checks 삭제 확인.
        let (checks_after,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM routine_checks WHERE routine_id = ?1")
                .bind(&r1.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(checks_after, 0, "routine_checks 삭제됨");

        // 미발사 알림 삭제 확인.
        let (unfired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired, 0, "미발사 알림 삭제됨");

        // 발사된 알림 보존 확인.
        let (fired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NOT NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(fired, 1, "발사된 알림은 보존됨");

        // 다른 루틴(r2) 무손상 확인.
        let remaining = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, r2.id, "다른 루틴은 무손상");
    }

    // ── 테스트 헬퍼 (command 본문과 동일 로직, State 없이) ──────────────────────
    async fn insert_daily(db: &Db, title: &str) -> String {
        insert_routine(
            db,
            &CreateRoutineInput {
                title: title.into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn reorder(db: &Db, ids: &[&String]) {
        let mut tx = db.begin().await.unwrap();
        for (i, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE routines SET rank = ?2 WHERE id = ?1")
                .bind(*id)
                .bind(i as i32)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }

    async fn toggle_check(db: &Db, routine_id: &str, date: &str, done: bool) {
        if done {
            sqlx::query(
                "INSERT OR IGNORE INTO routine_checks (id, routine_id, date) \
                 VALUES (lower(hex(randomblob(16))), ?1, ?2)",
            )
            .bind(routine_id)
            .bind(date)
            .execute(db)
            .await
            .unwrap();
        }
    }

    async fn toggle_done(db: &Db, routine_id: &str, date: &str) {
        toggle_check(db, routine_id, date, true).await;
        let source_id = reminder_source_id(routine_id, date);
        sqlx::query(
            "UPDATE scheduled_notifications SET fired_at = ?2 \
             WHERE source = 'routine' AND source_id = ?1 AND fired_at IS NULL",
        )
        .bind(&source_id)
        .bind(utc_now_string())
        .execute(db)
        .await
        .unwrap();
    }
}
