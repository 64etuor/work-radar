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

use std::sync::Arc;

use chrono::{Duration, NaiveDate, NaiveDateTime};
use tauri::State;
use tokio::sync::Notify;

use crate::{
    calendar::{
        build_event_payload, pending_store::upsert_write, timing::GOOGLE_SYNC_DEBOUNCE_MS,
        CalendarProvider, CreateEventInput, HttpCalendarProvider,
    },
    commands::calendar::access_token_for,
    db::Db,
    error::AppError,
    routines::rrule::{self, Freq, MonthlyPattern, RRuleInput, Weekday},
};
// P4c: 인라인 패리티 헬퍼(#[cfg(test)])만 사용 — 프로덕션 경로는 큐의 에러 분류를 쓴다.
#[cfg(test)]
use crate::calendar::CalendarError;

/// 동기화에 쓸 사용자 타임존 tzid(IANA 이름). OS 로컬 SSOT(`crate::timezone`)에서 파생한다 —
/// 리마인더(`reminders::compute_fire_at`)와 같은 zone을 써 같은 루틴의 캘린더 미러와 알림이
/// 일치한다. `Tz::name()`은 `&'static str`이라 기존 `tzid: &str` 시그니처에 그대로 들어간다
/// (감지 실패 시 UTC 폴백 — 중립값, 지역 하드코딩 없음).
fn default_tzid() -> &'static str {
    crate::timezone::user_timezone().name()
}

#[derive(sqlx::FromRow, Debug, Clone)]
struct RoutineSyncRow {
    project_id: Option<String>,
    title: String,
    freq: String,
    weekdays: Option<String>,
    anchor_date: Option<String>,
    /// 활성 구간(0061). start_date = DTSTART floor 소스, end_date = RRULE UNTIL 매핑 소스.
    start_date: Option<String>,
    end_date: Option<String>,
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

#[derive(Debug, Clone)]
pub(crate) struct RoutineEditSyncSnapshot {
    row: RoutineSyncRow,
}

async fn load_routine(db: &Db, id: &str) -> Result<RoutineSyncRow, AppError> {
    sqlx::query_as::<_, RoutineSyncRow>(
        "SELECT project_id, title, freq, weekdays, anchor_date, start_date, end_date, time_of_day, \
                duration_min, monthly_pattern, monthly_nth_week, kind, \
                google_calendar_id, google_event_id, created_at \
         FROM routines WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("routine.not_found", "루틴을 찾을 수 없습니다"))
}

pub(crate) async fn routine_edit_sync_snapshot(
    db: &Db,
    routine_id: &str,
) -> Result<Option<RoutineEditSyncSnapshot>, AppError> {
    let row = load_routine(db, routine_id).await?;
    // synced(google_event_id Some) 또는 pending-ENABLE(google_calendar_id Some, event_id NULL) 둘 다
    // 편집 시 큐 갱신 대상이므로 캡처한다(P4b). 완전 미동기화(둘 다 NULL)만 None →
    // patch_synced_routine_after_edit가 토큰/큐 없이 no-op.
    if row.google_calendar_id.is_none() && row.google_event_id.is_none() {
        return Ok(None);
    }
    Ok(Some(RoutineEditSyncSnapshot { row }))
}

/// 프로젝트 kind 조회 ('personal'|'work'). 프로젝트 없으면 not_found.
async fn project_kind(db: &Db, project_id: &str) -> Result<String, AppError> {
    sqlx::query_scalar::<_, String>("SELECT kind FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("project.not_found", "프로젝트를 찾을 수 없습니다"))
}

/// project의 Google access token 조회(필요 시 refresh). 미연결이면 not_connected.
/// enable/disable/move/patch/delete IPC가 반복하던 토큰 조회 + 에러 매핑을 한 곳으로 모은다.
async fn access_token_or_not_connected(db: &Db, project_id: &str) -> Result<String, AppError> {
    access_token_for(db, project_id)
        .await
        .map_err(|e| AppError::terminal("calendar.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "calendar.not_connected",
                "미연결 — 먼저 Google Calendar를 연결하세요",
            )
        })
}

/// 동기화 루틴의 project_id를 꺼낸다(enable이 set하므로 동기화 중이면 있어야 함). 없으면 no_project.
fn require_project_id(row: &RoutineSyncRow) -> Result<&str, AppError> {
    row.project_id.as_deref().ok_or_else(|| {
        AppError::validation(
            "routine.sync.no_project",
            "프로젝트가 없는 루틴은 동기화할 수 없습니다",
        )
    })
}

/// stale mirror reactive sweep — `google_calendar_id`/`google_event_id`를 NULL out(ADR-0005
/// "404 → sweep"). disable(DELETE 후 정리)와 PATCH 404 경로가 공유하는 단일 sync-pair 해제 SQL.
async fn clear_google_mirror<'e, E>(exec: E, routine_id: &str) -> Result<(), AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "UPDATE routines SET google_calendar_id = NULL, google_event_id = NULL WHERE id = ?1",
    )
    .bind(routine_id)
    .execute(exec)
    .await?;
    Ok(())
}

/// stale mirror(Google master가 외부에서 삭제됨)로 sync를 자동 해제했을 때의 terminal 에러.
/// 코드(`SYNC_EXPIRED_CODE`)로 식별되며, 호출자 wrapper(patch_failed/exdate_patch_failed)는 이
/// 코드를 마스킹하지 않고 그대로 통과시켜 "다시 켜세요" 안내가 토스트에 닿게 한다(generic
/// patch_failed로 덮으면 재연결 안내가 손실). 로컬 변경(편집/exdate row)은 이미 커밋돼 유지된다.
pub(crate) const SYNC_EXPIRED_CODE: &str = "routine.sync.expired";

// P4c: 호출자(patch/split 인라인 패리티 헬퍼)가 #[cfg(test)]로 이동 — 프로덕션 sync-expired
// surfacing은 워커의 Terminal("sync expired") + CalendarSyncFailed 이벤트가 담당한다.
#[cfg(test)]
fn sync_expired() -> AppError {
    AppError::terminal(
        SYNC_EXPIRED_CODE,
        "Google 캘린더에서 이 일정이 사라져 동기화를 자동 해제했습니다 — \
         로컬 변경은 유지됩니다. 동기화를 다시 켜세요",
    )
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

// rrule 로컬 enum → models enum 변환(due-calc SSOT `routine_due_on`은 models 타입을 받는다).
// 문자열 파싱은 parse_freq/parse_weekday_str/parse_monthly_pattern 단일 경로를 재사용한다.
fn to_model_freq(f: Freq) -> crate::models::RoutineFreq {
    use crate::models::RoutineFreq as M;
    match f {
        Freq::Daily => M::Daily,
        Freq::Weekly => M::Weekly,
        Freq::Biweekly => M::Biweekly,
        Freq::Monthly => M::Monthly,
    }
}

fn to_model_weekday(w: Weekday) -> crate::models::Weekday {
    use crate::models::Weekday as M;
    match w {
        Weekday::Mon => M::Mon,
        Weekday::Tue => M::Tue,
        Weekday::Wed => M::Wed,
        Weekday::Thu => M::Thu,
        Weekday::Fri => M::Fri,
        Weekday::Sat => M::Sat,
        Weekday::Sun => M::Sun,
    }
}

fn to_model_pattern(p: MonthlyPattern) -> crate::models::RoutineMonthlyPattern {
    use crate::models::RoutineMonthlyPattern as M;
    match p {
        MonthlyPattern::DayOfMonth => M::DayOfMonth,
        MonthlyPattern::NthWeekday => M::NthWeekday,
    }
}

fn parse_period_ymd(v: &str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(v, "%Y-%m-%d").map_err(|_| {
        AppError::validation(
            "routine.period.bad_date",
            "날짜 형식이 YYYY-MM-DD가 아닙니다",
        )
    })
}

/// 활성 구간 시작 floor → Google DTSTART 날짜 계산. `floor = max(start, reference_override)`
/// (split 시 reference_override=effective_date라 과거 구간 재생성/중복을 막는다) 이후 첫 **due 발생일**을
/// 로컬 due-calc(`routine_due_on`)로 찾아 'YYYY-MM-DD'로 반환한다. 패턴은 row의 원래 freq/anchor/
/// monthly_pattern 그대로라 biweekly 2주 parity·monthly day 클램프·nth_weekday가 로컬과 **구성적으로
/// 일치**한다. `end`까지(있으면) 발생이 없으면 `routine.sync.empty_window`(파괴적 Google 호출 전 차단).
/// 스캔 상한 366일(early-exit) — nth_weekday 5번째 미존재 월 건너뜀까지 커버.
fn first_due_on_or_after(
    row: &RoutineSyncRow,
    start: &str,
    reference_override: Option<&str>,
    end: Option<&str>,
) -> Result<String, AppError> {
    use super::schedule::routine_due_on;

    let start_d = parse_period_ymd(start)?;
    let floor = match reference_override {
        Some(r) => start_d.max(parse_period_ymd(r)?),
        None => start_d,
    };
    let end_d = end.map(parse_period_ymd).transpose()?;

    let freq = to_model_freq(parse_freq(&row.freq)?);
    let weekdays: Vec<crate::models::Weekday> = parse_weekdays_json(row.weekdays.as_deref())?
        .into_iter()
        .map(to_model_weekday)
        .collect();
    let pattern = match row.monthly_pattern.as_deref() {
        Some(s) => Some(to_model_pattern(parse_monthly_pattern(s)?)),
        None if matches!(freq, crate::models::RoutineFreq::Monthly) => {
            Some(crate::models::RoutineMonthlyPattern::DayOfMonth)
        }
        None => None,
    };
    let nth_week = row.monthly_nth_week.map(|n| n as i32);

    let mut d = floor;
    for _ in 0..=366 {
        if let Some(e) = end_d {
            if d > e {
                break;
            }
        }
        if routine_due_on(
            freq,
            &weekdays,
            row.anchor_date.as_deref(),
            pattern,
            nth_week,
            d,
        ) {
            return Ok(d.format("%Y-%m-%d").to_string());
        }
        d += Duration::days(1);
    }
    Err(AppError::validation(
        "routine.sync.empty_window",
        "활성 구간 안에 반복 발생이 없습니다 — 기간 또는 반복 설정을 확인하세요",
    ))
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
    build_master_event_input_with_reference(db, routine_id, row, tzid, None).await
}

async fn build_master_event_input_with_reference(
    db: &Db,
    routine_id: &str,
    row: &RoutineSyncRow,
    tzid: &str,
    reference_override: Option<&str>,
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
    let reference = reference_override
        .or_else(|| row.created_at.get(0..10))
        .ok_or_else(|| {
            AppError::validation(
                "routine.created_at_malformed",
                "routine.created_at 포맷이 YYYY-MM-DD HH:MM:SS가 아닙니다",
            )
        })?;

    // 활성 구간(0061) → Google 미러: start_date면 DTSTART를 "start 이후 첫 발생일"로 내리고
    // (parity 보존), end_date면 RRULE에 UNTIL을 부착한다. 빈 문자열은 무경계로 정규화.
    let window_start = row
        .start_date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let window_end = row
        .end_date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // 둘 중 하나라도 있으면 floor 이후 첫 발생을 DTSTART로 확정한다. start_date가 없을 때 floor=자연
    // 기준(reference: enable=created_at / split=effective_date) — 이렇게 해야 end_date만 있고 그 end가
    // DTSTART보다 과거인 경우(예: 만료된 end-only 루틴 enable)에도 first_due_on_or_after의 빈-구간
    // 가드가 작동해 'DTSTART > UNTIL' 깨진 RRULE 대신 routine.sync.empty_window로 정직하게 거부한다.
    // start_date가 있으면 기존대로 floor=max(start, reference_override). 둘 다 없으면 override 없음(기존 동작).
    let effective_dtstart = match (window_start, window_end) {
        (None, None) => None,
        _ => Some(first_due_on_or_after(
            row,
            window_start.unwrap_or(reference),
            reference_override,
            window_end,
        )?),
    };

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
        dtstart_override: effective_dtstart.as_deref(),
        window_end,
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

/// 큐 dialect 브리지 — 순수 빌더의 `CreateEventInput`(start/end 절대시각 wall-clock)을 지연 큐의
/// `parse_create_input`(sync.rs)이 기대하는 `{title, start, duration_min, all_day, recurrence,
/// time_zone}` payload로 변환한다. 큐가 end를 스스로 계산하므로 여기선 duration_min만 넘긴다 —
/// parse_create_input과 P3(series_replace)를 불변으로 둔다. duration_min = start~end 사이 whole
/// minutes(recurring wall-clock이라 둘 다 `%Y-%m-%dT%H:%M:%S` NaiveDateTime으로 파싱). 루틴 마스터는
/// timed(all_day=false)라 end>start가 보장돼야 한다 — 아니면 validation 에러(파괴적 큐 행 방지).
/// `CreateEventInput`은 Serialize 미파생이므로 필드에서 serde_json::json!로 직접 조립한다.
fn master_create_payload(input: &CreateEventInput) -> Result<String, AppError> {
    Ok(master_create_payload_value(input)?.to_string())
}

/// `master_create_payload`의 Value 버전 — series_replace 큐 행의 `new_create`를 조립할 때 String으로
/// 이중 직렬화하지 않고 Value로 바로 끼우기 위함(P4b). String 버전은 이걸 `.to_string()`으로 감싼다
/// (기존 패리티 테스트가 그대로 green이어야 하므로 출력은 동일).
fn master_create_payload_value(input: &CreateEventInput) -> Result<serde_json::Value, AppError> {
    let start = NaiveDateTime::parse_from_str(&input.start, "%Y-%m-%dT%H:%M:%S").map_err(|_| {
        AppError::validation(
            "routine.sync.bad_start",
            "마스터 이벤트 start가 wall-clock ISO 형식이 아닙니다",
        )
    })?;
    let end = NaiveDateTime::parse_from_str(&input.end, "%Y-%m-%dT%H:%M:%S").map_err(|_| {
        AppError::validation(
            "routine.sync.bad_end",
            "마스터 이벤트 end가 wall-clock ISO 형식이 아닙니다",
        )
    })?;
    let duration_min = (end - start).num_minutes();
    if duration_min <= 0 {
        return Err(AppError::validation(
            "routine.sync.bad_duration",
            "마스터 이벤트 종료가 시작보다 빠르거나 같습니다",
        ));
    }
    let mut payload = serde_json::json!({
        "title": input.title,
        "start": input.start,
        "duration_min": duration_min,
        "all_day": input.all_day,
        "recurrence": input.recurrence,
    });
    if let Some(tz) = input.time_zone.as_deref() {
        payload["time_zone"] = serde_json::Value::String(tz.to_string());
    }
    // description을 방어적으로 전달 — 현재 build_master_event_input은 None이라 무영향이지만, 이후
    // 마스터가 description을 달면 큐 경로가 조용히 떨구지 않도록 한다(parse_create_input이 읽음).
    if let Some(desc) = input.description.as_deref().filter(|s| !s.is_empty()) {
        payload["description"] = serde_json::Value::String(desc.to_string());
    }
    Ok(payload)
}

fn until_for_previous_day(
    effective_date: &str,
    time_of_day: Option<&str>,
    tzid: &str,
) -> Result<String, AppError> {
    let effective = NaiveDate::parse_from_str(effective_date, "%Y-%m-%d").map_err(|_| {
        AppError::validation(
            "routine.edit.bad_effective_date",
            "날짜 형식이 YYYY-MM-DD가 아닙니다",
        )
    })?;
    let previous = effective - Duration::days(1);
    // UNTIL은 UTC여야 한다 — 이벤트가 start.timeZone을 달고 나가므로(rrule::until_utc doc 참조).
    rrule::until_utc(&previous.format("%Y-%m-%d").to_string(), time_of_day, tzid)
        .map_err(|e| AppError::validation("routine.rrule_invalid", format!("UNTIL 매핑 실패: {e}")))
}

fn cap_recurrence_before(input: &mut CreateEventInput, until: &str) -> Result<(), AppError> {
    let Some(rrule_line) = input.recurrence.first_mut() else {
        return Err(AppError::validation(
            "routine.rrule_invalid",
            "반복 규칙이 없어 시리즈를 분할할 수 없습니다",
        ));
    };
    let Some(rule) = rrule_line.strip_prefix("RRULE:") else {
        return Err(AppError::validation(
            "routine.rrule_invalid",
            "RRULE 라인 형식이 올바르지 않습니다",
        ));
    };
    let base = rule
        .split(';')
        .filter(|part| !part.starts_with("UNTIL="))
        .collect::<Vec<_>>()
        .join(";");
    *rrule_line = format!("RRULE:{base};UNTIL={until}");
    Ok(())
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
///
/// P4a: 프로덕션 enable 경로는 지연 큐(`enable_routine_google_sync_inner`)로 전환됨 — 이 provider
/// 주입 헬퍼는 인라인 패리티 테스트용으로만 유지한다(retained for inline-parity tests).
#[cfg(test)]
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
///
/// P4a: 프로덕션 disable 경로는 지연 큐(`disable_routine_google_sync_inner`)로 전환됨 — 이 헬퍼는
/// 인라인 패리티 테스트용으로만 유지한다(retained for inline-parity tests).
#[cfg(test)]
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

    // 404/410(이미 삭제됨/stale mirror)은 delete_request가 멱등 Ok로 흡수하므로(http.rs) 여기선
    // graceful — 로컬 mirror만 정리하면 된다. 그 외(401/403/5xx 등)는 전파해 사용자가 재시도.
    provider.delete_event(access_token, cal_id, evt_id).await?;

    clear_google_mirror(db, routine_id).await
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
///
/// P4c: 프로덕션 move 경로는 지연 큐(`move_routine_google_sync_inner`, 2-행 delete+create)로 전환됨 —
/// 이 인라인 헬퍼는 패리티 테스트용으로만 유지한다(retained for inline-parity tests).
#[cfg(test)]
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
    // 현재 동기화 중인 바로 그 캘린더로의 이동 = 무의미한 DELETE+CREATE round-trip — no-op(Ok)으로
    // 차단한다. 같은 물리 캘린더를 여러 프로젝트가 고르면 발생 가능(프런트 dedup/필터는 happy-path
    // 가드일 뿐). DELETE 후 CREATE 실패 시 이벤트 유실 + Google-side 메타 손실 위험이라 권위 계층에서
    // 막는다. sync-pair invariant로 google_event_id가 Some이면 google_calendar_id도 Some이다.
    if row.google_calendar_id.as_deref() == Some(new_calendar_id) {
        return Ok(());
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
///
/// P4b: 프로덕션 경로(exdate/편집)는 이제 지연 큐로 전환됨 — 이 순수 헬퍼는 patch 매핑 패리티
/// 테스트용으로만 유지한다(retained for parity tests; production path = queue).
#[cfg(test)]
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
    match provider
        .patch_event(access_token, cal_id, evt_id, &payload)
        .await
    {
        Ok(()) => Ok(()),
        // stale mirror: Google master가 외부에서 삭제됨(404/410) → reactive sweep + 재연결 안내.
        // ADR-0005 "404 → sweep". DELETE 경로의 멱등 처리와 대칭(거긴 Ok로 흡수, 여긴 진행 불가라
        // sync를 해제하고 surface). NULL out 없이 두면 이후 모든 편집·"오늘 빼기"가 영구 실패한다.
        Err(CalendarError::NotFound(_)) => {
            clear_google_mirror(db, routine_id).await?;
            Err(sync_expired())
        }
        Err(e) => Err(e.into()),
    }
}

/// Provider injection helper — synced routine edit must not rewrite past generated instances.
/// It caps the old master before `effective_date`, creates a new master from `effective_date`, and
/// moves the local mirror to the new master id.
///
/// P4b: production path = queue (series_replace) — retained for parity tests only.
#[cfg(test)]
pub(crate) async fn split_routine_sync_after_edit_with_provider<P: CalendarProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    routine_id: &str,
    before: RoutineEditSyncSnapshot,
    effective_date: &str,
    tzid: &str,
) -> Result<(), AppError> {
    let (Some(cal_id), Some(old_evt_id)) = (
        before.row.google_calendar_id.as_deref(),
        before.row.google_event_id.as_deref(),
    ) else {
        return Ok(());
    };

    let mut old_input = build_master_event_input(db, routine_id, &before.row, tzid).await?;
    let until = until_for_previous_day(effective_date, before.row.time_of_day.as_deref(), tzid)?;
    cap_recurrence_before(&mut old_input, &until)?;
    let old_payload = build_event_payload(&old_input);

    match provider
        .patch_event(access_token, cal_id, old_evt_id, &old_payload)
        .await
    {
        Ok(()) => {}
        Err(CalendarError::NotFound(_)) => {
            clear_google_mirror(db, routine_id).await?;
            return Err(sync_expired());
        }
        Err(e) => return Err(e.into()),
    }

    let row = load_routine(db, routine_id).await?;
    let new_input =
        build_master_event_input_with_reference(db, routine_id, &row, tzid, Some(effective_date))
            .await?;
    let (new_event_id, _html_link) = match provider
        .create_event(access_token, cal_id, &new_input)
        .await
    {
        Ok(created) => created,
        Err(e) => {
            clear_google_mirror(db, routine_id).await?;
            crate::commands::calendar::invalidate_calendar_events_cache().await;
            return Err(e.into());
        }
    };
    sqlx::query("UPDATE routines SET google_calendar_id = ?1, google_event_id = ?2 WHERE id = ?3")
        .bind(cal_id)
        .bind(&new_event_id)
        .bind(routine_id)
        .execute(db)
        .await?;
    Ok(())
}

/// pending-ENABLE(google_calendar_id Some, event_id NULL) 상태에서 편집/exdate가 오면 큐잉된 create
/// payload를 **현재 row** 기준으로 다시 만들어 갱신한다(UPDATE만 — INSERT 절대 안 함, 0행=정상).
/// P4a의 stale-payload NIT 해소: 워커가 flush하기 전 편집이 반영된다. 빌더 실패는 로컬 편집을
/// 되돌리지 않는다(이미 커밋됨) — warn-log 후 반환, 큐 create는 stale하게 남는다(문서화된 코너).
async fn refresh_pending_create_payload(
    db: &Db,
    notify: &Arc<Notify>,
    routine_id: &str,
    tzid: &str,
) {
    let payload = match load_routine(db, routine_id).await {
        Ok(row) => match build_master_event_input(db, routine_id, &row, tzid).await {
            Ok(input) => match master_create_payload(&input) {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!(
                        code = "routine.sync.pending_refresh_failed",
                        error = %e,
                        "queued create payload refresh skipped (builder); stays stale"
                    );
                    return;
                }
            },
            Err(e) => {
                tracing::warn!(
                    code = "routine.sync.pending_refresh_failed",
                    error = %e,
                    "queued create payload refresh skipped (builder); stays stale"
                );
                return;
            }
        },
        Err(e) => {
            tracing::warn!(
                code = "routine.sync.pending_refresh_failed",
                error = %e,
                "queued create payload refresh skipped (load); stays stale"
            );
            return;
        }
    };
    match sqlx::query(
        "UPDATE pending_calendar_writes SET payload_json = ?1 \
         WHERE target_kind = 'routine_master' AND target_id = ?2 AND kind = 'create'",
    )
    .bind(&payload)
    .bind(routine_id)
    .execute(db)
    .await
    {
        Ok(_) => notify.notify_one(),
        Err(e) => tracing::warn!(
            code = "routine.sync.pending_refresh_failed",
            error = %e,
            "queued create payload UPDATE failed; stays stale"
        ),
    }
}

/// 루틴 편집 후 동기화 전파(crud::update_routine에서 호출). P4b: 인라인 provider 호출 대신 **지연 큐**.
/// 미동기화면 no-op. synced면 series_replace 큐 행을 만들고(순수 빌더로 old_patch/new_create 조립,
/// provider/토큰 조회 0), pending-ENABLE이면 큐잉된 create payload를 편집 반영해 refresh한다.
/// 빌더 검증 에러(empty_window/rrule_invalid 등)는 enqueue 시점에 동기로 surface(인라인과 동일 UX).
#[allow(clippy::result_large_err)]
pub(crate) async fn patch_synced_routine_after_edit(
    db: &Db,
    notify: &Arc<Notify>,
    routine_id: &str,
    before: Option<RoutineEditSyncSnapshot>,
    effective_date: &str,
) -> Result<(), AppError> {
    let Some(before) = before else {
        // 미동기화 — 토큰/큐 없이 no-op (편집의 흔한 경우).
        return Ok(());
    };
    let tzid = default_tzid();

    // synced(cal + evt 둘 다 Some) → series_replace 큐잉. 인라인 split과 동일한 것을 payload로 조립:
    // old_patch = capped before-input의 build_event_payload, new_create = post-edit row의 큐 방언.
    if let (Some(cal_id), Some(old_evt_id)) = (
        before.row.google_calendar_id.clone(),
        before.row.google_event_id.clone(),
    ) {
        let mut old_input = build_master_event_input(db, routine_id, &before.row, tzid).await?;
        let until =
            until_for_previous_day(effective_date, before.row.time_of_day.as_deref(), tzid)?;
        cap_recurrence_before(&mut old_input, &until)?;
        let old_patch = build_event_payload(&old_input);

        let row = load_routine(db, routine_id).await?;
        let new_input = build_master_event_input_with_reference(
            db,
            routine_id,
            &row,
            tzid,
            Some(effective_date),
        )
        .await?;
        let new_create = master_create_payload_value(&new_input)?;

        let payload = serde_json::json!({
            "old_event_id": old_evt_id,
            "old_patch": old_patch,
            "new_create": new_create,
        })
        .to_string();
        upsert_write(
            db,
            "series_replace",
            "routine_master",
            routine_id,
            &cal_id,
            None,
            &payload,
            GOOGLE_SYNC_DEBOUNCE_MS,
        )
        .await?;
        notify.notify_one();
        return Ok(());
    }

    // pending-ENABLE(cal Some, evt NULL) → 큐잉된 create payload refresh(stale-payload NIT 해소).
    if before.row.google_calendar_id.is_some() {
        refresh_pending_create_payload(db, notify, routine_id, tzid).await;
        return Ok(());
    }

    // 그 외(미동기화) → no-op.
    Ok(())
}

/// exdate 편집 후 동기화 전파("오늘 빼기"/undo). P4b: 지연 큐. synced면 full master patch payload를
/// patch 큐 행으로(EXDATE 포함 recurrence), pending-ENABLE이면 create payload refresh, 미동기화면 no-op.
/// provider/토큰 조회 0.
#[allow(clippy::result_large_err)]
pub(crate) async fn patch_synced_routine_exdates(
    db: &Db,
    notify: &Arc<Notify>,
    routine_id: &str,
) -> Result<(), AppError> {
    let row = load_routine(db, routine_id).await?;
    let tzid = default_tzid();

    // synced → full master 입력(build_master_event_input이 routine_exdates 재읽어 EXDATE 동봉)을 큐
    // 방언으로 patch 행에 실는다. sync.rs::build_patch_body가 title→summary + start/end(timeZone) +
    // recurrence로 직렬화한다(all_day 키는 무시). event_id=현재 마스터.
    if let (Some(cal_id), Some(evt_id)) =
        (row.google_calendar_id.clone(), row.google_event_id.clone())
    {
        let input = build_master_event_input(db, routine_id, &row, tzid).await?;
        let payload = master_create_payload(&input)?;
        upsert_write(
            db,
            "patch",
            "routine_master",
            routine_id,
            &cal_id,
            Some(&evt_id),
            &payload,
            GOOGLE_SYNC_DEBOUNCE_MS,
        )
        .await?;
        notify.notify_one();
        return Ok(());
    }

    // pending-ENABLE → create payload refresh(EXDATE도 build_master_event_input이 반영).
    if row.google_calendar_id.is_some() {
        refresh_pending_create_payload(db, notify, routine_id, tzid).await;
        return Ok(());
    }

    // 미동기화 → no-op.
    Ok(())
}

/// 루틴 삭제 전 Google master event 정리(crud::delete_routine에서 호출). 동기화 OFF면 토큰 조회
/// 없이 no-op. 동기화 ON이면 master event DELETE — 실패는 호출자가 delete_remote_failed로 surface
/// (로컬 행은 보존, 사용자가 "로컬만 삭제" confirm).
#[allow(clippy::result_large_err)]
pub(crate) async fn delete_routine_master_event(db: &Db, routine_id: &str) -> Result<(), AppError> {
    let mut row = load_routine(db, routine_id).await?;
    // pending ENABLE 중 삭제(google_calendar_id만 set, 워커가 아직 link 안 함): disable과 동일한 양측
    // CAS로 orphan을 막는다(critic P4a round-5). google_event_id IS NULL일 때만 취소.
    //  · 취소가 이김 → pending create 제거(워커가 fetch했으면 create arm CAS가 google_calendar_id
    //    NULL 또는 routine 행 삭제를 보고 orphan 마스터를 삭제).
    //  · 취소가 짐(워커가 먼저 link) → reload해 아래 인라인 master DELETE로 링크된 마스터를 지운다.
    if row.google_event_id.is_none() {
        if row.google_calendar_id.is_none() {
            return Ok(()); // 미동기화 — 토큰 조회 없이 no-op (삭제의 흔한 경우).
        }
        // P5A: 취소 CAS + pending-create DELETE를 한 트랜잭션으로 — CAS가 이겼는데 DELETE가 실패하면
        // 미러는 clear됐는데 create 큐 행이 남아 워커가 (곧 삭제될) 루틴의 마스터를 만든다.
        let mut tx = db.begin().await?;
        let cancelled = sqlx::query(
            "UPDATE routines SET google_calendar_id = NULL WHERE id = ?1 AND google_event_id IS NULL",
        )
        .bind(routine_id)
        .execute(&mut *tx)
        .await?;
        if cancelled.rows_affected() > 0 {
            sqlx::query(
                "DELETE FROM pending_calendar_writes \
                 WHERE target_kind = 'routine_master' AND target_id = ?1 AND kind = 'create'",
            )
            .bind(routine_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(());
        }
        // 취소가 짐 — CAS 0행이라 롤백(무손실)하고 reload해 아래 인라인 master DELETE로 진행.
        tx.rollback().await?;
        row = load_routine(db, routine_id).await?;
    }
    if row.google_event_id.is_none() {
        return Ok(()); // 방어적 — 레이스로 이미 정리됨.
    }
    let project_id = require_project_id(&row)?;
    let access = access_token_or_not_connected(db, project_id).await?;
    let provider = HttpCalendarProvider::new()?;
    delete_master_with_provider(db, &provider, &access, routine_id).await
}

/// 루틴 Google 동기화 ON. `project_id`는 routine.kind와 같은 kind의 프로젝트(개인→개인,
/// 업무→업무) — 프런트가 그 프로젝트의 캘린더를 picker로 넘긴다. 토큰은 그 프로젝트의 OAuth.
#[tauri::command]
#[specta::specta]
pub async fn enable_routine_google_sync(
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
    routine_id: String,
    project_id: String,
    calendar_id: String,
) -> Result<(), AppError> {
    enable_routine_google_sync_inner(
        db.inner(),
        notify.inner(),
        &routine_id,
        &project_id,
        &calendar_id,
    )
    .await
}

/// enable IPC의 테스트 가능한 코어(provider/토큰 조회 없음). P4a: 인라인 provider 호출 대신
/// **지연 큐**로 전환 — 사전 가드는 인라인으로 검증하고, 낙관적 로컬 미러(project_id +
/// google_calendar_id 즉시 set)를 남긴 뒤 create 큐 행을 만들고 워커를 깨운다. Google flush·
/// 링크백(event_id)·재시도는 큐 워커가 소유(signal/routine_check 경로와 동일한 관측 타이밍).
pub(crate) async fn enable_routine_google_sync_inner(
    pool: &Db,
    notify: &Arc<Notify>,
    routine_id: &str,
    project_id: &str,
    calendar_id: &str,
) -> Result<(), AppError> {
    // 사전 가드(provider/토큰 없이): 존재·중복·kind/시간.
    let row = load_routine(pool, routine_id).await?;
    if row.google_event_id.is_some() {
        return Err(AppError::validation(
            "routine.sync.already_enabled",
            "이미 동기화 중인 루틴입니다",
        ));
    }
    ensure_kind_and_time(pool, &row, project_id).await?;

    // 순수 빌더 → 큐 dialect payload.
    let input = build_master_event_input(pool, routine_id, &row, default_tzid()).await?;
    let payload = master_create_payload(&input)?;

    // 낙관적 로컬 미러: project_id + google_calendar_id를 지금 set, google_event_id는 NULL로
    // 남겨 워커 link_back이 flush 시 박게 한다(pending 윈도우 동안 half-state — signal 경로와 동일).
    // P5A: 미러 UPDATE + create 큐 행을 **한 트랜잭션**으로 원자화한다 — 미러만 set되고 큐 행이
    // 실패하면 워커가 만들 create 행 없이 pending-enable(cal Some, evt NULL) 상태로 torn되기 때문.
    // SQLite 단일 writer라 tx = 한 단위로 직렬화(양측 CAS 모델은 tx로 오히려 강화). 읽기/검증은
    // 위에서 pool로 끝냈고, notify는 commit 후에만 울린다.
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE routines SET project_id = ?1, google_calendar_id = ?2 WHERE id = ?3")
        .bind(project_id)
        .bind(calendar_id)
        .bind(routine_id)
        .execute(&mut *tx)
        .await?;
    upsert_write(
        &mut *tx,
        "create",
        "routine_master",
        routine_id,
        calendar_id,
        None,
        &payload,
        GOOGLE_SYNC_DEBOUNCE_MS,
    )
    .await?;
    tx.commit().await?;
    notify.notify_one();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn disable_routine_google_sync(
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
    routine_id: String,
) -> Result<(), AppError> {
    disable_routine_google_sync_inner(db.inner(), notify.inner(), &routine_id).await
}

/// disable IPC의 테스트 가능한 코어(provider/토큰 조회 없음). P4a: 인라인 delete 대신 지연 큐로 —
/// 로컬 미러를 즉시 clear하고 delete 큐 행(event_id=옛 마스터)을 넣는다. 실제 Google delete·재시도는
/// 워커가 소유. 미동기화면 no-op(토큰/큐 없음).
pub(crate) async fn disable_routine_google_sync_inner(
    pool: &Db,
    notify: &Arc<Notify>,
    routine_id: &str,
) -> Result<(), AppError> {
    let mut row = load_routine(pool, routine_id).await?;

    // pending ENABLE(낙관적 google_calendar_id만 set, 워커가 아직 link 안 함)면 원자적으로 취소한다.
    // google_event_id IS NULL일 때만 취소(CAS) — 워커의 relink CAS(google_calendar_id IS NOT NULL)와의
    // lost-update를 막는다. SQLite 단일 writer라 두 CAS는 직렬화된다:
    //  · 취소가 먼저: google_calendar_id=NULL → 워커 CAS 0행 → 워커가 orphan 마스터 삭제.
    //  · 워커가 먼저: google_event_id set → 취소 CAS 0행 → reload해 아래 정상 delete로 링크된 마스터 삭제.
    // 어느 순서든 결과 = disabled + orphan 없음(critic P4a round-4).
    if row.google_event_id.is_none() {
        if row.google_calendar_id.is_none() {
            return Ok(()); // 진짜 미동기화 — no-op(토큰/큐 없음).
        }
        // P5A: 취소 CAS + pending-create DELETE를 한 트랜잭션으로 — CAS가 이겼는데 DELETE가
        // 실패하면 미러는 clear됐는데 create 큐 행이 남아 워커가 사용자가 끈 동기화를 되살린다.
        let mut tx = pool.begin().await?;
        let cancelled = sqlx::query(
            "UPDATE routines SET google_calendar_id = NULL \
             WHERE id = ?1 AND google_event_id IS NULL",
        )
        .bind(routine_id)
        .execute(&mut *tx)
        .await?;
        if cancelled.rows_affected() > 0 {
            // 취소가 이김 — pending create 제거(워커가 이미 fetch했으면 0행이지만 워커 CAS가 orphan 처리).
            sqlx::query(
                "DELETE FROM pending_calendar_writes \
                 WHERE target_kind = 'routine_master' AND target_id = ?1 AND kind = 'create'",
            )
            .bind(routine_id)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            notify.notify_one();
            return Ok(());
        }
        // 취소가 짐 — 워커가 먼저 link함. CAS가 0행이라 롤백(무손실)하고 reload해 정상 delete 경로로
        // (링크된 마스터를 지워 orphan 방지).
        tx.rollback().await?;
        row = load_routine(pool, routine_id).await?;
    }

    // 정상 disable: google_event_id Some(원래 동기화 중이었거나, 위에서 워커가 막 link함).
    let (Some(cal_id), Some(evt_id)) =
        (row.google_calendar_id.clone(), row.google_event_id.clone())
    else {
        return Ok(()); // 방어적 — 레이스로 이미 정리된 상태.
    };

    // P5A: 미러 clear + delete 큐 행을 한 트랜잭션으로 — 미러만 clear되고 delete 큐 행이 실패하면
    // 마스터가 큐잉된 delete 없이 orphan으로 남는다(비원자 tear). clear_google_mirror는 Executor에
    // 제네릭이라 tx 커넥션을 그대로 넘긴다(정본 SQL 재사용, 다른 cfg(test) 호출부는 pool 그대로).
    let mut tx = pool.begin().await?;
    clear_google_mirror(&mut *tx, routine_id).await?;
    // delete payload는 빈 객체로 충분 — 워커 delete arm은 event_id + calendar_id만 쓴다.
    // ⚠️target을 routine_master가 아닌 **event(`cal|evt`)로 키잉**: UNIQUE(target,kind)가 routine
    // 단위면 막힌(terminal) 옛 delete 행을 다음 disable/move의 delete가 덮어 옛 마스터의 삭제
    // 의도가 소실된다(critic P4c BLOCKER — orphan). event-키면 서로 다른 마스터의 delete가 공존.
    // 미러 정리는 위에서 이미 낙관적으로 끝났으므로 워커의 unlink는 불필요(event target = no-op).
    upsert_write(
        &mut *tx,
        "delete",
        "event",
        &format!("{cal_id}|{evt_id}"),
        &cal_id,
        Some(&evt_id),
        "{}",
        GOOGLE_SYNC_DEBOUNCE_MS,
    )
    .await?;
    tx.commit().await?;
    notify.notify_one();
    Ok(())
}

/// 동기화 중인 루틴을 다른 캘린더로 이동(PR 5). Google API가 calendarId 변경 PATCH를 지원하지
/// 않아 옛 master DELETE + 새 master CREATE다(메타 손실 — 프런트가 명시 confirm). `project_id`는
/// 새 캘린더 소유 프로젝트(routine.kind와 같은 kind). 옛 이벤트는 옛 프로젝트 토큰으로, 새 이벤트는
/// 새 프로젝트 토큰으로 호출한다(같은 프로젝트면 같은 토큰).
#[tauri::command]
#[specta::specta]
pub async fn move_routine_google_sync(
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
    routine_id: String,
    project_id: String,
    calendar_id: String,
) -> Result<(), AppError> {
    move_routine_google_sync_inner(
        db.inner(),
        notify.inner(),
        &routine_id,
        &project_id,
        &calendar_id,
    )
    .await
}

/// move IPC의 테스트 가능한 코어(provider/토큰 조회 없음). P4c: 인라인 DELETE+CREATE 대신 **2개의
/// 독립 지연 큐 행**으로 — old-master delete(@옛 캘린더) + new-master create(@새 캘린더). 워커가 행마다
/// `calendar_id → project → access_token`을 해석하므로(sync.rs `build_calendar_to_project_map` +
/// `access_token_cached`) delete는 옛 캘린더 토큰, create는 새 캘린더 토큰으로 나간다 — 인라인 경로가
/// 명시적으로 넘기던 old_access/new_access를 큐가 대신 해소한다. 실행·재시도·일관성은 큐 소유.
///
/// 순서 안전: 낙관적 미러는 pending-enable 모양(cal_new set, evt NULL)이라 disable의 취소 CAS와
/// 워커 create arm의 relink CAS(둘 다 P4a)가 그대로 move의 레이스를 커버한다. 옛 마스터 delete 행은
/// 조건부 unlink(`AND google_event_id = ?evt`, P4b A4)라 늦게 flush돼도 더 새 link(evt_new)를 null하지
/// 않는다 — 두 행이 어느 순서로 flush돼도 최종 미러는 (cal_new, evt_new)로 수렴한다.
///
/// INVARIANT #2: 루틴 이동 IPC는 사람이 명시 confirm하는 액션이다(프런트가 호출 전 확인 다이얼로그를
/// 띄운다) — 즉시 실행하던 인라인 경로와 동일한 acceptance 시맨틱이므로, 직접 enqueue가 기존 승인
/// 의미를 보존한다. staged=true 2차 게이트를 추가하지 않는다(시그널 MoveCalendar staging은 별개의
/// 2-step UI 플로우).
pub(crate) async fn move_routine_google_sync_inner(
    pool: &Db,
    notify: &Arc<Notify>,
    routine_id: &str,
    new_project_id: &str,
    new_calendar_id: &str,
) -> Result<(), AppError> {
    let row = load_routine(pool, routine_id).await?;
    // 미동기화(pending-enable 윈도우 포함: event_id NULL)는 이동 불가 — 먼저 동기화를 켜야 한다.
    if row.google_event_id.is_none() {
        return Err(AppError::validation(
            "routine.sync.not_synced",
            "동기화되지 않은 루틴은 이동할 수 없습니다 — 먼저 동기화를 켜세요",
        ));
    }
    // 현재 동기화 중인 바로 그 캘린더로의 이동 = 무의미한 DELETE+CREATE — no-op(Ok).
    if row.google_calendar_id.as_deref() == Some(new_calendar_id) {
        return Ok(());
    }
    // 옛 master를 지우기 전에 새 매핑을 검증(kind 일치 + 시간 지정) — 인라인 파괴-전 가드 패리티.
    ensure_kind_and_time(pool, &row, new_project_id).await?;

    // sync-pair invariant: event_id Some이면 calendar_id도 Some. 방어적 else는 도달 불가.
    let (Some(cal_o), Some(evt_o)) = (row.google_calendar_id.clone(), row.google_event_id.clone())
    else {
        return Ok(());
    };

    // 새 마스터 payload를 **파괴적 단계 전에** 조립(fail-fast) — 빌더/검증 에러(empty_window 등)는
    // enqueue·미러 UPDATE 전에 동기로 surface해 옛 master가 손상되지 않게 한다(인라인 "옛 master를
    // 지우기 전에 새 매핑을 검증" 규율). build_master_event_input은 미러 컬럼을 읽지 않으므로 현재
    // row 기준으로 안전하게 만들 수 있다.
    let input = build_master_event_input(pool, routine_id, &row, default_tzid()).await?;
    let payload = master_create_payload(&input)?;

    // P5A: 옛 delete 행 + 낙관적 미러 UPDATE + 새 create 행을 **한 트랜잭션**으로 원자화한다.
    // 최악의 tear(비원자): delete 큐잉 + 미러 repoint까지 됐는데 create-upsert가 실패하면 루틴이
    // (new_cal, evt NULL, 큐잉된 create 없음)으로 stranded된다 — 워커가 새 마스터를 만들 근거가
    // 사라진다. SQLite 단일 writer라 tx는 한 단위로 직렬화되고(양측 CAS 모델 강화), 문장 순서는
    // 그대로 유지한다(래핑만). 읽기/검증은 위에서 pool로 끝냈고, notify는 commit 후에만.
    let mut tx = pool.begin().await?;
    // 옛 마스터 delete 행(@옛 캘린더, 옛 이벤트) — 워커가 옛 캘린더 토큰으로 삭제.
    // event-키(`cal|evt`)로 enqueue: routine 단위 UNIQUE면 막힌 옛 delete 행을 이 delete가 덮어
    // 옛 마스터가 orphan이 된다(critic P4c BLOCKER). event-키면 마스터별 delete가 공존.
    upsert_write(
        &mut *tx,
        "delete",
        "event",
        &format!("{cal_o}|{evt_o}"),
        &cal_o,
        Some(&evt_o),
        "{}",
        GOOGLE_SYNC_DEBOUNCE_MS,
    )
    .await?;
    // 낙관적 미러: project/cal은 새 값으로, event_id는 NULL(pending-enable-shaped) — 워커 create arm이
    // flush 시 relink한다. disable의 취소 CAS·워커 relink CAS가 이 모양을 그대로 커버.
    sqlx::query(
        "UPDATE routines SET project_id = ?1, google_calendar_id = ?2, google_event_id = NULL \
         WHERE id = ?3",
    )
    .bind(new_project_id)
    .bind(new_calendar_id)
    .bind(routine_id)
    .execute(&mut *tx)
    .await?;
    // 새 마스터 create 행(@새 캘린더) — 워커가 새 캘린더 토큰으로 생성·링크백.
    upsert_write(
        &mut *tx,
        "create",
        "routine_master",
        routine_id,
        new_calendar_id,
        None,
        &payload,
        GOOGLE_SYNC_DEBOUNCE_MS,
    )
    .await?;
    tx.commit().await?;
    notify.notify_one();
    Ok(())
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
/// 단, stale mirror sweep(`routine.sync.expired`)은 마스킹하지 않고 그대로 통과 —
/// "다시 켜세요" 재연결 안내가 토스트에 닿아야 한다.
fn exdate_patch_failed(e: AppError) -> AppError {
    if e.code == SYNC_EXPIRED_CODE {
        return e;
    }
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
/// 프로덕션 IPC 진입점(`unschedule_routine_today`)은 `patch_synced_routine_exdates`를 호출해
/// master patch를 **큐로 enqueue**한다(P4b — 토큰/provider 조회 없음). 이 wrapper는 provider
/// 주입이 가능한 인라인 패리티 테스트 경로 전용이다.
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
    notify: State<'_, Arc<Notify>>,
    routine_id: String,
    date: String,
) -> Result<(), AppError> {
    validate_ymd(&date)?;
    // 존재 확인(깔끔한 not_found) — 이후 FK 위반 대신 명확한 에러.
    load_routine(db.inner(), &routine_id).await?;
    insert_exdate_row(db.inner(), &routine_id, &date).await?;
    patch_synced_routine_exdates(db.inner(), notify.inner(), &routine_id)
        .await
        .map_err(exdate_patch_failed)
}

/// "오늘 빼기" 되돌리기 — routine_exdates skip 행 삭제 + 동기화 ON이면 master EXDATE 제거 PATCH.
#[tauri::command]
#[specta::specta]
pub async fn restore_routine_today(
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
    routine_id: String,
    date: String,
) -> Result<(), AppError> {
    validate_ymd(&date)?;
    load_routine(db.inner(), &routine_id).await?;
    delete_exdate_row(db.inner(), &routine_id, &date).await?;
    patch_synced_routine_exdates(db.inner(), notify.inner(), &routine_id)
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
    use std::sync::{Arc, Mutex};
    use tokio::sync::Notify;

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
                start_date: None,
                end_date: None,
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

    /// patch: Google master가 외부에서 삭제됨(404 NotFound) → mirror를 NULL로 sweep + expired surface.
    /// ADR-0005 reactive 경로. NULL out 없이 두면 이후 편집·"오늘 빼기"가 영구 실패한다(stale lock).
    #[tokio::test]
    async fn patch_404_sweeps_mirror_and_surfaces_expired() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "사라진 일정",
            RoutineFreq::Weekly,
            vec![MWeekday::Tue],
            Some("09:00".into()),
            Some(Kind::Work),
        )
        .await;
        mark_synced(&db, &rid, "cal_gone", "evt_gone").await;

        let provider = RecordingProvider::default();
        *provider.patch_result.lock().unwrap() =
            Err(CalendarError::NotFound("HTTP 404 (응답 0B)".into()));

        let err = patch_routine_sync_with_provider(&db, &provider, "tok", &rid, "Asia/Seoul")
            .await
            .expect_err("404 → expired");
        assert_eq!(err.code, SYNC_EXPIRED_CODE, "stale mirror → sync 만료 코드");

        // reactive sweep: mirror 양 컬럼이 NULL이어야 stale lock이 풀린다.
        let row = load_routine(&db, &rid).await.unwrap();
        assert!(row.google_event_id.is_none(), "google_event_id NULL out");
        assert!(
            row.google_calendar_id.is_none(),
            "google_calendar_id NULL out"
        );
    }

    /// 일반 PATCH 실패(Terminal)는 mirror를 건드리지 않고 전파(stale lock 아님 — 재시도 가능 상태 유지).
    #[tokio::test]
    async fn patch_terminal_failure_keeps_mirror() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "일시 실패",
            RoutineFreq::Weekly,
            vec![MWeekday::Wed],
            Some("09:00".into()),
            Some(Kind::Work),
        )
        .await;
        mark_synced(&db, &rid, "cal_keep", "evt_keep").await;

        let provider = RecordingProvider::default();
        *provider.patch_result.lock().unwrap() = Err(CalendarError::Terminal("boom".into()));

        patch_routine_sync_with_provider(&db, &provider, "tok", &rid, "Asia/Seoul")
            .await
            .expect_err("Terminal 전파");
        let row = load_routine(&db, &rid).await.unwrap();
        assert_eq!(
            row.google_event_id.as_deref(),
            Some("evt_keep"),
            "Terminal 실패는 mirror 유지"
        );
    }

    /// exdate_patch_failed wrapper: expired는 그대로 통과(재연결 안내 보존), 그 외는 평탄화.
    #[test]
    fn exdate_patch_failed_passes_through_expired() {
        let passed = exdate_patch_failed(sync_expired());
        assert_eq!(
            passed.code, SYNC_EXPIRED_CODE,
            "expired는 마스킹되지 않고 통과"
        );

        let wrapped = exdate_patch_failed(AppError::terminal("calendar.terminal", "boom"));
        assert_eq!(
            wrapped.code, "routine.sync.exdate_patch_failed",
            "그 외는 평탄화"
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
                start_date: None,
                end_date: None,
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

    /// synced routine edit: past Google instances are preserved by capping the old master before
    /// the edit date and creating a new master for edited future instances.
    #[tokio::test]
    async fn edit_splits_synced_master_from_effective_date() {
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
        sqlx::query("UPDATE routines SET created_at = '2026-05-29 00:00:00' WHERE id = ?1")
            .bind(&rid)
            .execute(&db)
            .await
            .unwrap();
        mark_synced(&db, &rid, "cal_g", "evt_old").await;
        let before = routine_edit_sync_snapshot(&db, &rid)
            .await
            .unwrap()
            .expect("synced snapshot");

        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: rid.clone(),
                title: "헬스장 새 시간".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                start_date: None,
                end_date: None,
                time_of_day: Some("08:00".into()),
                reminder_offset_min: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: Some(45),
            },
        )
        .await
        .unwrap();

        let provider = RecordingProvider::with_create_id("evt_new");
        split_routine_sync_after_edit_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            before,
            "2026-06-09",
            "Asia/Seoul",
        )
        .await
        .unwrap();

        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1, "old master is capped once");
        assert_eq!(patched[0].1, "cal_g");
        assert_eq!(patched[0].2, "evt_old");
        let old_rec = patched[0].3["recurrence"][0].as_str().unwrap();
        // 07:00 KST(2026-06-08) = 22:00 UTC(2026-06-07). UNTIL은 UTC(`...Z`)라야 Google이 수용.
        assert!(
            old_rec.contains("UNTIL=20260607T220000Z"),
            "old master ends before effective date at the old routine time, in UTC: {old_rec}"
        );
        assert_eq!(
            patched[0].3["start"]["dateTime"], "2026-05-29T07:00:00",
            "old master keeps the previous DTSTART"
        );

        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1, "new future master is created once");
        assert_eq!(created[0].1, "cal_g");
        assert_eq!(created[0].2.title, "헬스장 새 시간");
        assert_eq!(created[0].2.start, "2026-06-09T08:00:00");
        assert_eq!(created[0].2.end, "2026-06-09T08:45:00");

        let row = load_routine(&db, &rid).await.unwrap();
        assert_eq!(row.google_event_id.as_deref(), Some("evt_new"));
        assert_eq!(row.google_calendar_id.as_deref(), Some("cal_g"));
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

    /// move: 현재 동기화 중인 바로 그 캘린더로 이동 = 무의미한 round-trip → no-op(Ok).
    /// 같은 물리 캘린더가 두 프로젝트의 후보로 중복될 때 발생 가능 — DELETE+CREATE round-trip을
    /// 권위 계층(백엔드)에서 차단한다(프런트 dedup/`c.id !=` 필터는 happy-path 가드일 뿐).
    /// 메타 손실·CREATE 실패 시 이벤트 유실 위험이 있는 파괴적 op이므로 provider 미호출이어야 한다.
    #[tokio::test]
    async fn move_to_same_calendar_is_noop() {
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
            "UPDATE routines SET project_id='proj_personal', google_calendar_id='cal_same', \
             google_event_id='evt_same' WHERE id=?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let provider = RecordingProvider::with_create_id("evt_should_not_create");
        move_routine_sync_with_provider(
            &db,
            &provider,
            "tok_old",
            "tok_new",
            &rid,
            "proj_personal",
            "cal_same", // 현재 동기화 캘린더와 동일
            "Asia/Seoul",
        )
        .await
        .unwrap();

        // 파괴적 round-trip 미발생: DELETE/CREATE 둘 다 미호출.
        assert!(
            provider.deleted.lock().unwrap().is_empty(),
            "같은 캘린더로 이동은 DELETE 미호출(round-trip 차단)"
        );
        assert!(
            provider.created.lock().unwrap().is_empty(),
            "같은 캘린더로 이동은 CREATE 미호출"
        );
        // mirror 불변(같은 캘린더/이벤트 그대로 동기화).
        assert!(assert_pair_consistent(&db, &rid).await);
        let (cal, evt): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT google_calendar_id, google_event_id FROM routines WHERE id=?1")
                .bind(&rid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(cal.as_deref(), Some("cal_same"));
        assert_eq!(
            evt.as_deref(),
            Some("evt_same"),
            "이벤트 ID 보존(재생성 안 함)"
        );
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

    /// 활성 구간(0061) 동기화: start_date → DTSTART floor, end_date → RRULE UNTIL (daily).
    #[tokio::test]
    async fn enable_with_window_maps_dtstart_and_until() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "분기 챌린지",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        sqlx::query(
            "UPDATE routines SET start_date = '2026-06-10', end_date = '2026-06-30' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();
        let provider = RecordingProvider::with_create_id("evt_win");

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
        let input = &created[0].2;
        // DTSTART floor = start_date 이후 첫 발생(daily=start 당일).
        assert_eq!(input.start, "2026-06-10T07:00:00");
        // RRULE에 UNTIL=end_date 부착(UTC). 07:00 KST(6/30) = 22:00 UTC(6/29).
        let rrule = input
            .recurrence
            .iter()
            .find(|l| l.starts_with("RRULE:"))
            .unwrap();
        assert_eq!(rrule, "RRULE:FREQ=DAILY;UNTIL=20260629T220000Z");
    }

    /// 활성 구간에 반복 발생이 없으면(weekly 월요일인데 구간에 월요일 없음) empty_window 거부 — provider 미호출.
    #[tokio::test]
    async fn enable_with_window_no_occurrence_errors() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "주간 회의",
            RoutineFreq::Weekly,
            vec![MWeekday::Mon],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // 2026-06-09(화)~06-14(일) 구간엔 월요일이 없다(이전 월=6/8, 다음 월=6/15).
        sqlx::query(
            "UPDATE routines SET start_date = '2026-06-09', end_date = '2026-06-14' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();
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
        assert_eq!(err.code, "routine.sync.empty_window");
        assert!(
            provider.created.lock().unwrap().is_empty(),
            "빈 구간은 create_event 미호출"
        );
    }

    /// 회귀(critic Finding #1): start_date 없이 end_date만 있고 그 end가 DTSTART(created_at)보다
    /// 과거면 'DTSTART > UNTIL' 깨진 RRULE 대신 empty_window로 거부 — provider 미호출.
    #[tokio::test]
    async fn enable_with_past_end_only_errors_empty_window() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "만료",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // created_at은 test 실행 시각(>=2026). end_date를 명백히 과거로, start_date는 None.
        sqlx::query("UPDATE routines SET end_date = '2020-12-31' WHERE id = ?1")
            .bind(&rid)
            .execute(&db)
            .await
            .unwrap();
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
        assert_eq!(err.code, "routine.sync.empty_window");
        assert!(provider.created.lock().unwrap().is_empty());
    }

    /// 활성 구간 + 편집 series-split 합성: old master는 effective-1로 cap(window UNTIL을 덮어씀),
    /// new master는 DTSTART=max(start, effective) + end_date UNTIL을 싣는다.
    #[tokio::test]
    async fn edit_split_composes_with_active_window() {
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
        sqlx::query(
            "UPDATE routines SET created_at = '2026-05-29 00:00:00', start_date = '2026-05-29', \
             end_date = '2026-12-31' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();
        mark_synced(&db, &rid, "cal_g", "evt_old").await;
        let before = routine_edit_sync_snapshot(&db, &rid)
            .await
            .unwrap()
            .expect("synced snapshot");

        let provider = RecordingProvider::with_create_id("evt_new");
        split_routine_sync_after_edit_with_provider(
            &db,
            &provider,
            "tok",
            &rid,
            before,
            "2026-06-09",
            "Asia/Seoul",
        )
        .await
        .unwrap();

        // old master: DTSTART=구간 시작(5/29), UNTIL=effective-1(6/8 07:00 KST = 6/7 22:00 UTC) —
        // cap이 window UNTIL을 덮어씀.
        let patched = provider.patched.lock().unwrap().clone();
        assert_eq!(patched.len(), 1);
        let old_rec = patched[0].3["recurrence"][0].as_str().unwrap();
        assert!(
            old_rec.contains("UNTIL=20260607T220000Z"),
            "old master capped at effective-1 (UTC): {old_rec}"
        );
        assert_eq!(patched[0].3["start"]["dateTime"], "2026-05-29T07:00:00");

        // new master: DTSTART=max(start, effective)=6/9, UNTIL=end_date(12/31 07:00 KST = 12/30 22:00 UTC).
        let created = provider.created.lock().unwrap().clone();
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].2.start, "2026-06-09T07:00:00");
        let new_rec = created[0]
            .2
            .recurrence
            .iter()
            .find(|l| l.starts_with("RRULE:"))
            .unwrap();
        assert!(
            new_rec.contains("UNTIL=20261230T220000Z"),
            "new master carries end_date UNTIL (UTC): {new_rec}"
        );
    }

    /// 회귀(critic Minor #1): biweekly + start_date → DTSTART가 parity 맞는 첫 발생(scan이 anchor
    /// 2주 parity를 보존). anchor=5/25(월), start=6/1(월이지만 parity off) → 첫 due=6/8(parity on).
    #[tokio::test]
    async fn enable_biweekly_window_dtstart_on_correct_parity() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "격주",
            RoutineFreq::Biweekly,
            vec![MWeekday::Mon],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        sqlx::query(
            "UPDATE routines SET anchor_date = '2026-05-25', start_date = '2026-06-01' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();
        let provider = RecordingProvider::with_create_id("evt_bw");
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
        assert_eq!(
            created[0].2.start, "2026-06-08T07:00:00",
            "parity off인 6/1을 건너뛰고 6/8(on)에서 시작"
        );
    }

    /// 회귀(critic Minor #1): monthly day_of_month=31 + start_date → DTSTART는 말일 클램프된 첫
    /// 발생(2월=28), 패턴은 anchor의 31 클램프(BYMONTHDAY=28,29,30,31;BYSETPOS=-1) 유지.
    #[tokio::test]
    async fn enable_monthly_31_window_dtstart_clamped() {
        let db = fresh_db().await;
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "월말",
            RoutineFreq::Monthly,
            vec![],
            Some("10:00".into()),
            Some(Kind::Personal),
        )
        .await;
        sqlx::query(
            "UPDATE routines SET anchor_date = '2026-01-31', monthly_pattern = 'day_of_month', \
             start_date = '2026-02-01' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();
        let provider = RecordingProvider::with_create_id("evt_m31");
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
        let input = &created[0].2;
        assert_eq!(
            input.start, "2026-02-28T10:00:00",
            "2월은 28일로 클램프된 첫 발생"
        );
        let rrule = input
            .recurrence
            .iter()
            .find(|l| l.starts_with("RRULE:"))
            .unwrap();
        assert!(
            rrule.contains("BYMONTHDAY=28,29,30,31") && rrule.contains("BYSETPOS=-1"),
            "패턴은 anchor의 31 클램프 유지: {rrule}"
        );
    }

    // ── P4a: enable/disable 인라인 → 지연 큐 전환 ─────────────────────────────────
    // 관측 타이밍이 sync-inline → deferred(낙관적 로컬 미러 즉시 + Google flush 나중)로 바뀐다 —
    // signal/routine_check 경로와 동일. provider/토큰 조회 없이 큐 행만 만든다.

    /// enable_inner: 미동기화 루틴 → 낙관적 로컬 미러(project_id + google_calendar_id set,
    /// google_event_id는 flush 전 NULL) + create 큐 행 1개(routine_master, recurrence+time_zone 동봉).
    #[tokio::test]
    async fn enable_inner_mirrors_locally_and_enqueues_create() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
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

        enable_routine_google_sync_inner(&db, &notify, &rid, "proj_personal", "cal_user_a")
            .await
            .unwrap();

        // 낙관적 미러: project_id + google_calendar_id set, google_event_id는 NULL(워커 link_back이 박음).
        let (proj, cal_id, evt_id): (Option<String>, Option<String>, Option<String>) =
            sqlx::query_as(
                "SELECT project_id, google_calendar_id, google_event_id FROM routines WHERE id = ?1",
            )
            .bind(&rid)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            proj.as_deref(),
            Some("proj_personal"),
            "project_id 즉시 set"
        );
        assert_eq!(cal_id.as_deref(), Some("cal_user_a"), "cal_id 즉시 set");
        assert!(evt_id.is_none(), "google_event_id는 flush 전 NULL");

        // 큐 행 1개: create / routine_master / target_id=rid, event_id NULL(create).
        let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
            "SELECT kind, target_kind, target_id, payload_json, event_id \
             FROM pending_calendar_writes",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "정확히 1개 큐 행");
        let (kind, tk, tid, payload, event_id) = &rows[0];
        assert_eq!(kind, "create");
        assert_eq!(tk, "routine_master");
        assert_eq!(tid, &rid);
        assert!(event_id.is_none(), "create 큐 행은 event_id NULL");
        assert!(
            payload.contains("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"),
            "recurrence 라인 payload 동봉: {payload}"
        );
        assert!(
            payload.contains("\"time_zone\""),
            "time_zone 필드 동봉: {payload}"
        );
    }

    /// P4a critic BLOCKER 회귀: pending ENABLE(google_event_id NULL, create 큐잉) 상태에서 disable하면
    /// pending create를 취소하고 낙관적 미러를 clear해야 한다 — 안 그러면 워커가 마스터를 만들어
    /// 사용자가 끈 동기화를 되살린다.
    #[tokio::test]
    async fn disable_inner_cancels_pending_enable() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // enable → pending create + 낙관적 미러(event_id NULL).
        enable_routine_google_sync_inner(&db, &notify, &rid, "proj_personal", "cal_user_a")
            .await
            .unwrap();
        // 워커 link_back 전에 disable.
        disable_routine_google_sync_inner(&db, &notify, &rid)
            .await
            .unwrap();

        // pending create가 취소됨(큐 비어야 함 — Google에 만든 게 없어 delete 행도 없음).
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "pending create가 취소되어 큐가 비어야 한다");
        // 낙관적 미러 clear — 미동기화 상태로 복귀.
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(cal.is_none(), "google_calendar_id NULL로 복귀");
        assert!(evt.is_none());
    }

    /// 브리지 패리티: master_create_payload가 CreateEventInput의 duration_min(end−start)·description·
    /// time_zone·recurrence를 큐 방언으로 정확히 옮긴다(필드 조용히 떨구지 않음).
    #[test]
    fn master_create_payload_carries_duration_description_tz_recurrence() {
        let input = CreateEventInput {
            title: "아침 운동".into(),
            start: "2026-05-29T07:00:00".into(),
            end: "2026-05-29T07:45:00".into(),
            all_day: false,
            description: Some("스트레칭 포함".into()),
            recurrence: vec!["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR".into()],
            time_zone: Some("Asia/Seoul".into()),
        };
        let payload = master_create_payload(&input).unwrap();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["title"], "아침 운동");
        assert_eq!(v["start"], "2026-05-29T07:00:00");
        assert_eq!(v["duration_min"], 45);
        assert_eq!(v["all_day"], false);
        assert_eq!(v["description"], "스트레칭 포함");
        assert_eq!(v["time_zone"], "Asia/Seoul");
        assert_eq!(v["recurrence"][0], "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
        // end<=start는 거부.
        let bad = CreateEventInput {
            end: "2026-05-29T07:00:00".into(),
            ..input
        };
        assert!(master_create_payload(&bad).is_err());
    }

    /// enable_inner: 이미 동기화 중(google_event_id Some)이면 already_enabled 에러 + 큐 행 0개.
    #[tokio::test]
    async fn enable_inner_rejects_already_synced_without_enqueue() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
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
        sqlx::query(
            "UPDATE routines SET google_calendar_id = 'c1', google_event_id = 'e1' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();

        let err = enable_routine_google_sync_inner(&db, &notify, &rid, "proj_personal", "c2")
            .await
            .unwrap_err();
        assert_eq!(err.code, "routine.sync.already_enabled");

        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "이미 동기화면 큐 행 없음");
    }

    /// critic P4a round-4 회귀: 워커가 CAS로 먼저 link한 상태(google_event_id Some)에서 disable가
    /// 오면, 취소가 아니라 링크된 마스터의 delete를 큐잉해야 한다 — 그래야 Google 마스터가 orphan으로
    /// 남지 않는다(양측 CAS의 fall-through 타깃). stale한 create 행이 남아 있어도 delete가 큐잉된다.
    #[tokio::test]
    async fn disable_inner_enqueues_delete_when_worker_already_linked() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // 워커가 이미 link함: google_event_id Some + google_calendar_id Some.
        sqlx::query(
            "UPDATE routines SET google_calendar_id = 'cal_a', google_event_id = 'evt_linked' WHERE id = ?1",
        )
        .bind(&rid)
        .execute(&db)
        .await
        .unwrap();
        // stale한 pending create가 남아 있음(워커가 fetch 후 아직 제거 전인 상황 모사).
        upsert_write(
            &db,
            "create",
            "routine_master",
            &rid,
            "cal_a",
            None,
            "{}",
            0,
        )
        .await
        .unwrap();

        disable_routine_google_sync_inner(&db, &notify, &rid)
            .await
            .unwrap();

        // 미러 clear.
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(cal.is_none());
        assert!(evt.is_none());
        // 링크된 마스터의 delete가 큐잉됨(orphan 방지) — 취소로 no-op 되면 안 됨.
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM pending_calendar_writes \
             WHERE kind = 'delete' AND target_kind = 'event' AND event_id = 'evt_linked'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(n, 1, "링크된 마스터의 delete가 큐잉돼야 한다");
    }

    /// disable_inner: 동기화된 루틴 → 미러 clear(google_event_id/google_calendar_id NULL) +
    /// delete 큐 행 1개(routine_master, event_id=옛 마스터 id).
    #[tokio::test]
    async fn disable_inner_clears_mirror_and_enqueues_delete() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        let rid = seed_routine(
            &db,
            "PT",
            RoutineFreq::Weekly,
            vec![MWeekday::Tue],
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

        disable_routine_google_sync_inner(&db, &notify, &rid)
            .await
            .unwrap();

        // 미러 clear (clear_google_mirror와 동일 컬럼 집합).
        let (cal_id, evt_id): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(cal_id.is_none() && evt_id.is_none(), "미러 즉시 NULL");

        let rows: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT kind, target_kind, target_id, event_id, calendar_id \
             FROM pending_calendar_writes",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "정확히 1개 큐 행");
        let (kind, tk, tid, event_id, cal) = &rows[0];
        assert_eq!(kind, "delete");
        // event-키(`cal|evt`) — routine 단위 UNIQUE가 옛 delete 행을 덮어 orphan을 만들지 않게(P4c).
        assert_eq!(tk, "event");
        assert_eq!(tid, "cal_x|evt_x");
        assert_eq!(
            event_id.as_deref(),
            Some("evt_x"),
            "옛 마스터 event_id 실림"
        );
        assert_eq!(cal, "cal_x");
    }

    /// disable_inner: 미동기화 루틴이면 Ok no-op + 큐 행 0개(토큰 조회·큐 없음).
    #[tokio::test]
    async fn disable_inner_noop_when_not_synced() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        let rid = seed_routine(
            &db,
            "스트레칭",
            RoutineFreq::Daily,
            vec![],
            None,
            Some(Kind::Personal),
        )
        .await;

        disable_routine_google_sync_inner(&db, &notify, &rid)
            .await
            .unwrap();

        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "미동기화면 큐 행 없음");
    }

    /// critic P4a round-5 회귀: pending ENABLE(google_calendar_id Some, google_event_id NULL) 중
    /// 루틴 삭제 정리(delete_routine_master_event)는 pending create를 취소하고 google_calendar_id를
    /// NULL로 만들어야 한다 — 그래야 워커 create arm CAS가 orphan 마스터를 삭제한다.
    #[tokio::test]
    async fn delete_master_event_cancels_pending_enable() {
        let db = fresh_db().await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // pending enable 상태.
        sqlx::query("UPDATE routines SET google_calendar_id = 'cal_a' WHERE id = ?1")
            .bind(&rid)
            .execute(&db)
            .await
            .unwrap();
        upsert_write(
            &db,
            "create",
            "routine_master",
            &rid,
            "cal_a",
            None,
            "{}",
            0,
        )
        .await
        .unwrap();

        delete_routine_master_event(&db, &rid).await.unwrap();

        // pending create 취소 + google_calendar_id NULL(워커 CAS가 orphan 처리하도록).
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "pending create가 취소돼야 한다");
        let (cal,): (Option<String>,) =
            sqlx::query_as("SELECT google_calendar_id FROM routines WHERE id = ?1")
                .bind(&rid)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(
            cal.is_none(),
            "google_calendar_id NULL → 워커 CAS가 orphan 삭제"
        );
    }

    // ── P4b B2/B3: split/exdate 인라인 → enqueue 전환 ─────────────────────────────

    /// B2 split(synced): provider/토큰 조회 없이 series_replace 큐 행 1개를 만든다. payload는
    /// old_event_id==옛 마스터, old_patch에 capped RRULE(UNTIL 포함), new_create에 post-edit
    /// recurrence + time_zone.
    #[tokio::test]
    async fn after_edit_synced_enqueues_series_replace() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        sqlx::query("UPDATE routines SET created_at = '2026-05-29 00:00:00' WHERE id = ?1")
            .bind(&rid)
            .execute(&db)
            .await
            .unwrap();
        mark_synced(&db, &rid, "cal_g", "evt_old").await;
        let before = routine_edit_sync_snapshot(&db, &rid)
            .await
            .unwrap()
            .expect("synced snapshot");
        // 편집: daily → weekly(월).
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: rid.clone(),
                title: "헬스장".into(),
                freq: RoutineFreq::Weekly,
                weekdays: vec![MWeekday::Mon],
                anchor_date: None,
                start_date: None,
                end_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        patch_synced_routine_after_edit(&db, &notify, &rid, Some(before), "2026-06-09")
            .await
            .unwrap();

        let rows: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT kind, target_kind, target_id, event_id, payload_json \
             FROM pending_calendar_writes",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "series_replace 큐 행 1개");
        let (kind, tk, tid, event_id, payload) = &rows[0];
        assert_eq!(kind, "series_replace");
        assert_eq!(tk, "routine_master");
        assert_eq!(tid, &rid);
        assert!(
            event_id.is_none(),
            "series_replace create 절반은 event_id NULL"
        );
        let v: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(v["old_event_id"], "evt_old");
        let old_rec = v["old_patch"]["recurrence"][0].as_str().unwrap();
        assert!(
            old_rec.contains("UNTIL="),
            "old_patch capped RRULE: {old_rec}"
        );
        let new_rec = v["new_create"]["recurrence"][0].as_str().unwrap();
        assert!(
            new_rec.contains("FREQ=WEEKLY") && new_rec.contains("BYDAY=MO"),
            "new_create가 post-edit weekly 반영: {new_rec}"
        );
        assert!(
            v["new_create"]["time_zone"].as_str().is_some(),
            "new_create에 time_zone 동봉"
        );
    }

    /// B2 split(pending-ENABLE): 큐잉된 create payload가 편집을 반영해 refresh되고(UPDATE) series_replace
    /// 행은 생기지 않는다. 큐 행 수는 그대로 1(create).
    #[tokio::test]
    async fn after_edit_pending_enable_refreshes_create_payload() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_personal", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // enable → pending create + 낙관적 미러(cal Some, evt NULL).
        enable_routine_google_sync_inner(&db, &notify, &rid, "proj_personal", "cal_user_a")
            .await
            .unwrap();
        let before = routine_edit_sync_snapshot(&db, &rid)
            .await
            .unwrap()
            .expect("pending-enable snapshot");
        // 편집: 시간 07:00 → 09:00.
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: rid.clone(),
                title: "아침 운동".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                start_date: None,
                end_date: None,
                time_of_day: Some("09:00".into()),
                reminder_offset_min: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        patch_synced_routine_after_edit(&db, &notify, &rid, Some(before), "2026-06-09")
            .await
            .unwrap();

        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT kind, payload_json FROM pending_calendar_writes")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(
            rows.len(),
            1,
            "여전히 1개 큐 행(create refresh, series_replace 없음)"
        );
        assert_eq!(rows[0].0, "create", "kind는 create 유지");
        assert!(
            rows[0].1.contains("09:00:00"),
            "refresh된 create payload가 편집(09:00)을 반영: {}",
            rows[0].1
        );
    }

    /// B2 split(미동기화): before None → 큐 행 0개.
    #[tokio::test]
    async fn after_edit_unsynced_no_rows() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        let rid = seed_routine(
            &db,
            "물 마시기",
            RoutineFreq::Daily,
            vec![],
            None,
            Some(Kind::Personal),
        )
        .await;
        let before = routine_edit_sync_snapshot(&db, &rid).await.unwrap();
        assert!(before.is_none(), "미동기화 → 스냅샷 None");
        patch_synced_routine_after_edit(&db, &notify, &rid, before, "2026-06-09")
            .await
            .unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "미동기화 편집은 큐 행 없음");
    }

    /// B3 exdate(synced): patch 큐 행 1개(kind=patch, event_id=master) — payload recurrence에 EXDATE
    /// 라인 + title/start/duration_min/time_zone 동봉(build_patch_body가 소비하는 형태).
    #[tokio::test]
    async fn exdates_synced_enqueues_patch_row() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
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
        insert_exdate_row(&db, &rid, "2026-06-08").await.unwrap();

        patch_synced_routine_exdates(&db, &notify, &rid)
            .await
            .unwrap();

        let rows: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT kind, target_kind, target_id, event_id, payload_json \
             FROM pending_calendar_writes",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "patch 큐 행 1개");
        let (kind, tk, tid, event_id, payload) = &rows[0];
        assert_eq!(kind, "patch");
        assert_eq!(tk, "routine_master");
        assert_eq!(tid, &rid);
        assert_eq!(event_id.as_deref(), Some("evt_w"), "event_id=현재 마스터");
        let v: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(v["title"], "주간 회의");
        assert!(v["start"].as_str().unwrap().ends_with("T10:00:00"));
        assert!(v["duration_min"].as_i64().is_some());
        assert!(v["time_zone"].as_str().is_some());
        let rec = v["recurrence"].as_array().expect("recurrence array");
        assert!(
            rec.iter()
                .any(|l| l.as_str().map(|s| s.contains("EXDATE")).unwrap_or(false)),
            "recurrence에 EXDATE 라인 동봉: {payload}"
        );
    }

    /// B3 exdate(미동기화): 큐 행 0개(no-op).
    #[tokio::test]
    async fn exdates_unsynced_no_rows() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        let rid = seed_routine(
            &db,
            "스트레칭",
            RoutineFreq::Daily,
            vec![],
            None,
            Some(Kind::Personal),
        )
        .await;
        insert_exdate_row(&db, &rid, "2026-06-08").await.unwrap();
        patch_synced_routine_exdates(&db, &notify, &rid)
            .await
            .unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "미동기화 exdate는 큐 행 없음");
    }

    // ── P4c: move 인라인 → 2-행 enqueue(delete@old_cal + create@new_cal) ────────────

    /// 동기화 루틴 세팅 헬퍼(project_id + cal + evt 동시 set) — move 테스트 공용.
    async fn mark_synced_with_project(
        db: &crate::db::Db,
        rid: &str,
        project: &str,
        cal: &str,
        evt: &str,
    ) {
        sqlx::query(
            "UPDATE routines SET project_id = ?2, google_calendar_id = ?3, google_event_id = ?4 \
             WHERE id = ?1",
        )
        .bind(rid)
        .bind(project)
        .bind(cal)
        .bind(evt)
        .execute(db)
        .await
        .unwrap();
    }

    /// move_inner: 동기화 루틴을 다른 캘린더/프로젝트로 → 낙관적 미러(project B, cal_new, evt NULL) +
    /// 정확히 2개 큐 행(delete@old_cal(evt_old) + create@new_cal(recurrence+time_zone 동봉)).
    #[tokio::test]
    async fn move_inner_enqueues_delete_and_create_rows() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_a", "personal").await;
        seed_project(&db, "proj_b", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Weekly,
            vec![MWeekday::Mon, MWeekday::Wed, MWeekday::Fri],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced_with_project(&db, &rid, "proj_a", "cal_old", "evt_old").await;

        move_routine_google_sync_inner(&db, &notify, &rid, "proj_b", "cal_new")
            .await
            .unwrap();

        // 낙관적 미러: project B, cal_new, evt NULL(pending-enable-shaped).
        let (proj, cal, evt): (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT project_id, google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            proj.as_deref(),
            Some("proj_b"),
            "project_id를 새 프로젝트로"
        );
        assert_eq!(cal.as_deref(), Some("cal_new"), "cal_id 즉시 새 캘린더");
        assert!(evt.is_none(), "google_event_id는 flush 전 NULL");

        // 정확히 2개 큐 행: delete(old) + create(new).
        let rows: Vec<(String, String, String, Option<String>, String, String)> = sqlx::query_as(
            "SELECT kind, target_kind, target_id, event_id, calendar_id, payload_json \
             FROM pending_calendar_writes ORDER BY kind",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2, "정확히 2개 큐 행(delete + create)");

        let create = rows.iter().find(|r| r.0 == "create").expect("create 행");
        assert_eq!(create.1, "routine_master");
        assert_eq!(&create.2, &rid);
        assert!(create.3.is_none(), "create 행은 event_id NULL");
        assert_eq!(create.4, "cal_new", "create는 새 캘린더");
        assert!(
            create.5.contains("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR"),
            "create payload recurrence 동봉: {}",
            create.5
        );
        assert!(
            create.5.contains("\"time_zone\""),
            "create payload time_zone 동봉: {}",
            create.5
        );

        let delete = rows.iter().find(|r| r.0 == "delete").expect("delete 행");
        // event-키(`cal|evt`) — 마스터별 delete 공존(막힌 옛 delete를 덮지 않음, P4c critic BLOCKER).
        assert_eq!(delete.1, "event");
        assert_eq!(delete.2, "cal_old|evt_old");
        assert_eq!(
            delete.3.as_deref(),
            Some("evt_old"),
            "delete는 옛 마스터 id"
        );
        assert_eq!(delete.4, "cal_old", "delete는 옛 캘린더");
    }

    /// P4c critic BLOCKER 회귀: 막힌(예: terminal) **옛 마스터의 delete 행**이 남아 있는 상태에서
    /// move하면, 새 delete가 옛 행을 **덮지 않고 공존**해야 한다 — routine 단위 UNIQUE 키였다면
    /// upsert 머지로 옛 마스터(evt1)의 삭제 의도가 소실돼 영구 orphan이 된다. event-키(`cal|evt`)가
    /// 이를 구조적으로 차단하는지 pin.
    #[tokio::test]
    async fn move_inner_coexists_with_stuck_older_delete_row() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_a", "personal").await;
        seed_project(&db, "proj_b", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Weekly,
            vec![MWeekday::Mon],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        // 이전 disable이 남긴 막힌 delete 행(evt1@calA) — 아직 flush 못 됨.
        upsert_write(
            &db,
            "delete",
            "event",
            "calA|evt1",
            "calA",
            Some("evt1"),
            "{}",
            0,
        )
        .await
        .unwrap();
        // 그 뒤 재-enable로 evt2@calB에 링크된 상태.
        mark_synced_with_project(&db, &rid, "proj_a", "calB", "evt2").await;

        // calC로 move.
        move_routine_google_sync_inner(&db, &notify, &rid, "proj_b", "calC")
            .await
            .unwrap();

        // 세 행 공존: 옛 delete(evt1@calA) **보존** + 새 delete(evt2@calB) + create@calC.
        let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
            "SELECT kind, target_kind, event_id FROM pending_calendar_writes ORDER BY id",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 3, "옛 delete가 덮이지 않고 3행 공존: {rows:?}");
        assert!(
            rows.iter()
                .any(|r| r.0 == "delete" && r.2.as_deref() == Some("evt1")),
            "막힌 옛 delete(evt1)가 보존돼야 한다(orphan 방지): {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|r| r.0 == "delete" && r.2.as_deref() == Some("evt2")),
            "move의 새 delete(evt2)가 큐잉돼야 한다: {rows:?}"
        );
        assert!(
            rows.iter().any(|r| r.0 == "create"),
            "새 마스터 create가 큐잉돼야 한다: {rows:?}"
        );
    }

    /// move_inner: 현재 동기화 중인 바로 그 캘린더로 이동 = no-op(Ok) — 큐 행 0개, 미러 불변.
    #[tokio::test]
    async fn move_inner_same_calendar_noop() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_a", "personal").await;
        let rid = seed_routine(
            &db,
            "헬스장",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced_with_project(&db, &rid, "proj_a", "cal_same", "evt_same").await;

        move_routine_google_sync_inner(&db, &notify, &rid, "proj_a", "cal_same")
            .await
            .unwrap();

        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "같은 캘린더 이동은 큐 행 없음");
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(cal.as_deref(), Some("cal_same"), "미러 불변");
        assert_eq!(evt.as_deref(), Some("evt_same"), "이벤트 ID 보존");
    }

    /// move_inner: 미동기화 루틴(pending-enable 포함 — event_id NULL)은 not_synced로 거부, 큐 행 0개.
    #[tokio::test]
    async fn move_inner_not_synced_rejected() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_a", "personal").await;
        let rid = seed_routine(
            &db,
            "비타민",
            RoutineFreq::Daily,
            vec![],
            Some("09:00".into()),
            Some(Kind::Personal),
        )
        .await;

        let err = move_routine_google_sync_inner(&db, &notify, &rid, "proj_a", "cal_new")
            .await
            .unwrap_err();
        assert_eq!(err.code, "routine.sync.not_synced");

        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "미동기화 move는 큐 행 없음");
    }

    /// move_inner: 새 프로젝트 kind 불일치 → ensure_kind_and_time 실패로 파괴 전 거부. 큐 행 0개 +
    /// 미러 불변(옛 캘린더 그대로 sync — fail-fast).
    #[tokio::test]
    async fn move_inner_kind_mismatch_enqueues_nothing() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
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
        mark_synced_with_project(&db, &rid, "proj_old", "cal_old", "evt_old").await;

        let err = move_routine_google_sync_inner(&db, &notify, &rid, "proj_work", "cal_new")
            .await
            .unwrap_err();
        assert_eq!(err.code, "routine.sync.kind_mismatch");

        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pending_calendar_writes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0, "kind 불일치는 파괴 전 거부 — 큐 행 없음");
        // 미러 불변(여전히 옛 캘린더 동기화).
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(cal.as_deref(), Some("cal_old"), "미러 불변");
        assert_eq!(evt.as_deref(), Some("evt_old"));
    }

    /// move enqueue 후(미러 = cal_new, evt NULL) disable → 취소 CAS가 이겨 create 행을 제거하고 미러를
    /// 완전 NULL로. 옛 마스터 delete 행은 그대로 큐에 남아 결국 "완전 비활성 + 옛 마스터 삭제 예약"으로
    /// 수렴한다(양측 CAS가 move의 pending-enable-shaped 상태를 그대로 커버).
    #[tokio::test]
    async fn disable_during_pending_move_cancels_create_keeps_old_delete() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        seed_project(&db, "proj_a", "personal").await;
        seed_project(&db, "proj_b", "personal").await;
        let rid = seed_routine(
            &db,
            "아침 운동",
            RoutineFreq::Daily,
            vec![],
            Some("07:00".into()),
            Some(Kind::Personal),
        )
        .await;
        mark_synced_with_project(&db, &rid, "proj_a", "cal_old", "evt_old").await;

        move_routine_google_sync_inner(&db, &notify, &rid, "proj_b", "cal_new")
            .await
            .unwrap();
        // 미러 = cal_new, evt NULL(pending-enable-shaped).
        disable_routine_google_sync_inner(&db, &notify, &rid)
            .await
            .unwrap();

        // 미러 완전 NULL.
        let (cal, evt): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT google_calendar_id, google_event_id FROM routines WHERE id = ?1",
        )
        .bind(&rid)
        .fetch_one(&db)
        .await
        .unwrap();
        assert!(cal.is_none() && evt.is_none(), "disable가 미러 완전 clear");

        // 큐: create 행은 삭제, 옛 마스터 delete 행은 잔존(정확히 1개).
        let rows: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT kind, event_id FROM pending_calendar_writes")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(rows.len(), 1, "옛 마스터 delete 행만 잔존");
        assert_eq!(rows[0].0, "delete");
        assert_eq!(
            rows[0].1.as_deref(),
            Some("evt_old"),
            "옛 마스터 delete 유지"
        );
    }
}
