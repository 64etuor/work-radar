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

use chrono::NaiveDate;
use tauri::State;

use crate::{
    calendar::{build_event_payload, CalendarProvider, CreateEventInput, HttpCalendarProvider},
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
    /// 루틴 개인/업무 구분 ('personal'|'work'|NULL). project.kind와 매칭해 교차 노출 차단.
    kind: Option<String>,
    google_calendar_id: Option<String>,
    google_event_id: Option<String>,
    created_at: String,
}

async fn load_routine(db: &Db, id: &str) -> Result<RoutineSyncRow, AppError> {
    sqlx::query_as::<_, RoutineSyncRow>(
        "SELECT project_id, title, freq, weekdays, anchor_date, time_of_day, \
                duration_min, monthly_pattern, monthly_nth_week, kind, \
                google_calendar_id, google_event_id, created_at \
         FROM routines WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("routine.not_found", "루틴을 찾을 수 없습니다"))
}

/// 프로젝트 kind 조회 ('personal'|'work'). 프로젝트 없으면 not_found.
async fn project_kind(db: &Db, project_id: &str) -> Result<String, AppError> {
    sqlx::query_scalar::<_, String>("SELECT kind FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("project.not_found", "프로젝트를 찾을 수 없습니다"))
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

/// 동기화 루틴 row → Google master event 입력(CREATE/PATCH 공용). exdate 조회 + RRULE 매핑 +
/// ISO 변환을 한 곳에 모은다. enable(CREATE)·patch(PATCH) 둘 다 이걸 거쳐 같은 매핑을 보장한다.
/// monthly 패턴 미지정이면 day_of_month 기본 — 로컬 due-calc(day-of-month)와 일치해 화면/캘린더가
/// 어긋나지 않게 한다(nth_weekday는 명시적 업그레이드, 2b-3 UI).
async fn build_master_event_input(
    db: &Db,
    routine_id: &str,
    row: &RoutineSyncRow,
    tzid: &str,
) -> Result<CreateEventInput, AppError> {
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
        None if matches!(freq, Freq::Monthly) => Some(MonthlyPattern::DayOfMonth),
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

    Ok(CreateEventInput {
        title: row.title.clone(),
        start: parts.start_iso,
        end: parts.end_iso,
        all_day: false,
        description: None,
        recurrence: parts.recurrence_lines,
        time_zone: Some(spec.tzid),
    })
}

/// 동기화 활성화/이동 전 매핑 가드(enable·move 공용). 파괴적 Google 호출 **전에** 검증해야
/// 한다 — move는 옛 master를 DELETE하기 전에 이걸 통과시켜 "지운 뒤 kind 불일치로 실패" 같은
/// 비가역 상태를 막는다.
///
/// - 루틴 kind 미지정 → 매핑 불가(`kind_required`).
/// - `project.kind != routine.kind` → 개인↔업무 캘린더 교차 노출 차단(`kind_mismatch`).
/// - 시간 미지정 → 09:00 fallback이 화면/캘린더를 어긋나게 하므로 거부(`time_required`).
async fn ensure_kind_and_time(
    db: &Db,
    row: &RoutineSyncRow,
    project_id: &str,
) -> Result<(), AppError> {
    let Some(routine_kind) = row.kind.as_deref() else {
        return Err(AppError::validation(
            "routine.sync.kind_required",
            "동기화 전에 루틴의 개인/업무 구분을 먼저 지정하세요",
        ));
    };
    let proj_kind = project_kind(db, project_id).await?;
    if proj_kind != routine_kind {
        return Err(AppError::validation(
            "routine.sync.kind_mismatch",
            format!("루틴({routine_kind})과 프로젝트({proj_kind})의 개인/업무 구분이 다릅니다",),
        ));
    }
    if row
        .time_of_day
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .is_none()
    {
        return Err(AppError::validation(
            "routine.sync.time_required",
            "동기화하려면 먼저 루틴 시간을 지정하세요",
        ));
    }
    Ok(())
}

/// Provider injection helper — enable 흐름 단위 테스트용. IPC 명령은 이걸 호출.
///
/// `project_id`는 routine.kind와 같은 kind의 프로젝트(개인 루틴→개인 프로젝트, 업무→업무).
/// 백엔드가 `project.kind == routine.kind`를 검증해 개인↔업무 캘린더 교차 노출을 차단한다.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn enable_routine_sync_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
    project_id: &str,
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

    // 매핑 가드(kind 일치 + 시간 지정). 프런트 RoutineSyncButton도 동일 가드(무시각/kind 미지정이면
    // 비활성)이고, 여기서 재검증한다.
    ensure_kind_and_time(db, &row, project_id).await?;

    let create_input = build_master_event_input(db, routine_id, &row, tzid).await?;
    let (event_id, _html_link) = provider
        .create_event(access_token, calendar_id, &create_input)
        .await?;

    // sync-pair invariant: 세 필드 동시 UPDATE (atomic). project_id도 함께 set →
    // 이후 disable/patch가 routine.project_id로 토큰을 다시 얻을 수 있다.
    sqlx::query(
        "UPDATE routines SET project_id = ?1, google_calendar_id = ?2, google_event_id = ?3 \
         WHERE id = ?4",
    )
    .bind(project_id)
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

/// Provider injection helper — 다른 캘린더로 이동(PR 5, 단위 테스트용). Google API는 기존 이벤트의
/// calendarId를 PATCH로 바꿀 수 없으므로(plan §6, ADR-0005) **옛 master DELETE + 새 master CREATE**다.
///
/// 파괴 전 가드: 현재 동기화 중이어야 하고(`not_synced`), 새 프로젝트와의 kind 일치·시간 지정을
/// **disable 전에** 검증한다(`ensure_kind_and_time`). 통과 후 disable(DELETE 옛 master + mirror NULL)
/// → enable(CREATE 새 master + mirror set) 순서로 기존 검증된 헬퍼를 재사용한다.
///
/// 부분 실패 시맨틱: DELETE 실패면 mirror 불변(옛 캘린더에 그대로 sync, 에러 전파) — 비파괴.
/// DELETE 성공 후 CREATE 실패면 mirror는 NULL(동기화 해제 상태)로 남고 에러 전파 — 사용자가 다시
/// 켤 수 있도록 truthful하게 surface(다른 캘린더로 이동은 명시적 confirm 액션이라 #2 게이트 충족).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn move_routine_sync_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    old_access: &str,
    new_access: &str,
    routine_id: &str,
    new_project_id: &str,
    new_calendar_id: &str,
    tzid: &str,
) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    if row.google_event_id.is_none() {
        return Err(AppError::validation(
            "routine.sync.not_synced",
            "동기화되지 않은 루틴은 이동할 수 없습니다 — 먼저 동기화를 켜세요",
        ));
    }
    // 옛 master를 지우기 전에 새 매핑을 검증(비가역 상태 방지).
    ensure_kind_and_time(db, &row, new_project_id).await?;

    // DELETE 옛 master + mirror NULL.
    disable_routine_sync_with_provider(db, provider, old_access, routine_id).await?;
    // CREATE 새 master + mirror set(project_id/cal/evt). disable로 event_id가 NULL이라
    // already_enabled 가드는 통과한다.
    enable_routine_sync_with_provider(
        db,
        provider,
        new_access,
        routine_id,
        new_project_id,
        new_calendar_id,
        tzid,
    )
    .await
}

/// Provider injection helper — 루틴 삭제 시 Google master event DELETE(PR 5, 단위 테스트용).
/// disable과 달리 mirror를 NULL로 정리하지 않는다 — 호출 직후 루틴 행 자체가 삭제되기 때문.
/// 미동기화면 no-op(멱등).
pub(crate) async fn delete_master_with_provider<P: CalendarProvider>(
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
        return Ok(());
    };
    provider.delete_event(access_token, cal_id, evt_id).await?;
    Ok(())
}

/// Provider injection helper — 편집된 동기화 루틴의 master event PATCH 전파(PR 3, 단위 테스트용).
/// 미동기화 루틴이면 no-op(멱등). recurrence+start+end+summary를 한 번에 보낸다(plan §4 PATCH).
/// PATCH 전략: DELETE+CREATE가 아니라 PATCH라 EXDATE/이벤트 ID/사용자가 Google에 추가한 메타 보존.
pub(crate) async fn patch_routine_sync_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
    tzid: &str,
) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    let (Some(cal_id), Some(evt_id)) = (
        row.google_calendar_id.as_deref(),
        row.google_event_id.as_deref(),
    ) else {
        // 미동기화 — PATCH 불요(멱등).
        return Ok(());
    };
    // NOTE(deferred): enable은 무시각 루틴을 time_required로 거부하지만, 이미 sync된 루틴의 시간을
    // 편집으로 비우면 이 PATCH가 09:00 fallback으로 재구성한다(silent, non-destructive). 드문 시퀀스라
    // 별도 follow-up으로 둔다 — 필요 시 무시각 편집 시 sync 자동 해제 또는 편집 차단으로 처리.
    let create_input = build_master_event_input(db, routine_id, &row, tzid).await?;
    let payload = build_event_payload(&create_input);
    provider
        .patch_event(access_token, cal_id, evt_id, &payload)
        .await?;
    Ok(())
}

/// 루틴 편집 후 동기화 전파(crud::update_routine에서 호출). 동기화 OFF면 토큰 조회 없이 no-op.
/// 동기화 ON이면 master event PATCH — 실패는 호출자가 patch_failed로 surface(로컬 변경은 유지).
#[allow(clippy::result_large_err)]
pub(crate) async fn patch_synced_routine_after_edit(
    db: &Db,
    routine_id: &str,
) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    if row.google_event_id.is_none() {
        // 미동기화 — 토큰 조회 없이 no-op (편집의 흔한 경우).
        return Ok(());
    }
    let project_id = row.project_id.as_deref().ok_or_else(|| {
        AppError::validation(
            "routine.sync.no_project",
            "프로젝트가 없는 루틴은 동기화할 수 없습니다",
        )
    })?;
    let access = access_token_for(db, project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let provider = HttpCalendarProvider::new()?;
    patch_routine_sync_with_provider(db, &provider, &access, routine_id, TZID_DEFAULT).await
}

/// 루틴 삭제 전 Google master event 정리(crud::delete_routine에서 호출). 동기화 OFF면 토큰 조회
/// 없이 no-op. 동기화 ON이면 master event DELETE — 실패는 호출자가 delete_remote_failed로 surface
/// (로컬 행은 보존, 사용자가 "로컬만 삭제" confirm).
#[allow(clippy::result_large_err)]
pub(crate) async fn delete_routine_master_event(db: &Db, routine_id: &str) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    if row.google_event_id.is_none() {
        // 미동기화 — 토큰 조회 없이 no-op (삭제의 흔한 경우).
        return Ok(());
    }
    let project_id = row.project_id.as_deref().ok_or_else(|| {
        AppError::validation(
            "routine.sync.no_project",
            "프로젝트가 없는 루틴은 동기화할 수 없습니다",
        )
    })?;
    let access = access_token_for(db, project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let provider = HttpCalendarProvider::new()?;
    delete_master_with_provider(db, &provider, &access, routine_id).await
}

/// 루틴 Google 동기화 ON. `project_id`는 routine.kind와 같은 kind의 프로젝트(개인→개인,
/// 업무→업무) — 프런트가 그 프로젝트의 캘린더를 picker로 넘긴다. 토큰은 그 프로젝트의 OAuth.
#[tauri::command]
#[specta::specta]
pub async fn enable_routine_google_sync(
    db: State<'_, Db>,
    routine_id: String,
    project_id: String,
    calendar_id: String,
) -> Result<(), AppError> {
    let access = access_token_for(db.inner(), &project_id)
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
        &project_id,
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

/// 동기화 중인 루틴을 다른 캘린더로 이동(PR 5). Google API가 calendarId 변경 PATCH를 지원하지
/// 않아 옛 master DELETE + 새 master CREATE다(메타 손실 — 프런트가 명시 confirm). `project_id`는
/// 새 캘린더 소유 프로젝트(routine.kind와 같은 kind). 옛 이벤트는 옛 프로젝트 토큰으로, 새 이벤트는
/// 새 프로젝트 토큰으로 호출한다(같은 프로젝트면 같은 토큰).
#[tauri::command]
#[specta::specta]
pub async fn move_routine_google_sync(
    db: State<'_, Db>,
    routine_id: String,
    project_id: String,
    calendar_id: String,
) -> Result<(), AppError> {
    let row = load_routine(db.inner(), &routine_id).await?;
    if row.google_event_id.is_none() {
        return Err(AppError::validation(
            "routine.sync.not_synced",
            "동기화되지 않은 루틴은 이동할 수 없습니다 — 먼저 동기화를 켜세요",
        ));
    }
    // 동기화 중이면 enable이 project_id를 set했으므로 옛 프로젝트가 있어야 한다.
    let old_project_id = row.project_id.as_deref().ok_or_else(|| {
        AppError::validation(
            "routine.sync.no_project",
            "프로젝트가 없는 루틴은 동기화할 수 없습니다",
        )
    })?;
    let old_access = access_token_for(db.inner(), old_project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let new_access = access_token_for(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })?;
    let provider = HttpCalendarProvider::new()?;
    move_routine_sync_with_provider(
        db.inner(),
        &provider,
        &old_access,
        &new_access,
        &routine_id,
        &project_id,
        &calendar_id,
        TZID_DEFAULT,
    )
    .await
}

// ── PR 4: 오늘 unschedule = EXDATE ──────────────────────────────────────────────

/// 'YYYY-MM-DD' 형식 검증. exdate row의 date 컬럼은 EXDATE 매핑(exdate_local)이 슬라이스로
/// 파싱하므로 형식이 깨지면 잘못된 EXDATE가 master event에 새겨진다 → 진입점에서 차단.
fn validate_ymd(date: &str) -> Result<(), AppError> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| {
            AppError::validation(
                "routine.exdate.bad_date",
                "날짜 형식이 YYYY-MM-DD가 아닙니다",
            )
        })
}

/// 로컬 SSOT — (routine_id, date) skip 행 추가(멱등). PK 충돌은 무시.
async fn insert_exdate_row(db: &Db, routine_id: &str, date: &str) -> Result<(), AppError> {
    sqlx::query("INSERT OR IGNORE INTO routine_exdates (routine_id, date) VALUES (?1, ?2)")
        .bind(routine_id)
        .bind(date)
        .execute(db)
        .await?;
    Ok(())
}

/// 로컬 SSOT — (routine_id, date) skip 행 삭제(undo). 없으면 0행(멱등).
async fn delete_exdate_row(db: &Db, routine_id: &str, date: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM routine_exdates WHERE routine_id = ?1 AND date = ?2")
        .bind(routine_id)
        .bind(date)
        .execute(db)
        .await?;
    Ok(())
}

/// 동기화 실패 wrap — 로컬 변경(exdate row)은 이미 적용됐음을 truthful하게 surface한다.
/// 원본 detail은 메시지에 보존(PR 3 patch_failed와 동일 정책 — flatten하되 진실 유지).
fn exdate_patch_failed(e: AppError) -> AppError {
    AppError::terminal(
        "routine.sync.exdate_patch_failed",
        format!(
            "로컬 변경은 적용했지만 Google 동기화에 실패했습니다: {}",
            e.message
        ),
    )
}

/// Provider injection helper — "오늘 빼기" 흐름 단위 테스트용. exdate row 추가 후 master PATCH.
/// 미동기화 루틴이면 patch가 no-op(멱등) — row만 남는다(로컬 hide).
/// IPC 진입점(`unschedule_routine_today`)은 `patch_synced_routine_after_edit`로 토큰을 동기화
/// 시에만 조회하므로, 이 wrapper는 provider 주입이 가능한 테스트 경로 전용이다.
#[cfg(test)]
pub(crate) async fn unschedule_today_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
    date: &str,
    tzid: &str,
) -> Result<(), AppError> {
    insert_exdate_row(db, routine_id, date).await?;
    patch_routine_sync_with_provider(db, provider, access_token, routine_id, tzid).await
}

/// Provider injection helper — undo 흐름 단위 테스트용. exdate row 삭제 후 master PATCH.
#[cfg(test)]
pub(crate) async fn restore_today_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
    date: &str,
    tzid: &str,
) -> Result<(), AppError> {
    delete_exdate_row(db, routine_id, date).await?;
    patch_routine_sync_with_provider(db, provider, access_token, routine_id, tzid).await
}

/// 루틴을 그 날짜의 타임라인에서 뺀다(EXDATE). 로컬 routine_exdates에 skip 행을 쓰고,
/// 동기화 ON이면 master recurring event에 EXDATE를 PATCH로 추가한다(build_master_event_input이
/// routine_exdates를 재읽어 EXDATE를 동봉). 미동기화면 토큰 조회 없이 로컬 hide만(no-op PATCH).
/// 동기화 PATCH 실패는 로컬 변경을 유지한 채 exdate_patch_failed로 surface(PR 3 graceful 패턴).
#[tauri::command]
#[specta::specta]
pub async fn unschedule_routine_today(
    db: State<'_, Db>,
    routine_id: String,
    date: String,
) -> Result<(), AppError> {
    validate_ymd(&date)?;
    // 존재 확인(깔끔한 not_found) — 이후 FK 위반 대신 명확한 에러.
    load_routine(db.inner(), &routine_id).await?;
    insert_exdate_row(db.inner(), &routine_id, &date).await?;
    patch_synced_routine_after_edit(db.inner(), &routine_id)
        .await
        .map_err(exdate_patch_failed)
}

/// "오늘 빼기" 되돌리기 — routine_exdates skip 행 삭제 + 동기화 ON이면 master EXDATE 제거 PATCH.
#[tauri::command]
#[specta::specta]
pub async fn restore_routine_today(
    db: State<'_, Db>,
    routine_id: String,
    date: String,
) -> Result<(), AppError> {
    validate_ymd(&date)?;
    load_routine(db.inner(), &routine_id).await?;
    delete_exdate_row(db.inner(), &routine_id, &date).await?;
    patch_synced_routine_after_edit(db.inner(), &routine_id)
        .await
        .map_err(exdate_patch_failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::{CalendarCreds, CalendarError, RawCalendar, RawEvent, TokenResponse};
    use crate::commands::routines::{insert_routine, update_routine_inner};
    use crate::commands::shared::test_support::*;
    use crate::models::{
        CreateRoutineInput, Kind, RoutineFreq, UpdateRoutineInput, Weekday as MWeekday,
    };
    use std::sync::Mutex;

    /// 최소 mock — create/patch/delete 호출 기록 + 결과 모킹.
    struct RecordingProvider {
        create_result: Mutex<Result<(String, Option<String>), CalendarError>>,
        patch_result: Mutex<Result<(), CalendarError>>,
        delete_result: Mutex<Result<(), CalendarError>>,
        created: Mutex<Vec<(String, String, CreateEventInput)>>,
        patched: Mutex<Vec<(String, String, String, serde_json::Value)>>,
        deleted: Mutex<Vec<(String, String, String)>>,
    }

    impl Default for RecordingProvider {
        fn default() -> Self {
            Self {
                create_result: Mutex::new(Ok(("evt_default".into(), None))),
                patch_result: Mutex::new(Ok(())),
                delete_result: Mutex::new(Ok(())),
                created: Mutex::new(Vec::new()),
                patched: Mutex::new(Vec::new()),
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
            access: &str,
            calendar_id: &str,
            event_id: &str,
            patch: &serde_json::Value,
        ) -> Result<(), CalendarError> {
            self.patched.lock().unwrap().push((
                access.to_string(),
                calendar_id.to_string(),
                event_id.to_string(),
                patch.clone(),
            ));
            self.patch_result.lock().unwrap().clone()
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

    /// 프로젝트 시드(주어진 kind). credential_ref는 keychain 분리 키(테스트 더미).
    async fn seed_project(db: &crate::db::Db, id: &str, kind: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO projects (id, name, kind, credential_ref) \
             VALUES (?1, 'Test', ?2, 'test_creds')",
        )
        .bind(id)
        .bind(kind)
        .execute(db)
        .await
        .unwrap();
    }

    /// 루틴 시드(주어진 kind). project_id는 비워둔다(enable이 set) — disable 테스트는 별도 세팅.
    async fn seed_routine(
        db: &crate::db::Db,
        title: &str,
        freq: RoutineFreq,
        weekdays: Vec<MWeekday>,
        time_of_day: Option<String>,
        kind: Option<Kind>,
    ) -> String {
        insert_routine(
            db,
            &CreateRoutineInput {
                title: title.into(),
                freq,
                weekdays,
                anchor_date: None,
                time_of_day,
                reminder_offset_min: None,
                area: None,
                kind,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    /// enable: kind 일치(개인 루틴→개인 프로젝트) → create_event + project_id/google_* atomic UPDATE.
    #[tokio::test]
    async fn enable_creates_master_and_persists_mirror() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Weekly,
            vec![MWeekday::Mon, MWeekday::Wed, MWeekday::Fri],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::with_create_id("evt_master_1");

        enable_routine_sync_with_provider(
            &db,
            &provider,
            "access_xyz",
            &rid,
            "proj_personal",
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

        // DB mirror 검증 (project_id + sync-pair atomic UPDATE).
        let (proj, cal_id, evt_id): (Option<String>, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT project_id, google_calendar_id, google_event_id FROM routines WHERE id = ?1",
            )
            .bind(&rid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(proj.as_deref(), Some("proj_personal"), "project_id도 set");
        assert_eq!(cal_id.as_deref(), Some("cal_user_a"));
        assert_eq!(evt_id.as_deref(), Some("evt_master_1"));
    }

    /// enable: 시간 미지정 루틴은 time_required로 거부 (09:00 fallback 어긋남 방지). provider 미호출.
    #[tokio::test]
    async fn enable_rejects_when_no_time() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "무시각 루틴",
            RoutineFreq::Daily,
            vec![],
            None, // time_of_day 없음
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::default();
        let err = enable_routine_sync_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            "proj_personal",
            "cal",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "routine.sync.time_required");
        assert!(
            provider.created.lock().unwrap().is_empty(),
            "무시각 루틴은 create_event 미호출"
        );

        // 방어적 trim 검증: 정상 insert는 공백을 NULL로 정규화하므로, DB에 공백 문자열이
        // 직접 들어간 경우(이론상 경로)에도 guard가 무시각으로 취급하는지 직접 UPDATE로 확인.
        let blank = seed_routine(
            &db,
            "공백시각 루틴",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;
        sqlx::query("UPDATE routines SET time_of_day = '   ' WHERE id = ?1")
            .bind(&blank)
            .execute(&db)
            .await
            .unwrap();
        let err2 = enable_routine_sync_with_provider(
            &db,
            &provider,
            "tok",
            &blank,
            "proj_personal",
            "cal",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err2.code, "routine.sync.time_required");
    }

    /// enable: 개인 루틴 → 업무 프로젝트는 kind_mismatch로 거부 (교차 노출 차단). provider 미호출.
    #[tokio::test]
    async fn enable_rejects_kind_mismatch() {
        let db = fresh_db().await;
        seed_project(&db, "proj_work", "work").await;
        let rid = seed_routine(
            &db,
            "비타민",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::default();
        let err = enable_routine_sync_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            "proj_work",
            "cal",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "routine.sync.kind_mismatch");
        assert!(provider.created.lock().unwrap().is_empty());
    }

    /// enable: kind 미지정 루틴은 kind_required로 거부 (매핑 결정 불가). provider 미호출.
    #[tokio::test]
    async fn enable_rejects_kind_required() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "무명 루틴",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            None,
        )
        .await;
        let provider = RecordingProvider::default();
        let err = enable_routine_sync_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            "proj_personal",
            "cal",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "routine.sync.kind_required");
        assert!(provider.created.lock().unwrap().is_empty());
    }

    /// 이미 동기화 중 루틴 enable 재호출 → already_enabled 에러, provider 미호출.
    #[tokio::test]
    async fn enable_rejects_when_already_synced() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("19:00".into()),
            Some(Kind::Personal),
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
        let err = enable_routine_sync_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            "proj_personal",
            "c2",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "routine.sync.already_enabled");
        assert!(
            provider.created.lock().unwrap().is_empty(),
            "이미 sync면 provider.create_event 호출 안 됨"
        );
    }

    /// enable: monthly 루틴이 패턴 미지정이어도 day_of_month로 기본 적용 → BYMONTHDAY RRULE.
    #[tokio::test]
    async fn enable_monthly_defaults_day_of_month() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        // monthly + 패턴 미지정. insert_routine이 anchor를 오늘로 채운다.
        let rid = seed_routine(
            &db,
            "월간 점검",
            RoutineFreq::Monthly,
            vec![],
            Some("10:00".into()),
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::with_create_id("evt_m");

        enable_routine_sync_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            "proj_personal",
            "cal",
            "Asia/Seoul",
        )
        .await
        .unwrap();

        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1);
        assert!(
            created[0]
                .2
                .recurrence
                .iter()
                .any(|l| l.starts_with("RRULE:FREQ=MONTHLY;BYMONTHDAY=")),
            "패턴 미지정 monthly → day_of_month 기본(BYMONTHDAY)"
        );
    }

    /// disable: provider.delete_event 호출 + google_* 필드 NULL.
    #[tokio::test]
    async fn disable_deletes_master_and_clears_mirror() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "PT",
            RoutineFreq::Weekly,
            vec![MWeekday::Tue, MWeekday::Thu],
            Some("18:30".into()),
            Some(Kind::Personal),
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
        let rid = seed_routine(
            &db,
            "스트레칭",
            RoutineFreq::Daily,
            vec![],
            None,
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::default();
        disable_routine_sync_with_provider(&db, &provider, "tok", &rid)
            .await
            .unwrap();
        assert!(
            provider.deleted.lock().unwrap().is_empty(),
            "local-only 루틴은 provider 미호출"
        );
    }

    /// 루틴을 동기화 상태로 표시(테스트 헬퍼) — google_calendar_id/google_event_id 세팅.
    async fn mark_synced(db: &crate::db::Db, rid: &str, cal: &str, evt: &str) {
        sqlx::query(
            "UPDATE routines SET google_calendar_id = ?2, google_event_id = ?3 WHERE id = ?1",
        )
        .bind(rid)
        .bind(cal)
        .bind(evt)
        .execute(db)
        .await
        .unwrap();
    }

    /// patch: 동기화된 루틴 → master event PATCH 1회(recurrence+start+summary 동봉).
    #[tokio::test]
    async fn patch_propagates_to_master_event() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "주간 회의",
            RoutineFreq::Weekly,
            vec![MWeekday::Mon],
            Some("10:00".into()),
            Some(Kind::Work),
        )
        .await;
        mark_synced(&db, &rid, "cal_w", "evt_w").await;

        let provider = RecordingProvider::default();
        patch_routine_sync_with_provider(&db, &provider, "tok_p", &rid, "Asia/Seoul")
            .await
            .unwrap();

        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1, "patch_event 1회 호출");
        let (access, cal, evt, payload) = &patched[0];
        assert_eq!(access, "tok_p");
        assert_eq!(cal, "cal_w");
        assert_eq!(evt, "evt_w");
        assert_eq!(payload["summary"], "주간 회의");
        let rec = payload["recurrence"][0].as_str().unwrap();
        assert!(
            rec.starts_with("RRULE:FREQ=WEEKLY;BYDAY=MO"),
            "recurrence 라인 동봉: {rec}"
        );
        assert!(payload["start"]["dateTime"]
            .as_str()
            .unwrap()
            .ends_with("T10:00:00"));
        // §4: recurrence + start + end 동시 send — end도 동봉(기본 30분 fallback → 10:30).
        assert!(payload["end"]["dateTime"]
            .as_str()
            .unwrap()
            .ends_with("T10:30:00"));
    }

    /// patch: 미동기화 루틴이면 no-op (provider 미호출, 에러 없음 — 멱등).
    #[tokio::test]
    async fn patch_noop_when_not_synced() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "물 마시기",
            RoutineFreq::Daily,
            vec![],
            None,
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::default();
        patch_routine_sync_with_provider(&db, &provider, "tok", &rid, "Asia/Seoul")
            .await
            .unwrap();
        assert!(
            provider.patched.lock().unwrap().is_empty(),
            "미동기화 루틴은 patch_event 미호출"
        );
    }

    /// patch: 편집(freq daily→weekly Mon) 후 PATCH가 갱신된 스케줄을 반영(현재 row 기준).
    #[tokio::test]
    async fn patch_reflects_edited_schedule() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced(&db, &rid, "cal_g", "evt_g").await;

        // 스케줄 편집: daily → weekly(월).
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: rid.clone(),
                title: "헬스장".into(),
                freq: RoutineFreq::Weekly,
                weekdays: vec![MWeekday::Mon],
                anchor_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        let provider = RecordingProvider::default();
        patch_routine_sync_with_provider(&db, &provider, "tok", &rid, "Asia/Seoul")
            .await
            .unwrap();

        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1);
        let rec = patched[0].3["recurrence"][0].as_str().unwrap();
        assert!(
            rec.starts_with("RRULE:FREQ=WEEKLY;BYDAY=MO"),
            "PATCH가 편집된 weekly 스케줄 반영: {rec}"
        );
    }

    /// patch: provider 실패는 에러로 전파(호출자 update_routine이 patch_failed로 wrap).
    #[tokio::test]
    async fn patch_propagates_provider_error() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "PT",
            RoutineFreq::Weekly,
            vec![MWeekday::Tue],
            Some("18:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced(&db, &rid, "cal_p", "evt_p").await;

        let provider = RecordingProvider::default();
        *provider.patch_result.lock().unwrap() = Err(CalendarError::Terminal("boom".into()));
        let err = patch_routine_sync_with_provider(&db, &provider, "tok", &rid, "Asia/Seoul")
            .await
            .unwrap_err();
        // CalendarError → AppError From 변환으로 전파(코드 무관, 에러면 됨).
        assert!(!err.code.is_empty(), "provider 에러가 AppError로 전파");
    }

    /// 헬퍼 — routine_exdates 행 개수(특정 날짜).
    async fn exdate_count(db: &crate::db::Db, rid: &str, date: &str) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM routine_exdates WHERE routine_id = ?1 AND date = ?2",
        )
        .bind(rid)
        .bind(date)
        .fetch_one(db)
        .await
        .unwrap()
    }

    /// unschedule(오늘 빼기): 동기화 루틴 → exdate row 추가 + master event에 EXDATE PATCH 동봉.
    #[tokio::test]
    async fn unschedule_today_adds_exdate_and_patches_master() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced(&db, &rid, "cal_g", "evt_g").await;

        let provider = RecordingProvider::default();
        unschedule_today_with_provider(&db, &provider, "tok", &rid, "2026-06-01", "Asia/Seoul")
            .await
            .unwrap();

        assert_eq!(
            exdate_count(&db, &rid, "2026-06-01").await,
            1,
            "exdate row 1건"
        );

        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1, "master event PATCH 1회");
        let recurrence = patched[0].3["recurrence"].as_array().unwrap();
        assert!(
            recurrence.iter().any(|l| l
                .as_str()
                .is_some_and(|s| s.starts_with("EXDATE") && s.contains("20260601T070000"))),
            "EXDATE 라인에 빠진 날짜(time_of_day 동봉) 포함: {recurrence:?}"
        );
    }

    /// unschedule: 미동기화(local-only) 루틴 → exdate row만 추가, provider 미호출(로컬 hide).
    #[tokio::test]
    async fn unschedule_today_local_only_no_patch() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "비타민",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;

        let provider = RecordingProvider::default();
        unschedule_today_with_provider(&db, &provider, "tok", &rid, "2026-06-02", "Asia/Seoul")
            .await
            .unwrap();

        assert_eq!(
            exdate_count(&db, &rid, "2026-06-02").await,
            1,
            "exdate row 1건"
        );
        assert!(
            provider.patched.lock().unwrap().is_empty(),
            "미동기화 루틴은 patch_event 미호출"
        );
    }

    /// unschedule: 같은 (routine, date) 두 번 → exdate row 1건(INSERT OR IGNORE 멱등).
    #[tokio::test]
    async fn unschedule_today_is_idempotent() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "스트레칭",
            RoutineFreq::Daily,
            vec![],
            Some("08:00".into()),
            Some(Kind::Personal),
        )
        .await;

        let provider = RecordingProvider::default();
        for _ in 0..2 {
            unschedule_today_with_provider(&db, &provider, "tok", &rid, "2026-06-03", "Asia/Seoul")
                .await
                .unwrap();
        }
        assert_eq!(
            exdate_count(&db, &rid, "2026-06-03").await,
            1,
            "멱등 — PK(routine_id, date) 충돌 무시"
        );
    }

    /// restore(되돌리기): 동기화 루틴 → exdate row 삭제 + master event PATCH에서 그 EXDATE 제거.
    #[tokio::test]
    async fn restore_today_removes_exdate_and_patches() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "PT",
            RoutineFreq::Weekly,
            vec![MWeekday::Tue],
            Some("18:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced(&db, &rid, "cal_p", "evt_p").await;
        // 먼저 빼두기.
        sqlx::query("INSERT INTO routine_exdates (routine_id, date) VALUES (?1, '2026-06-09')")
            .bind(&rid)
            .execute(&db)
            .await
            .unwrap();

        let provider = RecordingProvider::default();
        restore_today_with_provider(&db, &provider, "tok", &rid, "2026-06-09", "Asia/Seoul")
            .await
            .unwrap();

        assert_eq!(
            exdate_count(&db, &rid, "2026-06-09").await,
            0,
            "exdate row 삭제됨"
        );
        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1, "master event PATCH 1회");
        let recurrence = patched[0].3["recurrence"].as_array().unwrap();
        assert!(
            !recurrence
                .iter()
                .any(|l| l.as_str().is_some_and(|s| s.contains("20260609"))),
            "되돌린 EXDATE는 recurrence에서 빠짐: {recurrence:?}"
        );
    }

    /// 잘못된 날짜 형식은 IPC 진입점 검증에서 거부(잘못된 EXDATE 새김 방지).
    #[tokio::test]
    async fn unschedule_today_rejects_bad_date() {
        assert_eq!(
            validate_ymd("2026/06/01").unwrap_err().code,
            "routine.exdate.bad_date"
        );
        assert_eq!(
            validate_ymd("not-a-date").unwrap_err().code,
            "routine.exdate.bad_date"
        );
        assert!(validate_ymd("2026-06-01").is_ok());
    }

    // ── PR 5: 캘린더 이동 / 삭제 / invariant 가드 ───────────────────────────────

    /// sync-pair invariant 검사 헬퍼 — cal_id와 evt_id는 항상 동시 set 또는 동시 NULL.
    /// 반환값은 "현재 동기화 중인가"(둘 다 set).
    async fn assert_pair_consistent(db: &crate::db::Db, rid: &str) -> bool {
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(rid)
        .fetch_one(db)
        .await
        .unwrap();
        assert_eq!(
            cal.is_some(),
            evt.is_some(),
            "sync-pair invariant: google_calendar_id ↔ google_event_id 동시 set/NULL"
        );
        cal.is_some()
    }

    /// move: 동기화 루틴을 다른 캘린더로 → 옛 master DELETE(옛 토큰) + 새 master CREATE(새 토큰) +
    /// mirror(project/cal/evt) 갱신.
    #[tokio::test]
    async fn move_deletes_old_and_creates_new() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // 옛 캘린더로 동기화 상태 + project_id set.
        sqlx::query(
            "UPDATE routines SET project_id='proj_personal', google_calendar_id='cal_old', \
             google_event_id='evt_old' WHERE id=?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let provider = RecordingProvider::with_create_id("evt_new");
        move_routine_sync_with_provider(
            &db,
            &provider,
            "tok_old",
            "tok_new",
            &rid,
            "proj_personal",
            "cal_new",
            "Asia/Seoul",
        )
        .await
        .unwrap();

        // DELETE 옛 master(옛 토큰/캘린더/이벤트).
        let deleted = provider.deleted.lock().unwrap().clone();
        assert_eq!(deleted.len(), 1, "옛 master DELETE 1회");
        assert_eq!(
            deleted[0],
            ("tok_old".into(), "cal_old".into(), "evt_old".into())
        );
        // CREATE 새 master(새 토큰/캘린더).
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1, "새 master CREATE 1회");
        assert_eq!(created[0].0, "tok_new");
        assert_eq!(created[0].1, "cal_new");

        // mirror 갱신 + pair 일관.
        assert!(assert_pair_consistent(&db, &rid).await);
        let (proj, cal, evt): (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT project_id, google_calendar_id, google_event_id FROM routines WHERE id=?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(proj.as_deref(), Some("proj_personal"));
        assert_eq!(cal.as_deref(), Some("cal_new"));
        assert_eq!(evt.as_deref(), Some("evt_new"));
    }

    /// move: 미동기화 루틴은 not_synced로 거부(provider 미호출).
    #[tokio::test]
    async fn move_rejects_when_not_synced() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "비타민",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::default();
        let err = move_routine_sync_with_provider(
            &db,
            &provider,
            "t",
            "t",
            &rid,
            "proj_personal",
            "cal",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "routine.sync.not_synced");
        assert!(provider.deleted.lock().unwrap().is_empty());
        assert!(provider.created.lock().unwrap().is_empty());
    }

    /// move: 새 프로젝트 kind 불일치는 **옛 master를 지우기 전에** 거부(파괴 전 가드). DELETE/CREATE
    /// 미호출 + mirror 불변(옛 캘린더 그대로 sync).
    #[tokio::test]
    async fn move_rejects_kind_mismatch_before_delete() {
        let db = fresh_db().await;
        seed_project(&db, "proj_old", "personal").await;
        seed_project(&db, "proj_work", "work").await;
        let rid = seed_routine(
            &db,
            "PT",
            RoutineFreq::Daily,
            vec![],
            Some("18:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // 개인 루틴, 옛 캘린더로 동기화 상태(옛 개인 프로젝트 proj_old).
        sqlx::query(
            "UPDATE routines SET project_id='proj_old', google_calendar_id='cal_old', \
             google_event_id='evt_old' WHERE id=?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let provider = RecordingProvider::default();
        // 업무 프로젝트로 이동 시도 → kind_mismatch.
        let err = move_routine_sync_with_provider(
            &db,
            &provider,
            "t",
            "t",
            &rid,
            "proj_work",
            "cal_new",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, "routine.sync.kind_mismatch");
        // 파괴 전 거부 — 옛 master 무손상.
        assert!(
            provider.deleted.lock().unwrap().is_empty(),
            "kind 불일치는 DELETE 전에 거부(비가역 상태 방지)"
        );
        assert!(provider.created.lock().unwrap().is_empty());
        // mirror 불변 + pair 일관(여전히 옛 캘린더 동기화).
        assert!(assert_pair_consistent(&db, &rid).await);
        let (cal, evt): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT google_calendar_id, google_event_id FROM routines WHERE id=?1")
                .bind(&rid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(cal.as_deref(), Some("cal_old"));
        assert_eq!(evt.as_deref(), Some("evt_old"));
    }

    /// move 부분 실패: 옛 master DELETE는 성공했으나 새 master CREATE가 실패하면 mirror는
    /// (cal=NULL, evt=NULL)로 남아 pair 일관 + 동기화 OFF 상태가 되고, 에러를 전파한다(사용자가
    /// 다시 켤 수 있게 truthful surface). project_id는 옛 값으로 남지만(stale, 재-enable이 새로
    /// set하므로 무해) sync-pair invariant는 깨지지 않는다.
    #[tokio::test]
    async fn move_create_failure_leaves_mirror_off_and_consistent() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        sqlx::query(
            "UPDATE routines SET project_id='proj_personal', google_calendar_id='cal_old', \
             google_event_id='evt_old' WHERE id=?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let provider = RecordingProvider::default();
        // DELETE는 성공(default Ok), CREATE만 실패.
        *provider.create_result.lock().unwrap() =
            Err(CalendarError::Terminal("create boom".into()));

        let err = move_routine_sync_with_provider(
            &db,
            &provider,
            "tok_old",
            "tok_new",
            &rid,
            "proj_personal",
            "cal_new",
            "Asia/Seoul",
        )
        .await
        .unwrap_err();
        assert!(!err.code.is_empty(), "CREATE 실패가 에러로 전파");

        // 옛 master는 지워졌고(DELETE 1회), 새 master는 생성 안 됨.
        assert_eq!(
            provider.deleted.lock().unwrap().len(),
            1,
            "옛 master DELETE 성공"
        );
        // mirror는 동기화 OFF(cal/evt NULL) + pair 일관.
        assert!(
            !assert_pair_consistent(&db, &rid).await,
            "CREATE 실패 후 동기화 OFF(cal/evt NULL)"
        );
        let (proj, cal, evt): (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT project_id, google_calendar_id, google_event_id FROM routines WHERE id=?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(cal.is_none() && evt.is_none(), "sync-pair NULL out");
        assert_eq!(
            proj.as_deref(),
            Some("proj_personal"),
            "project_id는 stale로 남음(의도 — 재-enable이 새로 set)"
        );
    }

    /// delete(master): 동기화 루틴 → delete_event 호출. mirror는 NULL 정리하지 않는다(행이 곧 삭제됨).
    #[tokio::test]
    async fn delete_master_deletes_when_synced() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced(&db, &rid, "cal_d", "evt_d").await;

        let provider = RecordingProvider::default();
        delete_master_with_provider(&db, &provider, "tok_x", &rid)
            .await
            .unwrap();
        let deleted = provider.deleted.lock().unwrap().clone();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0], ("tok_x".into(), "cal_d".into(), "evt_d".into()));
    }

    /// delete(master): 미동기화 루틴 → no-op(provider 미호출).
    #[tokio::test]
    async fn delete_master_noop_when_not_synced() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "비타민",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;
        let provider = RecordingProvider::default();
        delete_master_with_provider(&db, &provider, "tok", &rid)
            .await
            .unwrap();
        assert!(provider.deleted.lock().unwrap().is_empty());
    }

    /// delete(master): provider 실패는 에러로 전파(crud::delete_routine이 delete_remote_failed로
    /// wrap). helper는 로컬 행을 건드리지 않으므로 행이 보존된다(crud가 이 에러를 받으면 로컬
    /// delete를 호출하지 않음 — "Google 삭제 실패 시 로컬 보존").
    #[tokio::test]
    async fn delete_master_propagates_error_keeps_row() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "PT",
            RoutineFreq::Daily,
            vec![],
            Some("18:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced(&db, &rid, "cal_p", "evt_p").await;

        let provider = RecordingProvider::default();
        *provider.delete_result.lock().unwrap() = Err(CalendarError::Terminal("boom".into()));
        let err = delete_master_with_provider(&db, &provider, "tok", &rid)
            .await
            .unwrap_err();
        assert!(!err.code.is_empty(), "provider 에러가 AppError로 전파");

        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM routines WHERE id=?1")
            .bind(&rid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 1, "Google 삭제 실패 시 로컬 행 보존");
    }

    /// invariant: monthly_pattern/monthly_nth_week DB CHECK이 잘못된 값을 거부(스키마 가드 회귀).
    #[tokio::test]
    async fn monthly_check_constraints_reject_bad_values() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "회고",
            RoutineFreq::Monthly,
            vec![MWeekday::Tue],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;

        // monthly_pattern은 'day_of_month'|'nth_weekday'만 허용.
        assert!(
            sqlx::query("UPDATE routines SET monthly_pattern = 'bogus' WHERE id = ?1")
                .bind(&rid)
                .execute(&db)
                .await
                .is_err(),
            "monthly_pattern CHECK이 'bogus' 거부"
        );
        // monthly_nth_week은 -1..5(0 제외).
        for bad in [0_i64, 6, -2] {
            assert!(
                sqlx::query("UPDATE routines SET monthly_nth_week = ?2 WHERE id = ?1")
                    .bind(&rid)
                    .bind(bad)
                    .execute(&db)
                    .await
                    .is_err(),
                "monthly_nth_week CHECK이 {bad} 거부"
            );
        }
        // 유효값(nth_weekday + -1)은 통과.
        assert!(
            sqlx::query(
                "UPDATE routines SET monthly_pattern = 'nth_weekday', monthly_nth_week = -1 \
                 WHERE id = ?1"
            )
            .bind(&rid)
            .execute(&db)
            .await
            .is_ok(),
            "유효한 nth_weekday/-1은 통과"
        );
    }
}
