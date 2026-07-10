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
    // 활성 구간(0061). trim 후 빈 문자열은 None(무경계). create_routine이 형식/순서를 이미 검증.
    let start_date = normalize_period_date(input.start_date.as_deref());
    let end_date = normalize_period_date(input.end_date.as_deref());

    let row: (String,) = sqlx::query_as(
        "INSERT INTO routines \
           (id, title, freq, weekdays, anchor_date, time_of_day, reminder_offset_min, area, kind, \
            monthly_pattern, monthly_nth_week, duration_min, start_date, end_date) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13) RETURNING id",
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
    .bind(&start_date)
    .bind(&end_date)
    .fetch_one(db)
    .await?;

    Ok(RoutineToday {
        id: row.0,
        title: input.title.trim().to_string(),
        freq: input.freq,
        weekdays: input.weekdays.clone(),
        anchor_date: anchor,
        start_date,
        end_date,
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

/// 로컬 오늘 날짜(YYYY-MM-DD). OS 로컬 SSOT(`crate::timezone`) 위임 — due-calc의 "오늘"이
/// 리마인더/동기화와 같은 zone에서 나온다.
fn local_today() -> String {
    crate::timezone::local_today_string()
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

/// 활성 구간 날짜 정규화: trim 후 빈 문자열이면 None(무경계). 저장·바인딩·검증이 공유한다.
pub(crate) fn normalize_period_date(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 활성 구간(start_date/end_date) IPC-boundary 검증. DB는 날짜 형식/순서를 강제하지 않으므로
/// (0061은 순수 ADD COLUMN — monthly nth_week와 동일 패턴) 애플리케이션이 보증한다:
/// - 각 경계는 'YYYY-MM-DD' 파싱 가능해야 함(빈 문자열은 무경계로 정규화 → 검증 생략).
/// - 둘 다 있으면 `end >= start`(inclusive 구간).
///
/// 통과하면 due-calc(`within_active_window`)가 게이트로 강제한다.
#[allow(clippy::result_large_err)]
pub(crate) fn validate_active_period(
    start: Option<&str>,
    end: Option<&str>,
) -> Result<(), AppError> {
    let parse = |v: &str, code: &'static str| {
        chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d")
            .map_err(|_| AppError::validation(code, "날짜 형식이 YYYY-MM-DD가 아닙니다"))
    };
    let start_norm = normalize_period_date(start);
    let end_norm = normalize_period_date(end);
    let start_d = start_norm
        .as_deref()
        .map(|v| parse(v, "routine.period.bad_start_date"))
        .transpose()?;
    let end_d = end_norm
        .as_deref()
        .map(|v| parse(v, "routine.period.bad_end_date"))
        .transpose()?;
    if let (Some(s), Some(e)) = (start_d, end_d) {
        if e < s {
            return Err(AppError::validation(
                "routine.period.end_before_start",
                "종료일은 시작일보다 빠를 수 없습니다",
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
    validate_active_period(input.start_date.as_deref(), input.end_date.as_deref())?;
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
pub async fn update_routine(
    db: State<'_, Db>,
    notify: State<'_, std::sync::Arc<tokio::sync::Notify>>,
    input: UpdateRoutineInput,
) -> Result<(), AppError> {
    validate_active_period(input.start_date.as_deref(), input.end_date.as_deref())?;
    validate_monthly_input(
        input.freq,
        input.monthly_pattern,
        input.monthly_nth_week,
        &input.weekdays,
    )?;
    let routine_id = input.id.clone();
    let sync_snapshot =
        super::google_sync::routine_edit_sync_snapshot(db.inner(), &routine_id).await?;
    update_routine_inner(db.inner(), input)
        .await
        .map_err(AppError::from)?;
    // 로컬 업데이트 성공(커밋됨). 동기화된 루틴이면 스케줄 변경을 Google master event에 PATCH 전파(PR 3).
    // 사용자 폼 저장 = 사람 결정이므로 Acceptance 게이트 불요(#2). 미동기화면 토큰 조회 없이 no-op.
    // 전파 실패는 로컬 변경을 되돌리지 않는다 — patch_failed로 wrap해 "저장됐지만 동기화 실패"를
    // 프런트가 toast로 surface(프런트는 onSettled로 routines 무효화 → 로컬 변경은 화면에 반영).
    super::google_sync::patch_synced_routine_after_edit(
        db.inner(),
        notify.inner(),
        &routine_id,
        sync_snapshot,
        &local_today(),
    )
    .await
    .map_err(|e| {
        // stale mirror로 sync가 자동 해제된 경우(routine.sync.expired)는 마스킹하지 않고 그대로
        // 통과 — "다시 켜세요" 재연결 안내가 토스트에 닿아야 한다(generic patch_failed로 덮으면 손실).
        if e.code == super::google_sync::SYNC_EXPIRED_CODE {
            return e;
        }
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
    // 활성 구간(0061). update_routine이 형식/순서를 이미 검증. trim 후 빈 문자열은 None(무경계).
    let start_date = normalize_period_date(input.start_date.as_deref());
    let end_date = normalize_period_date(input.end_date.as_deref());

    // 시간 변경 감지 — 바뀌었으면 아래에서 '수정한 당일 이후' per-day override를 정리한다.
    let prev_time_of_day: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT time_of_day FROM routines WHERE id = ?1")
            .bind(&input.id)
            .fetch_optional(db)
            .await?
            .flatten();

    // area/kind는 의도적으로 갱신 안 함 — 카드 인라인 편집 IPC(set_routine_area_tag_key/
    // set_routine_kind)가 그 두 컬럼을 소유한다(signals 패턴 미러).
    // google_*도 갱신 안 함 — sync 토글 IPC가 소유. (스케줄 변경의 Google PATCH 전파는 PR 3.)
    let result = sqlx::query(
        "UPDATE routines SET title=?2, freq=?3, weekdays=?4, anchor_date=?5, \
         time_of_day=?6, reminder_offset_min=?7, \
         monthly_pattern=?8, monthly_nth_week=?9, duration_min=?10, \
         start_date=?11, end_date=?12 WHERE id=?1",
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
    .bind(&start_date)
    .bind(&end_date)
    .execute(db)
    .await?;

    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }

    // '수정한 당일 이후로 적용': 시간이 바뀌었으면 오늘(local) 이후의 per-day override/링크를
    // 정리해, 새 time_of_day가 오늘부터 보이게 한다(렌더는 `time_override ?? time_of_day`라
    // 옛 override가 남아 있으면 새 시각이 마스킹된다). 과거 날짜는 그날 실제 시각의 기록이라
    // 보존(히스토리). 동기화 루틴은 google_sync가 같은 effective_date(오늘)로 Google master를
    // split하므로 앱/Google이 '당일 이후'로 일관된다. 시간 미변경(제목/길이만 편집)이면 건드리지
    // 않아 사용자가 의도한 per-day 조정을 보존한다.
    if prev_time_of_day != time_of_day {
        let today = local_today();
        sqlx::query(
            "UPDATE routine_checks SET time_override = NULL, linked_event_id = NULL, \
             linked_calendar_id = NULL WHERE routine_id = ?1 AND date >= ?2",
        )
        .bind(&input.id)
        .bind(&today)
        .execute(db)
        .await?;
        // 정리 후 아무 상태도 안 남은 행은 삭제 — 빈 routine_checks 잔존 방지. 완료 마커는
        // `completed_at`(done_at은 NOT NULL DEFAULT라 항상 존재 = 완료 신호 아님; toggle_routine_check
        // 의 정리 조건과 동일하게 done_at은 보지 않는다).
        sqlx::query(
            "DELETE FROM routine_checks WHERE routine_id = ?1 AND date >= ?2 \
             AND completed_at IS NULL AND time_override IS NULL \
             AND linked_event_id IS NULL AND linked_calendar_id IS NULL",
        )
        .bind(&input.id)
        .bind(&today)
        .execute(db)
        .await?;
    }

    // 미발사 루틴 알림 삭제 — 다음 list_today_routines 호출 시 새 시간으로 재enqueue됨.
    // LIKE 패턴: 'routine:{id}:%' (발사된 rows는 보존 — 히스토리).
    let pattern = format!("routine:{}:%", input.id);
    notification_store::delete_unfired_by_source(db, "routine", &pattern).await?;

    Ok(())
}

/// 루틴 삭제. 동기화 ON이면 Google master event를 **먼저** 삭제하고(ADR-0005 DELETE 경로), 그 후
/// 로컬 행을 지운다. Google 삭제 실패 시 로컬은 보존하고 `routine.sync.delete_remote_failed`로
/// surface — 프런트가 "로컬만 삭제할까요?" confirm 후 `delete_routine_local_only`를 호출한다.
/// 미동기화 루틴은 토큰 조회 없이 곧장 로컬 삭제(기존 동작 보존).
#[tauri::command]
#[specta::specta]
pub async fn delete_routine(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    // 동기화 ON이면 master event 먼저 DELETE. 토큰/연결/Google 실패는 모두 delete_remote_failed로
    // 평탄화하되 원본 detail은 메시지에 보존(truthful) — 사용자가 로컬-only 삭제로 진행 가능.
    super::google_sync::delete_routine_master_event(db.inner(), &id)
        .await
        .map_err(|e| {
            AppError::terminal(
                "routine.sync.delete_remote_failed",
                format!(
                    "Google 캘린더 이벤트 삭제에 실패했습니다 — 로컬에서만 삭제할 수 있습니다 ({})",
                    e.message
                ),
            )
        })?;
    delete_routine_inner(db.inner(), id)
        .await
        .map_err(AppError::from)
}

/// 루틴을 로컬에서만 삭제(Google master event는 건드리지 않음). `delete_routine`이 Google 삭제에
/// 실패했을 때 사용자가 confirm한 fallback 경로. 동기화 mirror 컬럼은 행과 함께 사라지므로 별도
/// 정리 불필요.
#[tauri::command]
#[specta::specta]
pub async fn delete_routine_local_only(db: State<'_, Db>, id: String) -> Result<(), AppError> {
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
    toggle_routine_check_inner(db.inner(), &routine_id, &date, done).await
}

/// `toggle_routine_check`의 코어(State 없이 호출 가능 — MCP `wr_toggle_routine_check`가 공유).
pub(crate) async fn toggle_routine_check_inner(
    db: &Db,
    routine_id: &str,
    date: &str,
    done: bool,
) -> Result<(), AppError> {
    if done {
        // 완료 = completed_at 마커 세팅. 행이 이미 있으면(캘린더 배치/시각 override 목적)
        // 그 행에 completed_at만 얹어 링크/override를 보존한다.
        sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date, completed_at) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, datetime('now')) \
             ON CONFLICT(routine_id, date) DO UPDATE SET completed_at = datetime('now')",
        )
        .bind(routine_id)
        .bind(date)
        .execute(db)
        .await
        .map_err(AppError::from)?;

        // 완료된 루틴은 오늘 알림을 발사하지 않는다 — 미발사 행을 fired로 마킹(skip).
        let source_id = reminder_source_id(routine_id, date);
        notification_store::mark_fired_by_source(db, "routine", &source_id, &utc_now_string())
            .await
            .map_err(AppError::from)?;
    } else {
        // 완료 해제 = 완료 마커만 지운다. 링크(linked_event_id/calendar_id)나 시각 override가
        // 남아 있으면 행 자체는 보존(체크 해제가 캘린더 배치/이동을 날리지 않게). 아무 상태도
        // 남지 않으면 행을 정리해 다음날 자동 리셋 의미를 지킨다.
        sqlx::query(
            "UPDATE routine_checks SET completed_at = NULL WHERE routine_id = ?1 AND date = ?2",
        )
        .bind(routine_id)
        .bind(date)
        .execute(db)
        .await
        .map_err(AppError::from)?;
        sqlx::query(
            "DELETE FROM routine_checks WHERE routine_id = ?1 AND date = ?2 \
             AND completed_at IS NULL AND linked_event_id IS NULL \
             AND linked_calendar_id IS NULL AND time_override IS NULL",
        )
        .bind(routine_id)
        .bind(date)
        .execute(db)
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

    // ── 활성 구간 검증 (validate_active_period) ──

    // 둘 다 None/빈 문자열 = 무경계 → 통과.
    #[test]
    fn validate_period_unbounded_ok() {
        assert!(validate_active_period(None, None).is_ok());
        assert!(validate_active_period(Some(""), Some("  ")).is_ok());
    }

    // 정상 구간(start <= end, inclusive) + 단방향(한쪽만) → 통과.
    #[test]
    fn validate_period_valid_ranges_ok() {
        assert!(validate_active_period(Some("2026-06-01"), Some("2026-06-30")).is_ok());
        assert!(validate_active_period(Some("2026-06-01"), Some("2026-06-01")).is_ok());
        assert!(validate_active_period(Some("2026-06-01"), None).is_ok());
        assert!(validate_active_period(None, Some("2026-06-30")).is_ok());
    }

    // end < start → end_before_start.
    #[test]
    fn validate_period_end_before_start() {
        let err = validate_active_period(Some("2026-06-30"), Some("2026-06-01")).unwrap_err();
        assert_eq!(err.code, "routine.period.end_before_start");
    }

    // 형식 오류 → bad_start_date / bad_end_date (어느 쪽인지 구분).
    #[test]
    fn validate_period_bad_format() {
        let s = validate_active_period(Some("2026/06/01"), None).unwrap_err();
        assert_eq!(s.code, "routine.period.bad_start_date");
        let e = validate_active_period(None, Some("06-01-2026")).unwrap_err();
        assert_eq!(e.code, "routine.period.bad_end_date");
    }

    // 활성 구간이 INSERT로 영속되는지(컬럼 바인딩 회귀) + RoutineToday 반환에 반영.
    #[tokio::test]
    async fn insert_persists_active_period() {
        let db = crate::commands::shared::test_support::fresh_db().await;
        let mut input = seed_routine_input("09:00");
        input.start_date = Some("2026-06-01".into());
        input.end_date = Some("2026-06-30".into());
        let today = insert_routine(&db, &input).await.unwrap();
        assert_eq!(today.start_date.as_deref(), Some("2026-06-01"));
        assert_eq!(today.end_date.as_deref(), Some("2026-06-30"));
        let (s, e): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT start_date, end_date FROM routines WHERE id = ?1")
                .bind(&today.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(s.as_deref(), Some("2026-06-01"));
        assert_eq!(e.as_deref(), Some("2026-06-30"));
    }

    // 빈 문자열은 None으로 정규화돼 NULL 저장(무경계).
    #[tokio::test]
    async fn insert_normalizes_blank_period_to_null() {
        let db = crate::commands::shared::test_support::fresh_db().await;
        let mut input = seed_routine_input("09:00");
        input.start_date = Some("  ".into());
        input.end_date = Some("".into());
        let today = insert_routine(&db, &input).await.unwrap();
        assert!(today.start_date.is_none() && today.end_date.is_none());
    }

    fn seed_routine_input(time: &str) -> CreateRoutineInput {
        CreateRoutineInput {
            title: "중국어".into(),
            freq: RoutineFreq::Daily,
            weekdays: vec![],
            anchor_date: None,
            start_date: None,
            end_date: None,
            time_of_day: Some(time.into()),
            reminder_offset_min: None,
            area: None,
            kind: None,
            monthly_pattern: None,
            monthly_nth_week: None,
            duration_min: None,
        }
    }

    fn edit_input(id: &str, title: &str, time: &str) -> UpdateRoutineInput {
        UpdateRoutineInput {
            id: id.into(),
            title: title.into(),
            freq: RoutineFreq::Daily,
            weekdays: vec![],
            anchor_date: None,
            start_date: None,
            end_date: None,
            time_of_day: Some(time.into()),
            reminder_offset_min: None,
            monthly_pattern: None,
            monthly_nth_week: None,
            duration_min: None,
        }
    }

    async fn insert_override(db: &Db, rid: &str, date: &str, time: &str) {
        sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date, time_override) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3)",
        )
        .bind(rid)
        .bind(date)
        .bind(time)
        .execute(db)
        .await
        .unwrap();
    }

    async fn count_checks(db: &Db, rid: &str, date: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM routine_checks WHERE routine_id=?1 AND date=?2")
            .bind(rid)
            .bind(date)
            .fetch_one(db)
            .await
            .unwrap()
    }

    // 시간 편집 = '수정한 당일 이후로 적용': 오늘/미래 override는 정리(새 time_of_day가 보이게),
    // 과거 override는 히스토리로 보존.
    #[tokio::test]
    async fn edit_time_clears_today_and_future_overrides_preserves_past() {
        let db = crate::commands::shared::test_support::fresh_db().await;
        let rid = insert_routine(&db, &seed_routine_input("13:30"))
            .await
            .unwrap()
            .id;
        let today = local_today();
        let past = "2000-01-01";
        let future = "2999-12-31";
        insert_override(&db, &rid, past, "08:00").await;
        insert_override(&db, &rid, &today, "21:00").await;
        insert_override(&db, &rid, future, "22:00").await;

        update_routine_inner(&db, edit_input(&rid, "중국어", "14:00"))
            .await
            .unwrap();

        // 과거 override 보존
        let past_ov: Option<String> = sqlx::query_scalar(
            "SELECT time_override FROM routine_checks WHERE routine_id=?1 AND date=?2",
        )
        .bind(&rid)
        .bind(past)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(past_ov.as_deref(), Some("08:00"), "과거 override 보존");
        // 오늘/미래 override 정리(빈 행 삭제됨)
        assert_eq!(
            count_checks(&db, &rid, &today).await,
            0,
            "오늘 override 제거"
        );
        assert_eq!(
            count_checks(&db, &rid, future).await,
            0,
            "미래 override 제거"
        );
    }

    // 시간 미변경(제목만 편집)이면 per-day override를 건드리지 않는다 — 회귀 가드.
    #[tokio::test]
    async fn edit_without_time_change_keeps_overrides() {
        let db = crate::commands::shared::test_support::fresh_db().await;
        let rid = insert_routine(&db, &seed_routine_input("14:00"))
            .await
            .unwrap()
            .id;
        let future = "2999-12-31";
        insert_override(&db, &rid, future, "23:00").await;

        update_routine_inner(&db, edit_input(&rid, "중국어 (제목수정)", "14:00"))
            .await
            .unwrap();

        let kept: Option<String> = sqlx::query_scalar(
            "SELECT time_override FROM routine_checks WHERE routine_id=?1 AND date=?2",
        )
        .bind(&rid)
        .bind(future)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            kept.as_deref(),
            Some("23:00"),
            "시간 미변경 편집은 override 보존"
        );
    }
}
