//! 루틴 생성/수정/삭제/재정렬 + 날짜별 완료 토글 (반복 작업, 별개 엔티티).

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{CreateRoutineInput, RoutineFreq, RoutineToday, UpdateRoutineInput};
use crate::scheduler::utc_now_string;

use super::reminders::reminder_source_id;

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
