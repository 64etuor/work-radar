//! 루틴 ↔ Google Calendar 동기화 IPC (PR 2 §5).
//!
//! - `enable_routine_google_sync` — 토글 ON: master recurring event CREATE + UPDATE `routines.google_*`.
//! - `disable_routine_google_sync` — 토글 OFF: master event DELETE + NULL out `routines.google_*`.
//!
//! 순수 헬퍼(`*_with_provider`)는 provider injection으로 단위 테스트 가능.
//! IPC 진입점은 `HttpCalendarProvider` + `access_token_for`(commands::calendar) 조합.
//!
//! 결정 이력: docs/adr/0005-routine-google-sync.md.
//! 플랜: docs/plans/2026-05-29-routine-google-sync.md §5 PR 2.

// AppError는 단일 envelope (AGENTS.md "AppError 단일 envelope") — 크기 변경은 별도 follow-up.
// 본 모듈의 모든 IPC/helper는 Result<_, AppError>로 통일 → 모듈 단위 result_large_err 허용.
#![allow(clippy::result_large_err)]

use tauri::State;

use crate::{
    calendar::{CalendarProvider, CreateEventInput, HttpCalendarProvider},
    commands::calendar::access_token_for,
    db::Db,
    error::AppError,
    routines::rrule::{self, Freq, MonthlyPattern, RRuleInput, Weekday},
};

// 임시: 사용자 TZ 설정 IPC 도입 전까지 KST 고정. PR 2c(설정 UI)에서 외부화 예정.
const TZID_DEFAULT: &str = "Asia/Seoul";

#[derive(sqlx::FromRow, Debug, Clone)]
struct RoutineSyncRow {
    project_id: Option<String>,
    title: String,
    freq: String,
    weekdays: Option<String>,
    anchor_date: Option<String>,
    time_of_day: Option<String>,
    duration_min: Option<i64>,
    monthly_pattern: Option<String>,
    monthly_nth_week: Option<i64>,
    google_calendar_id: Option<String>,
    google_event_id: Option<String>,
    created_at: String,
}

async fn load_routine(db: &Db, id: &str) -> Result<RoutineSyncRow, AppError> {
    sqlx::query_as::<_, RoutineSyncRow>(
        "SELECT project_id, title, freq, weekdays, anchor_date, time_of_day, \
                duration_min, monthly_pattern, monthly_nth_week, \
                google_calendar_id, google_event_id, created_at \
         FROM routines WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("routine.not_found", "루틴을 찾을 수 없습니다"))
}

fn parse_freq(s: &str) -> Result<Freq, AppError> {
    match s {
        "daily" => Ok(Freq::Daily),
        "weekly" => Ok(Freq::Weekly),
        "biweekly" => Ok(Freq::Biweekly),
        "monthly" => Ok(Freq::Monthly),
        other => Err(AppError::validation(
            "routine.invalid_freq",
            format!("지원하지 않는 freq: {other}"),
        )),
    }
}

fn parse_weekday_str(s: &str) -> Result<Weekday, AppError> {
    match s {
        "sun" => Ok(Weekday::Sun),
        "mon" => Ok(Weekday::Mon),
        "tue" => Ok(Weekday::Tue),
        "wed" => Ok(Weekday::Wed),
        "thu" => Ok(Weekday::Thu),
        "fri" => Ok(Weekday::Fri),
        "sat" => Ok(Weekday::Sat),
        other => Err(AppError::validation(
            "routine.invalid_weekday",
            format!("지원하지 않는 weekday: {other}"),
        )),
    }
}

fn parse_weekdays_json(s: Option<&str>) -> Result<Vec<Weekday>, AppError> {
    let Some(raw) = s else {
        return Ok(Vec::new());
    };
    let arr: Vec<String> = serde_json::from_str(raw).map_err(|e| {
        AppError::validation(
            "routine.invalid_weekdays_json",
            format!("weekdays JSON 파싱 실패: {e}"),
        )
    })?;
    arr.iter().map(|w| parse_weekday_str(w)).collect()
}

fn parse_monthly_pattern(s: &str) -> Result<MonthlyPattern, AppError> {
    match s {
        "day_of_month" => Ok(MonthlyPattern::DayOfMonth),
        "nth_weekday" => Ok(MonthlyPattern::NthWeekday),
        other => Err(AppError::validation(
            "routine.invalid_monthly_pattern",
            format!("지원하지 않는 monthly_pattern: {other}"),
        )),
    }
}

/// Provider injection helper — enable 흐름 단위 테스트용. IPC 명령은 이걸 호출.
pub(crate) async fn enable_routine_sync_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
    calendar_id: &str,
    tzid: &str,
) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    if row.google_event_id.is_some() {
        return Err(AppError::validation(
            "routine.sync.already_enabled",
            "이미 동기화 중인 루틴입니다",
        ));
    }

    let exdate_dates: Vec<String> =
        sqlx::query_scalar("SELECT date FROM routine_exdates WHERE routine_id = ?1 ORDER BY date")
            .bind(routine_id)
            .fetch_all(db)
            .await?;
    let exdate_refs: Vec<&str> = exdate_dates.iter().map(String::as_str).collect();

    let freq = parse_freq(&row.freq)?;
    let weekdays = parse_weekdays_json(row.weekdays.as_deref())?;
    let monthly_pattern = match row.monthly_pattern.as_deref() {
        Some(s) => Some(parse_monthly_pattern(s)?),
        None => None,
    };
    // created_at은 'YYYY-MM-DD HH:MM:SS' (sqlx datetime('now')) — 앞 10자 = 날짜.
    // 포맷이 깨졌다면 1970 fallback이 DTSTART에 새겨질 위험 → 명시적 거부.
    let reference = row.created_at.get(0..10).ok_or_else(|| {
        AppError::validation(
            "routine.created_at_malformed",
            "routine.created_at 포맷이 YYYY-MM-DD HH:MM:SS가 아닙니다",
        )
    })?;

    let input = RRuleInput {
        freq,
        weekdays: &weekdays,
        anchor_date: row.anchor_date.as_deref(),
        time_of_day: row.time_of_day.as_deref(),
        duration_min: row.duration_min.map(|n| n.max(0) as u32),
        monthly_pattern,
        monthly_nth_week: row.monthly_nth_week.map(|n| n as i32),
        tzid,
        reference_date: reference,
    };
    let spec = rrule::routine_to_rrule(&input, &exdate_refs).map_err(|e| {
        AppError::validation("routine.rrule_invalid", format!("RRULE 매핑 실패: {e}"))
    })?;
    let parts = spec.to_event_parts().map_err(|e| {
        AppError::validation("routine.rrule_invalid", format!("ISO 변환 실패: {e}"))
    })?;

    let create_input = CreateEventInput {
        title: row.title.clone(),
        start: parts.start_iso,
        end: parts.end_iso,
        all_day: false,
        description: None,
        recurrence: parts.recurrence_lines,
        time_zone: Some(spec.tzid.clone()),
    };
    let (event_id, _html_link) = provider
        .create_event(access_token, calendar_id, &create_input)
        .await?;

    // sync-pair invariant: 두 필드 동시 UPDATE (atomic single statement).
    sqlx::query("UPDATE routines SET google_calendar_id = ?1, google_event_id = ?2 WHERE id = ?3")
        .bind(calendar_id)
        .bind(&event_id)
        .bind(routine_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Provider injection helper — disable 흐름 단위 테스트용.
pub(crate) async fn disable_routine_sync_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    let (Some(cal_id), Some(evt_id)) = (
        row.google_calendar_id.as_deref(),
        row.google_event_id.as_deref(),
    ) else {
        // 이미 disabled 상태 — no-op (멱등).
        return Ok(());
    };

    // PR 2 §4: 4xx(404=already deleted 등)는 no retry, graceful — 로컬 상태만 정리.
    // 현재 CalendarError가 4xx 세분 미지원 → PR 2c(설정 UI 단계)에서 404 graceful 추가 예정.
    // 지금은 모든 에러 전파(보수적). 사용자가 토스트 보고 재시도.
    provider.delete_event(access_token, cal_id, evt_id).await?;

    sqlx::query(
        "UPDATE routines SET google_calendar_id = NULL, google_event_id = NULL WHERE id = ?1",
    )
    .bind(routine_id)
    .execute(db)
    .await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn enable_routine_google_sync(
    db: State<'_, Db>,
    routine_id: String,
    calendar_id: String,
) -> Result<(), AppError> {
    let row = load_routine(db.inner(), &routine_id).await?;
    let project_id = row.project_id.as_deref().ok_or_else(|| {
        AppError::validation(
            "routine.sync.no_project",
            "프로젝트가 없는 루틴은 동기화할 수 없습니다",
        )
    })?;
    let access = access_token_for(db.inner(), project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let provider = HttpCalendarProvider::new()?;
    enable_routine_sync_with_provider(
        db.inner(),
        &provider,
        &access,
        &routine_id,
        &calendar_id,
        TZID_DEFAULT,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn disable_routine_google_sync(
    db: State<'_, Db>,
    routine_id: String,
) -> Result<(), AppError> {
    let row = load_routine(db.inner(), &routine_id).await?;
    if row.google_event_id.is_none() {
        // 이미 disabled — no-op without 토큰 fetch.
        return Ok(());
    }
    let project_id = row.project_id.as_deref().ok_or_else(|| {
        AppError::validation(
            "routine.sync.no_project",
            "프로젝트가 없는 루틴은 동기화할 수 없습니다",
        )
    })?;
    let access = access_token_for(db.inner(), project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let provider = HttpCalendarProvider::new()?;
    disable_routine_sync_with_provider(db.inner(), &provider, &access, &routine_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{CalendarCreds, CalendarError, RawCalendar, RawEvent, TokenResponse};
    use crate::commands::routines::insert_routine;
    use crate::commands::shared::test_support::*;
    use crate::models::{CreateRoutineInput, RoutineFreq, Weekday as MWeekday};
    use std::sync::Mutex;

    /// 최소 mock — create_event/delete_event 호출 기록 + 결과 모킹.
    struct RecordingProvider {
        create_result: Mutex<Result<(String, Option<String>), CalendarError>>,
        delete_result: Mutex<Result<(), CalendarError>>,
        created: Mutex<Vec<(String, String, CreateEventInput)>>,
        deleted: Mutex<Vec<(String, String, String)>>,
    }

    impl Default for RecordingProvider {
        fn default() -> Self {
            Self {
                create_result: Mutex::new(Ok(("evt_default".into(), None))),
                delete_result: Mutex::new(Ok(())),
                created: Mutex::new(Vec::new()),
                deleted: Mutex::new(Vec::new()),
            }
        }
    }

    impl RecordingProvider {
        fn with_create_id(id: &str) -> Self {
            Self {
                create_result: Mutex::new(Ok((id.into(), None))),
                ..Self::default()
            }
        }
    }

    impl CalendarProvider for RecordingProvider {
        async fn exchange_code(
            &self,
            _: &CalendarCreds,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<TokenResponse, CalendarError> {
            unimplemented!()
        }
        async fn refresh_access(&self, _: &CalendarCreds) -> Result<TokenResponse, CalendarError> {
            unimplemented!()
        }
        async fn list_calendars(&self, _: &str) -> Result<Vec<RawCalendar>, CalendarError> {
            unimplemented!()
        }
        async fn fetch_events(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<Vec<RawEvent>, CalendarError> {
            unimplemented!()
        }
        async fn create_event(
            &self,
            access: &str,
            calendar_id: &str,
            input: &CreateEventInput,
        ) -> Result<(String, Option<String>), CalendarError> {
            self.created.lock().unwrap().push((
                access.to_string(),
                calendar_id.to_string(),
                input.clone(),
            ));
            self.create_result.lock().unwrap().clone()
        }
        async fn patch_event(
            &self,
            _: &str,
            _: &str,
            _: &str,
            _: &serde_json::Value,
        ) -> Result<(), CalendarError> {
            unimplemented!()
        }
        async fn delete_event(
            &self,
            access: &str,
            calendar_id: &str,
            event_id: &str,
        ) -> Result<(), CalendarError> {
            self.deleted.lock().unwrap().push((
                access.to_string(),
                calendar_id.to_string(),
                event_id.to_string(),
            ));
            self.delete_result.lock().unwrap().clone()
        }
    }

    async fn seed_routine_with_project(
        db: &crate::db::Db,
        title: &str,
        freq: RoutineFreq,
        weekdays: Vec<MWeekday>,
        time_of_day: Option<String>,
    ) -> String {
        // 프로젝트 1개 시드 (routines.project_id 채우기 위해).
        let pid = "p1".to_string();
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, name, kind, credential_ref) \
             VALUES (?1, 'Test', 'work', 'test_creds')",
        )
        .bind(&pid)
        .execute(db)
        .await
        .unwrap();

        let r = insert_routine(
            db,
            &CreateRoutineInput {
                title: title.into(),
                freq,
                weekdays,
                anchor_date: None,
                time_of_day,
                reminder_offset_min: None,
                area: None,
                kind: None,
            },
        )
        .await
        .unwrap();

        // project_id를 직접 UPDATE (CreateRoutineInput에 없음).
        sqlx::query("UPDATE routines SET project_id = ?1 WHERE id = ?2")
            .bind(&pid)
            .bind(&r.id)
            .execute(db)
            .await
            .unwrap();
        r.id
    }

    /// enable: provider.create_event 호출됨 + routines.google_* atomic UPDATE.
    #[tokio::test]
    async fn enable_creates_master_and_persists_mirror() {
        let db = fresh_db().await;
        let rid = seed_routine_with_project(
            &db,
            "아침 운동",
            RoutineFreq::Weekly,
            vec![MWeekday::Mon, MWeekday::Wed, MWeekday::Fri],
            Some("07:00".into()),
        )
        .await;
        let provider = RecordingProvider::with_create_id("evt_master_1");

        enable_routine_sync_with_provider(
            &db,
            &provider,
            "access_xyz",
            &rid,
            "cal_user_a",
            "Asia/Seoul",
        )
        .await
        .unwrap();

        // provider 호출 검증.
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1, "create_event 1회 호출");
        let (access, cal, input) = &created[0];
        assert_eq!(access, "access_xyz");
        assert_eq!(cal, "cal_user_a");
        assert_eq!(input.title, "아침 운동");
        assert_eq!(input.time_zone.as_deref(), Some("Asia/Seoul"));
        assert!(
            input
                .recurrence
                .iter()
                .any(|l| l.starts_with("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR")),
            "RRULE BYDAY=MO,WE,FR 라인 동봉"
        );
        assert!(input.start.starts_with("20"));
        assert!(input.start.ends_with("T07:00:00"));

        // DB mirror 검증 (sync-pair atomic UPDATE).
        let (cal_id, evt_id): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(cal_id.as_deref(), Some("cal_user_a"));
        assert_eq!(evt_id.as_deref(), Some("evt_master_1"));
    }

    /// 이미 동기화 중 루틴 enable 재호출 → already_enabled 에러, provider 미호출.
    #[tokio::test]
    async fn enable_rejects_when_already_synced() {
        let db = fresh_db().await;
        let rid = seed_routine_with_project(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("19:00".into()),
        )
        .await;
        // 미리 sync 상태로 세팅.
        sqlx::query(
            "UPDATE routines SET google_calendar_id = 'c1', google_event_id = 'e1' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let provider = RecordingProvider::with_create_id("nope");
        let err =
            enable_routine_sync_with_provider(&db, &provider, "tok", &rid, "c2", "Asia/Seoul")
                .await
                .unwrap_err();
        assert_eq!(err.code, "routine.sync.already_enabled");
        assert!(
            provider.created.lock().unwrap().is_empty(),
            "이미 sync면 provider.create_event 호출 안 됨"
        );
    }

    /// disable: provider.delete_event 호출 + google_* 필드 NULL.
    #[tokio::test]
    async fn disable_deletes_master_and_clears_mirror() {
        let db = fresh_db().await;
        let rid = seed_routine_with_project(
            &db,
            "PT",
            RoutineFreq::Weekly,
            vec![MWeekday::Tue, MWeekday::Thu],
            Some("18:30".into()),
        )
        .await;
        sqlx::query(
            "UPDATE routines SET google_calendar_id = 'cal_x', google_event_id = 'evt_x' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let provider = RecordingProvider::default();
        disable_routine_sync_with_provider(&db, &provider, "tok_d", &rid)
            .await
            .unwrap();

        let deleted = provider.deleted.lock().unwrap().clone();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0], ("tok_d".into(), "cal_x".into(), "evt_x".into()));

        let (cal_id, evt_id): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(cal_id.is_none() && evt_id.is_none(), "sync-pair NULL out");
    }

    /// disable: 이미 disabled면 no-op (provider 미호출, 에러 없음).
    #[tokio::test]
    async fn disable_is_noop_when_already_local_only() {
        let db = fresh_db().await;
        let rid =
            seed_routine_with_project(&db, "스트레칭", RoutineFreq::Daily, vec![], None).await;
        let provider = RecordingProvider::default();
        disable_routine_sync_with_provider(&db, &provider, "tok", &rid)
            .await
            .unwrap();
        assert!(
            provider.deleted.lock().unwrap().is_empty(),
            "local-only 루틴은 provider 미호출"
        );
    }
}
