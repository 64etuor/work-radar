//! 루틴 생성/수정/삭제/재정렬 + 날짜별 완료 토글 (반복 작업, 별개 엔티티).

use tauri::State;

use crate::commands::notification_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    CreateRoutineInput, RoutineFreq, RoutineMonthlyPattern, RoutineToday, UpdateRoutineInput,
    Weekday,
};
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
    // monthly 패턴 필드는 monthly일 때만 의미 — 그 외 freq면 무시(NULL 저장).
    let (monthly_pattern, monthly_nth_week) = match input.freq {
        RoutineFreq::Monthly => (input.monthly_pattern, input.monthly_nth_week),
        _ => (None, None),
    };
    let duration = input.duration_min.map(|v| v as i64);

    let row: (String,) = sqlx::query_as(
        "INSERT INTO routines \
           (id, title, freq, weekdays, anchor_date, time_of_day, reminder_offset_min, area, kind, \
            monthly_pattern, monthly_nth_week, duration_min) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id",
    )
    .bind(input.title.trim())
    .bind(input.freq)
    .bind(&weekdays_json)
    .bind(&anchor)
    .bind(&time_of_day)
    .bind(offset)
    .bind(input.area)
    .bind(input.kind)
    .bind(monthly_pattern)
    .bind(monthly_nth_week)
    .bind(duration)
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
        area_tags: None,
        kind: input.kind,
        done: false,
        // 신규 루틴은 오늘 routine_checks 행이 없으므로 모두 None.
        time_override: None,
        linked_event_id: None,
        linked_calendar_id: None,
        monthly_pattern,
        monthly_nth_week,
        duration_min: input.duration_min,
        // 생성 직후는 sync OFF — 토글 IPC가 채운다.
        google_event_id: None,
        google_calendar_id: None,
    })
}

/// 로컬 오늘 날짜(YYYY-MM-DD).
fn local_today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// IPC-boundary 검증 (plan §5 PR 2b-3 진입 조건). DB CHECK은 `monthly_nth_week` **범위**만 본다 —
/// nth_weekday 패턴의 교차 필드 계약(주차 존재 + 요일 정확히 1개)은 애플리케이션이 보증해야
/// sync(rrule 매핑)와 로컬 nth_weekday due-calc가 어긋나지 않는다. monthly가 아니면 패턴 필드는
/// 저장 시 NULL로 정리되므로 검증 불필요.
// AppError 단일 envelope — Result<_, AppError> 통일(코드베이스 관례, agents/pr_radar와 동일).
#[allow(clippy::result_large_err)]
pub(crate) fn validate_monthly_input(
    freq: RoutineFreq,
    monthly_pattern: Option<RoutineMonthlyPattern>,
    monthly_nth_week: Option<i32>,
    weekdays: &[Weekday],
) -> Result<(), AppError> {
    if !matches!(freq, RoutineFreq::Monthly) {
        return Ok(());
    }
    if let Some(RoutineMonthlyPattern::NthWeekday) = monthly_pattern {
        let nth = monthly_nth_week.ok_or_else(|| {
            AppError::validation(
                "routine.monthly.nth_week_required",
                "N번째 요일 패턴은 주차(첫째~다섯째 또는 마지막)가 필요합니다",
            )
        })?;
        if nth == 0 || !(-1..=5).contains(&nth) {
            return Err(AppError::validation(
                "routine.monthly.nth_week_out_of_range",
                "주차는 1~5 또는 -1(마지막)이어야 합니다",
            ));
        }
        if weekdays.len() != 1 {
            return Err(AppError::validation(
                "routine.monthly.nth_weekday_single",
                "N번째 요일 패턴은 요일을 정확히 하나 선택하세요",
            ));
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn create_routine(
    db: State<'_, Db>,
    input: CreateRoutineInput,
) -> Result<RoutineToday, AppError> {
    validate_monthly_input(
        input.freq,
        input.monthly_pattern,
        input.monthly_nth_week,
        &input.weekdays,
    )?;
    insert_routine(db.inner(), &input)
        .await
        .map_err(AppError::from)
}

/// 루틴 수정. 필드 업데이트 후 미발사 루틴 알림을 삭제(다음 list_today_routines에서 재enqueue).
#[tauri::command]
#[specta::specta]
pub async fn update_routine(db: State<'_, Db>, input: UpdateRoutineInput) -> Result<(), AppError> {
    validate_monthly_input(
        input.freq,
        input.monthly_pattern,
        input.monthly_nth_week,
        &input.weekdays,
    )?;
    let routine_id = input.id.clone();
    update_routine_inner(db.inner(), input)
        .await
        .map_err(AppError::from)?;
    // 로컬 업데이트 성공(커밋됨). 동기화된 루틴이면 스케줄 변경을 Google master event에 PATCH 전파(PR 3).
    // 사용자 폼 저장 = 사람 결정이므로 Acceptance 게이트 불요(#2). 미동기화면 토큰 조회 없이 no-op.
    // 전파 실패는 로컬 변경을 되돌리지 않는다 — patch_failed로 wrap해 "저장됐지만 동기화 실패"를
    // 프런트가 toast로 surface(프런트는 onSettled로 routines 무효화 → 로컬 변경은 화면에 반영).
    super::google_sync::patch_synced_routine_after_edit(db.inner(), &routine_id)
        .await
        .map_err(|e| {
            AppError::terminal(
                "routine.sync.patch_failed",
                format!(
                    "루틴은 저장됐지만 Google 동기화에 실패했습니다 — 설정에서 재시도 ({})",
                    e.message
                ),
            )
        })
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
    // monthly 패턴은 monthly일 때만 — 그 외 freq면 NULL로 정리(패턴 잔존 방지).
    let (monthly_pattern, monthly_nth_week) = match input.freq {
        RoutineFreq::Monthly => (input.monthly_pattern, input.monthly_nth_week),
        _ => (None, None),
    };
    let duration = input.duration_min.map(|v| v as i64);

    // area/kind는 의도적으로 갱신 안 함 — 카드 인라인 편집 IPC(set_routine_area_tag_key/
    // set_routine_kind)가 그 두 컬럼을 소유한다(signals 패턴 미러).
    // google_*도 갱신 안 함 — sync 토글 IPC가 소유. (스케줄 변경의 Google PATCH 전파는 PR 3.)
    let result = sqlx::query(
        "UPDATE routines SET title=?2, freq=?3, weekdays=?4, anchor_date=?5, \
         time_of_day=?6, reminder_offset_min=?7, \
         monthly_pattern=?8, monthly_nth_week=?9, duration_min=?10 WHERE id=?1",
    )
    .bind(&input.id)
    .bind(&title)
    .bind(input.freq)
    .bind(&weekdays_json)
    .bind(&anchor)
    .bind(&time_of_day)
    .bind(offset)
    .bind(monthly_pattern)
    .bind(monthly_nth_week)
    .bind(duration)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    // 미발사 루틴 알림 삭제 — 다음 list_today_routines 호출 시 새 시간으로 재enqueue됨.
    // LIKE 패턴: 'routine:{id}:%' (발사된 rows는 보존 — 히스토리).
    let pattern = format!("routine:{}:%", input.id);
    notification_store::delete_unfired_by_source(db, "routine", &pattern).await?;

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
    // 예외: 이 DELETE는 notification_store를 경유하지 않고 inline으로 둔다 — routine_checks/routines
    // 삭제와 같은 트랜잭션에 묶여 원자성을 보장해야 하는데, &Db store fn은 이 tx(&mut *tx)에 합류할 수
    // 없기 때문(executor-generic 도입 회피). scheduled_notifications의 그 외 모든 SQL은 store가 소유.
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
        notification_store::mark_fired_by_source(
            db.inner(),
            "routine",
            &source_id,
            &utc_now_string(),
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    // nth_weekday 계약 충족: 주차 1..=5/-1 + 요일 정확히 1개 → 통과.
    #[test]
    fn validate_nth_weekday_ok() {
        for nth in [-1, 1, 2, 3, 4, 5] {
            assert!(
                validate_monthly_input(
                    RoutineFreq::Monthly,
                    Some(RoutineMonthlyPattern::NthWeekday),
                    Some(nth),
                    &[Weekday::Tue],
                )
                .is_ok(),
                "nth={nth} 통과해야 함"
            );
        }
    }

    // nth_weekday인데 nth_week 없음 → nth_week_required.
    #[test]
    fn validate_nth_weekday_missing_nth_week() {
        let err = validate_monthly_input(
            RoutineFreq::Monthly,
            Some(RoutineMonthlyPattern::NthWeekday),
            None,
            &[Weekday::Tue],
        )
        .unwrap_err();
        assert_eq!(err.code, "routine.monthly.nth_week_required");
    }

    // nth_week 범위 밖(0, 6, -2) → nth_week_out_of_range.
    #[test]
    fn validate_nth_weekday_out_of_range() {
        for bad in [0, 6, -2, 99] {
            let err = validate_monthly_input(
                RoutineFreq::Monthly,
                Some(RoutineMonthlyPattern::NthWeekday),
                Some(bad),
                &[Weekday::Tue],
            )
            .unwrap_err();
            assert_eq!(
                err.code, "routine.monthly.nth_week_out_of_range",
                "bad={bad}"
            );
        }
    }

    // nth_weekday인데 요일 0개/2개 → nth_weekday_single.
    #[test]
    fn validate_nth_weekday_single_weekday() {
        let zero = validate_monthly_input(
            RoutineFreq::Monthly,
            Some(RoutineMonthlyPattern::NthWeekday),
            Some(2),
            &[],
        )
        .unwrap_err();
        assert_eq!(zero.code, "routine.monthly.nth_weekday_single");

        let two = validate_monthly_input(
            RoutineFreq::Monthly,
            Some(RoutineMonthlyPattern::NthWeekday),
            Some(2),
            &[Weekday::Tue, Weekday::Wed],
        )
        .unwrap_err();
        assert_eq!(two.code, "routine.monthly.nth_weekday_single");
    }

    // day_of_month / 패턴 미지정 monthly는 교차검증 없음 → 통과.
    #[test]
    fn validate_day_of_month_and_none_ok() {
        assert!(validate_monthly_input(
            RoutineFreq::Monthly,
            Some(RoutineMonthlyPattern::DayOfMonth),
            None,
            &[],
        )
        .is_ok());
        assert!(validate_monthly_input(RoutineFreq::Monthly, None, None, &[]).is_ok());
    }

    // 비monthly freq는 패턴 필드가 있어도 무시(저장 시 NULL 정리) → 통과.
    #[test]
    fn validate_non_monthly_ignores_pattern() {
        assert!(validate_monthly_input(
            RoutineFreq::Weekly,
            Some(RoutineMonthlyPattern::NthWeekday),
            None,
            &[],
        )
        .is_ok());
    }
}
