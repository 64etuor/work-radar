// AppError is the repo-wide IPC envelope; this command/store glue keeps the same Result shape.
#![allow(clippy::result_large_err)]

use chrono::{Datelike, Duration, NaiveDate};
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    CreateKeyResultInput, CreateObjectiveInput, KeyResult, KeyResultKind, Mission, Objective,
    ObjectiveSignalStats, ObjectiveStatus, OkrCheckIn, OkrConfidence, OkrMilestone,
    OkrSignalStatsBucket, UpdateKeyResultInput, UpdateObjectiveInput,
};

#[derive(Debug, sqlx::FromRow)]
struct ObjectiveRow {
    id: String,
    quarter: String,
    title: String,
    description: Option<String>,
    sort_rank: i32,
    status: ObjectiveStatus,
    closed_reflection: Option<String>,
    linked_area_keys: String,
    linked_project_ids: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct KeyResultRow {
    id: String,
    objective_id: String,
    title: String,
    kind: KeyResultKind,
    target_value: Option<f64>,
    current_value: Option<f64>,
    unit: Option<String>,
    milestones: Option<String>,
    sort_rank: i32,
    routine_id: Option<String>,
    created_at: String,
    updated_at: String,
}

fn clean_required(raw: &str, code: &'static str, label: &'static str) -> Result<String, AppError> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(AppError::validation(code, format!("{label} is required")));
    }
    Ok(value.to_string())
}

fn clean_optional(raw: Option<String>) -> Option<String> {
    raw.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_string_vec(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

fn serialize_string_vec(values: Vec<String>, code: &'static str) -> Result<String, AppError> {
    serde_json::to_string(&normalize_string_vec(values))
        .map_err(|e| AppError::unexpected(code, e.to_string()))
}

fn parse_string_vec(raw: &str, code: &'static str) -> Result<Vec<String>, AppError> {
    serde_json::from_str::<Vec<String>>(raw).map_err(|e| AppError::unexpected(code, e.to_string()))
}

fn normalize_milestones(milestones: Vec<OkrMilestone>) -> Vec<OkrMilestone> {
    milestones
        .into_iter()
        .filter_map(|milestone| {
            let label = milestone.label.trim();
            if label.is_empty() {
                None
            } else {
                Some(OkrMilestone {
                    label: label.to_string(),
                    done: milestone.done,
                })
            }
        })
        .collect()
}

fn serialize_milestones(
    kind: KeyResultKind,
    milestones: Vec<OkrMilestone>,
) -> Result<Option<String>, AppError> {
    if matches!(kind, KeyResultKind::Metric) {
        return Ok(None);
    }
    serde_json::to_string(&normalize_milestones(milestones))
        .map(Some)
        .map_err(|e| AppError::unexpected("okr.milestones.serialize", e.to_string()))
}

fn parse_milestones(raw: Option<String>) -> Result<Vec<OkrMilestone>, AppError> {
    match raw {
        Some(value) => serde_json::from_str::<Vec<OkrMilestone>>(&value)
            .map_err(|e| AppError::unexpected("okr.milestones.parse", e.to_string())),
        None => Ok(Vec::new()),
    }
}

fn metric_progress(current: Option<f64>, target: Option<f64>) -> f64 {
    match (current, target) {
        (Some(current), Some(target)) if target > 0.0 => current / target,
        _ => 0.0,
    }
}

fn milestone_progress(milestones: &[OkrMilestone]) -> f64 {
    if milestones.is_empty() {
        return 0.0;
    }
    let done = milestones.iter().filter(|milestone| milestone.done).count() as f64;
    done / milestones.len() as f64
}

fn key_result_from_row(row: KeyResultRow) -> Result<KeyResult, AppError> {
    let milestones = parse_milestones(row.milestones)?;
    let progress = match row.kind {
        KeyResultKind::Metric => metric_progress(row.current_value, row.target_value),
        KeyResultKind::Milestone => milestone_progress(&milestones),
    };
    Ok(KeyResult {
        id: row.id,
        objective_id: row.objective_id,
        title: row.title,
        kind: row.kind,
        target_value: row.target_value,
        current_value: row.current_value,
        unit: row.unit,
        milestones,
        progress,
        sort_rank: row.sort_rank,
        routine_id: row.routine_id,
        routine: None, // attach_routine_progress가 분기 창 기준으로 채운다.
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn list_key_results_for_objective(
    db: &Db,
    objective_id: &str,
) -> Result<Vec<KeyResult>, AppError> {
    let rows = sqlx::query_as::<_, KeyResultRow>(
        "SELECT id, objective_id, title, kind, target_value, current_value, unit, milestones, \
                sort_rank, routine_id, created_at, updated_at \
           FROM key_results \
          WHERE objective_id = ?1 \
          ORDER BY sort_rank, created_at",
    )
    .bind(objective_id)
    .fetch_all(db)
    .await?;

    rows.into_iter().map(key_result_from_row).collect()
}

async fn objective_from_row(db: &Db, row: ObjectiveRow) -> Result<Objective, AppError> {
    let mut key_results = list_key_results_for_objective(db, &row.id).await?;
    attach_routine_progress(db, &row.quarter, &mut key_results).await?;
    Ok(Objective {
        id: row.id,
        quarter: row.quarter,
        title: row.title,
        description: row.description,
        sort_rank: row.sort_rank,
        status: row.status,
        closed_reflection: row.closed_reflection,
        linked_area_keys: parse_string_vec(&row.linked_area_keys, "okr.objective.areas.parse")?,
        linked_project_ids: parse_string_vec(
            &row.linked_project_ids,
            "okr.objective.projects.parse",
        )?,
        key_results,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn fetch_key_result(db: &Db, id: &str) -> Result<KeyResult, AppError> {
    let row = sqlx::query_as::<_, KeyResultRow>(
        "SELECT id, objective_id, title, kind, target_value, current_value, unit, milestones, \
                sort_rank, routine_id, created_at, updated_at \
           FROM key_results WHERE id = ?1",
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    enrich_single_kr(db, key_result_from_row(row)?).await
}

/// 'YYYY-Qn' → (분기 시작일, 종료일 inclusive). 형식 밖이면 None.
fn quarter_window(quarter: &str) -> Option<(chrono::NaiveDate, chrono::NaiveDate)> {
    let (year_raw, q_raw) = quarter.split_once("-Q")?;
    let year: i32 = year_raw.parse().ok()?;
    let q: u32 = q_raw.parse().ok()?;
    if !(1..=4).contains(&q) {
        return None;
    }
    let start = chrono::NaiveDate::from_ymd_opt(year, (q - 1) * 3 + 1, 1)?;
    let next_start = if q == 4 {
        chrono::NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        chrono::NaiveDate::from_ymd_opt(year, q * 3 + 1, 1)?
    };
    Some((start, next_start - chrono::Duration::days(1)))
}

/// attach_routine_progress가 읽는 루틴 스케줄 필드(로컬 조인 행).
#[derive(sqlx::FromRow)]
struct KrRoutineRow {
    title: String,
    freq: crate::models::RoutineFreq,
    weekdays: Option<String>,
    anchor_date: Option<String>,
    start_date: Option<String>,
    end_date: Option<String>,
    monthly_pattern: Option<crate::models::RoutineMonthlyPattern>,
    monthly_nth_week: Option<i64>,
}

/// %형 KR(unit '%', target 100) 판정 — 루틴 파생 시 completed/expected 비율로 계산한다.
fn is_percent_kr(unit: Option<&str>, target: Option<f64>) -> bool {
    unit == Some("%")
        && target
            .map(|t| (t - 100.0).abs() < f64::EPSILON)
            .unwrap_or(false)
}

/// 루틴 연결 KR의 진행을 분기 창 기준으로 **쿼리타임 파생**해 채운다(저장 없음 — 입력은 루틴
/// 체크 한 곳으로 수렴; 체크 자체가 사람 행동이고 여기는 그 집계 표시라 결정 레일 무침범).
/// 창=[분기 시작, min(오늘, 분기 끝)], expected=루틴 due 발생 수(패턴 ∧ 활성 구간 —
/// tracking.rs와 동일 술어), completed=창 내 완료 체크 수.
/// %형은 completed/expected, 그 외 metric은 completed/target. 루틴 소멸 시 조용히 스킵(수동 값 유지).
async fn attach_routine_progress(
    db: &Db,
    quarter: &str,
    key_results: &mut [KeyResult],
) -> Result<(), AppError> {
    use crate::commands::routines::{parse_weekdays, routine_due_on, within_active_window};
    if !key_results.iter().any(|kr| kr.routine_id.is_some()) {
        return Ok(());
    }
    let Some((q_start, q_end)) = quarter_window(quarter) else {
        return Ok(());
    };
    let end = q_end.min(chrono::Local::now().date_naive());
    if end < q_start {
        return Ok(());
    }
    let start_s = q_start.format("%Y-%m-%d").to_string();
    let end_s = end.format("%Y-%m-%d").to_string();
    for kr in key_results.iter_mut() {
        let Some(routine_id) = kr.routine_id.clone() else {
            continue;
        };
        if kr.kind != KeyResultKind::Metric {
            continue;
        }
        let Some(routine) = sqlx::query_as::<_, KrRoutineRow>(
            "SELECT title, freq, weekdays, anchor_date, start_date, end_date, \
                    monthly_pattern, monthly_nth_week \
               FROM routines WHERE id = ?1",
        )
        .bind(&routine_id)
        .fetch_optional(db)
        .await?
        else {
            continue;
        };

        let weekdays = parse_weekdays(routine.weekdays.as_deref());
        let nth_week = routine.monthly_nth_week.map(|v| v as i32);
        let mut expected: u32 = 0;
        let mut d = q_start;
        while d <= end {
            if routine_due_on(
                routine.freq,
                &weekdays,
                routine.anchor_date.as_deref(),
                routine.monthly_pattern,
                nth_week,
                d,
            ) && within_active_window(
                routine.start_date.as_deref(),
                routine.end_date.as_deref(),
                d,
            ) {
                expected += 1;
            }
            d += chrono::Duration::days(1);
        }

        let completed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM routine_checks \
              WHERE routine_id = ?1 AND completed_at IS NOT NULL AND date BETWEEN ?2 AND ?3",
        )
        .bind(&routine_id)
        .bind(&start_s)
        .bind(&end_s)
        .fetch_one(db)
        .await?;
        let completed = u32::try_from(completed.max(0)).unwrap_or(u32::MAX);

        if is_percent_kr(kr.unit.as_deref(), kr.target_value) {
            let pct = if expected == 0 {
                0.0
            } else {
                f64::from(completed) / f64::from(expected) * 100.0
            };
            kr.current_value = Some(pct.round());
            kr.progress = pct / 100.0;
        } else {
            kr.current_value = Some(f64::from(completed));
            kr.progress = metric_progress(kr.current_value, kr.target_value);
        }
        kr.routine = Some(crate::models::KrRoutineProgress {
            title: routine.title,
            completed,
            expected,
        });
    }
    Ok(())
}

/// 단건 KR 반환 경로용 파생 부착(objective의 quarter를 조회해 attach). 링크 없으면 no-op.
async fn enrich_single_kr(db: &Db, kr: KeyResult) -> Result<KeyResult, AppError> {
    if kr.routine_id.is_none() {
        return Ok(kr);
    }
    let quarter: Option<String> =
        sqlx::query_scalar("SELECT quarter FROM objectives WHERE id = ?1")
            .bind(&kr.objective_id)
            .fetch_optional(db)
            .await?;
    let Some(quarter) = quarter else {
        return Ok(kr);
    };
    let mut arr = [kr];
    attach_routine_progress(db, &quarter, &mut arr).await?;
    let [enriched] = arr;
    Ok(enriched)
}

pub(crate) async fn get_mission_inner(db: &Db) -> Result<Option<Mission>, AppError> {
    Ok(sqlx::query_as::<_, Mission>(
        "SELECT id, statement, note, updated_at FROM missions WHERE id = 1",
    )
    .fetch_optional(db)
    .await?)
}

pub(crate) async fn set_mission_inner(
    db: &Db,
    statement: &str,
    note: Option<String>,
) -> Result<Mission, AppError> {
    let statement = clean_required(statement, "okr.mission.statement", "mission statement")?;
    let note = clean_optional(note);
    Ok(sqlx::query_as::<_, Mission>(
        "INSERT INTO missions (id, statement, note, updated_at) \
         VALUES (1, ?1, ?2, datetime('now')) \
         ON CONFLICT(id) DO UPDATE SET \
           statement = excluded.statement, note = excluded.note, updated_at = datetime('now') \
         RETURNING id, statement, note, updated_at",
    )
    .bind(&statement)
    .bind(note.as_deref())
    .fetch_one(db)
    .await?)
}

pub(crate) async fn list_objectives_inner(
    db: &Db,
    quarter: &str,
) -> Result<Vec<Objective>, AppError> {
    let quarter = clean_required(quarter, "okr.objective.quarter", "quarter")?;
    let rows = sqlx::query_as::<_, ObjectiveRow>(
        "SELECT id, quarter, title, description, sort_rank, status, closed_reflection, \
                linked_area_keys, linked_project_ids, created_at, updated_at \
           FROM objectives \
          WHERE quarter = ?1 \
          ORDER BY sort_rank, created_at",
    )
    .bind(&quarter)
    .fetch_all(db)
    .await?;

    let mut objectives = Vec::with_capacity(rows.len());
    for row in rows {
        objectives.push(objective_from_row(db, row).await?);
    }
    Ok(objectives)
}

pub(crate) async fn create_objective_inner(
    db: &Db,
    input: CreateObjectiveInput,
) -> Result<Objective, AppError> {
    let quarter = clean_required(&input.quarter, "okr.objective.quarter", "quarter")?;
    let title = clean_required(&input.title, "okr.objective.title", "objective title")?;
    let description = clean_optional(input.description);
    let linked_area_keys =
        serialize_string_vec(input.linked_area_keys, "okr.objective.areas.serialize")?;
    let linked_project_ids =
        serialize_string_vec(input.linked_project_ids, "okr.objective.projects.serialize")?;

    let row = sqlx::query_as::<_, ObjectiveRow>(
        "INSERT INTO objectives \
         (id, quarter, title, description, sort_rank, linked_area_keys, linked_project_ids) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6) \
         RETURNING id, quarter, title, description, sort_rank, status, closed_reflection, \
                   linked_area_keys, linked_project_ids, created_at, updated_at",
    )
    .bind(&quarter)
    .bind(&title)
    .bind(description.as_deref())
    .bind(input.sort_rank)
    .bind(&linked_area_keys)
    .bind(&linked_project_ids)
    .fetch_one(db)
    .await?;
    objective_from_row(db, row).await
}

pub(crate) async fn update_objective_inner(
    db: &Db,
    input: UpdateObjectiveInput,
) -> Result<Objective, AppError> {
    let title = clean_required(&input.title, "okr.objective.title", "objective title")?;
    let description = clean_optional(input.description);
    let linked_area_keys =
        serialize_string_vec(input.linked_area_keys, "okr.objective.areas.serialize")?;
    let linked_project_ids =
        serialize_string_vec(input.linked_project_ids, "okr.objective.projects.serialize")?;

    let row = sqlx::query_as::<_, ObjectiveRow>(
        "UPDATE objectives SET \
           title = ?2, description = ?3, sort_rank = ?4, linked_area_keys = ?5, \
           linked_project_ids = ?6, updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING id, quarter, title, description, sort_rank, status, closed_reflection, \
                   linked_area_keys, linked_project_ids, created_at, updated_at",
    )
    .bind(&input.id)
    .bind(&title)
    .bind(description.as_deref())
    .bind(input.sort_rank)
    .bind(&linked_area_keys)
    .bind(&linked_project_ids)
    .fetch_one(db)
    .await?;
    objective_from_row(db, row).await
}

pub(crate) async fn close_objective_inner(
    db: &Db,
    id: &str,
    reflection: Option<String>,
) -> Result<Objective, AppError> {
    let reflection = clean_optional(reflection);
    let row = sqlx::query_as::<_, ObjectiveRow>(
        "UPDATE objectives SET status = 'closed', closed_reflection = ?2, updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING id, quarter, title, description, sort_rank, status, closed_reflection, \
                   linked_area_keys, linked_project_ids, created_at, updated_at",
    )
    .bind(id)
    .bind(reflection.as_deref())
    .fetch_one(db)
    .await?;
    objective_from_row(db, row).await
}

pub(crate) async fn delete_objective_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM objectives WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn create_key_result_inner(
    db: &Db,
    input: CreateKeyResultInput,
) -> Result<KeyResult, AppError> {
    let title = clean_required(&input.title, "okr.key_result.title", "key result title")?;
    let unit = clean_optional(input.unit);
    let milestones = serialize_milestones(input.kind, input.milestones)?;
    let row = sqlx::query_as::<_, KeyResultRow>(
        "INSERT INTO key_results \
         (id, objective_id, title, kind, target_value, current_value, unit, milestones, sort_rank) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         RETURNING id, objective_id, title, kind, target_value, current_value, unit, milestones, \
                   sort_rank, routine_id, created_at, updated_at",
    )
    .bind(&input.objective_id)
    .bind(&title)
    .bind(input.kind)
    .bind(input.target_value)
    .bind(input.current_value)
    .bind(unit.as_deref())
    .bind(milestones.as_deref())
    .bind(input.sort_rank)
    .fetch_one(db)
    .await?;
    enrich_single_kr(db, key_result_from_row(row)?).await
}

pub(crate) async fn update_key_result_inner(
    db: &Db,
    input: UpdateKeyResultInput,
) -> Result<KeyResult, AppError> {
    let title = clean_required(&input.title, "okr.key_result.title", "key result title")?;
    let unit = clean_optional(input.unit);
    let milestones = serialize_milestones(input.kind, input.milestones)?;
    let row = sqlx::query_as::<_, KeyResultRow>(
        "UPDATE key_results SET \
           title = ?2, kind = ?3, target_value = ?4, current_value = ?5, unit = ?6, \
           milestones = ?7, sort_rank = ?8, updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING id, objective_id, title, kind, target_value, current_value, unit, milestones, \
                   sort_rank, routine_id, created_at, updated_at",
    )
    .bind(&input.id)
    .bind(&title)
    .bind(input.kind)
    .bind(input.target_value)
    .bind(input.current_value)
    .bind(unit.as_deref())
    .bind(milestones.as_deref())
    .bind(input.sort_rank)
    .fetch_one(db)
    .await?;
    enrich_single_kr(db, key_result_from_row(row)?).await
}

pub(crate) async fn delete_key_result_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM key_results WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn upsert_check_in_inner(
    db: &Db,
    key_result_id: &str,
    week_start: &str,
    confidence: OkrConfidence,
    note: Option<String>,
) -> Result<OkrCheckIn, AppError> {
    validate_date(week_start, "okr.check_in.week_start")?;
    let key_result = fetch_key_result(db, key_result_id).await?;
    let note = clean_optional(note);
    Ok(sqlx::query_as::<_, OkrCheckIn>(
        "INSERT INTO okr_check_ins \
         (id, key_result_id, week_start, value_snapshot, confidence, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(key_result_id, week_start) DO UPDATE SET \
           value_snapshot = excluded.value_snapshot, confidence = excluded.confidence, note = excluded.note \
         RETURNING id, key_result_id, week_start, value_snapshot, confidence, note, created_at",
    )
    .bind(key_result_id)
    .bind(week_start)
    .bind(key_result.progress)
    .bind(confidence)
    .bind(note.as_deref())
    .fetch_one(db)
    .await?)
}

pub(crate) async fn list_check_ins_inner(
    db: &Db,
    quarter: &str,
) -> Result<Vec<OkrCheckIn>, AppError> {
    let quarter = clean_required(quarter, "okr.objective.quarter", "quarter")?;
    Ok(sqlx::query_as::<_, OkrCheckIn>(
        "SELECT ci.id, ci.key_result_id, ci.week_start, ci.value_snapshot, ci.confidence, \
                ci.note, ci.created_at \
           FROM okr_check_ins ci \
           JOIN key_results kr ON kr.id = ci.key_result_id \
           JOIN objectives o ON o.id = kr.objective_id \
          WHERE o.quarter = ?1 \
          ORDER BY ci.week_start DESC, ci.created_at DESC",
    )
    .bind(&quarter)
    .fetch_all(db)
    .await?)
}

fn validate_date(raw: &str, code: &'static str) -> Result<NaiveDate, AppError> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map_err(|_| AppError::validation(code, "date must be YYYY-MM-DD"))
}

fn quarter_bounds(quarter: &str) -> Result<(NaiveDate, NaiveDate), AppError> {
    let (year_raw, q_raw) = quarter
        .split_once("-Q")
        .ok_or_else(|| AppError::validation("okr.quarter", "quarter must be YYYY-Qn"))?;
    let year: i32 = year_raw
        .parse()
        .map_err(|_| AppError::validation("okr.quarter", "quarter year must be numeric"))?;
    let q: u32 = q_raw
        .parse()
        .map_err(|_| AppError::validation("okr.quarter", "quarter number must be numeric"))?;
    if !(1..=4).contains(&q) {
        return Err(AppError::validation(
            "okr.quarter",
            "quarter number must be 1..4",
        ));
    }
    let month = ((q - 1) * 3) + 1;
    let start = NaiveDate::from_ymd_opt(year, month, 1)
        .ok_or_else(|| AppError::validation("okr.quarter", "invalid quarter start"))?;
    let (next_year, next_month) = if q == 4 {
        (year + 1, 1)
    } else {
        (year, month + 3)
    };
    let next_start = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .ok_or_else(|| AppError::validation("okr.quarter", "invalid quarter end"))?;
    Ok((start, next_start - Duration::days(1)))
}

fn date_string(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn stats_windows(quarter: &str) -> Result<(String, String, String, String), AppError> {
    let (quarter_start, quarter_end) = quarter_bounds(quarter)?;
    let today = chrono::Local::now().date_naive();
    let week_start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let quarter_to_date_end = if today > quarter_end {
        quarter_end
    } else {
        today
    };
    Ok((
        date_string(week_start),
        date_string(today),
        date_string(quarter_start),
        date_string(quarter_to_date_end),
    ))
}

fn to_i32_count(value: i64) -> i32 {
    value.clamp(0, i32::MAX as i64) as i32
}

async fn stats_for_objective(
    db: &Db,
    objective_id: &str,
    week_start: &str,
    week_end: &str,
    quarter_start: &str,
    quarter_end: &str,
) -> Result<ObjectiveSignalStats, AppError> {
    let (
        week_captured,
        week_completed,
        week_minutes,
        quarter_captured,
        quarter_completed,
        quarter_minutes,
    ): (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "WITH objective AS ( \
             SELECT linked_area_keys, linked_project_ids FROM objectives WHERE id = ?1 \
         ), matching_signals AS ( \
             SELECT DISTINCT s.id, date(s.created_at, 'localtime') AS created_date, s.today_done_at \
               FROM signals s CROSS JOIN objective o \
              WHERE ( \
                    EXISTS ( \
                      SELECT 1 FROM json_each(o.linked_area_keys) area_key \
                       WHERE area_key.value = s.area \
                          OR EXISTS ( \
                              SELECT 1 FROM json_each(COALESCE(s.area_tags, '[]')) signal_area \
                               WHERE signal_area.value = area_key.value \
                          ) \
                    ) \
                    OR (s.project_id IS NOT NULL AND EXISTS ( \
                      SELECT 1 FROM json_each(o.linked_project_ids) project_id \
                       WHERE project_id.value = s.project_id \
                    )) \
              ) \
         ), matching_minutes AS ( \
             SELECT p.date, p.duration_min \
               FROM signal_day_placements p \
               JOIN matching_signals ms ON ms.id = p.signal_id \
         ) \
         SELECT \
           COALESCE(SUM(CASE WHEN created_date BETWEEN ?2 AND ?3 THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN today_done_at BETWEEN ?2 AND ?3 THEN 1 ELSE 0 END), 0), \
           COALESCE((SELECT SUM(duration_min) FROM matching_minutes WHERE date BETWEEN ?2 AND ?3), 0), \
           COALESCE(SUM(CASE WHEN created_date BETWEEN ?4 AND ?5 THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN today_done_at BETWEEN ?4 AND ?5 THEN 1 ELSE 0 END), 0), \
           COALESCE((SELECT SUM(duration_min) FROM matching_minutes WHERE date BETWEEN ?4 AND ?5), 0) \
         FROM matching_signals",
    )
    .bind(objective_id)
    .bind(week_start)
    .bind(week_end)
    .bind(quarter_start)
    .bind(quarter_end)
    .fetch_one(db)
    .await?;

    Ok(ObjectiveSignalStats {
        objective_id: objective_id.to_string(),
        week: OkrSignalStatsBucket {
            captured: to_i32_count(week_captured),
            completed: to_i32_count(week_completed),
            scheduled_minutes: to_i32_count(week_minutes),
        },
        quarter_to_date: OkrSignalStatsBucket {
            captured: to_i32_count(quarter_captured),
            completed: to_i32_count(quarter_completed),
            scheduled_minutes: to_i32_count(quarter_minutes),
        },
    })
}

pub(crate) async fn objective_signal_stats_inner(
    db: &Db,
    quarter: &str,
) -> Result<Vec<ObjectiveSignalStats>, AppError> {
    let quarter = clean_required(quarter, "okr.objective.quarter", "quarter")?;
    let (week_start, week_end, quarter_start, quarter_end) = stats_windows(&quarter)?;
    let objective_ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM objectives WHERE quarter = ?1 ORDER BY sort_rank, created_at",
    )
    .bind(&quarter)
    .fetch_all(db)
    .await?;
    let mut stats = Vec::with_capacity(objective_ids.len());
    for (objective_id,) in objective_ids {
        stats.push(
            stats_for_objective(
                db,
                &objective_id,
                &week_start,
                &week_end,
                &quarter_start,
                &quarter_end,
            )
            .await?,
        );
    }
    Ok(stats)
}

#[tauri::command]
#[specta::specta]
pub async fn get_mission(db: State<'_, Db>) -> Result<Option<Mission>, AppError> {
    get_mission_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_mission(
    db: State<'_, Db>,
    statement: String,
    note: Option<String>,
) -> Result<Mission, AppError> {
    set_mission_inner(db.inner(), &statement, note).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_objectives(
    db: State<'_, Db>,
    quarter: String,
) -> Result<Vec<Objective>, AppError> {
    list_objectives_inner(db.inner(), &quarter).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_objective(
    db: State<'_, Db>,
    input: CreateObjectiveInput,
) -> Result<Objective, AppError> {
    create_objective_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_objective(
    db: State<'_, Db>,
    input: UpdateObjectiveInput,
) -> Result<Objective, AppError> {
    update_objective_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn close_objective(
    db: State<'_, Db>,
    id: String,
    reflection: Option<String>,
) -> Result<Objective, AppError> {
    close_objective_inner(db.inner(), &id, reflection).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_objective(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_objective_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_key_result(
    db: State<'_, Db>,
    input: CreateKeyResultInput,
) -> Result<KeyResult, AppError> {
    create_key_result_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_key_result(
    db: State<'_, Db>,
    input: UpdateKeyResultInput,
) -> Result<KeyResult, AppError> {
    update_key_result_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_key_result(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_key_result_inner(db.inner(), &id).await
}

/// KR ↔ 루틴 연결/해제(routine_id=None). 연결하면 진행이 분기 창의 루틴 완료에서 쿼리타임
/// 파생된다(수동 현재값 입력 대체). 수치형 KR만 — 마일스톤형은 체크리스트가 이미 입력 표면.
#[tauri::command]
#[specta::specta]
pub async fn set_key_result_routine(
    db: State<'_, Db>,
    id: String,
    routine_id: Option<String>,
) -> Result<KeyResult, AppError> {
    let existing = fetch_key_result(db.inner(), &id).await?;
    if routine_id.is_some() && existing.kind != KeyResultKind::Metric {
        return Err(AppError::validation(
            "okr.kr_routine.metric_only",
            "루틴 연결은 수치형 KR만 가능합니다.",
        ));
    }
    if let Some(rid) = routine_id.as_deref() {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM routines WHERE id = ?1 AND active = 1")
                .bind(rid)
                .fetch_optional(db.inner())
                .await?;
        if exists.is_none() {
            return Err(AppError::not_found(
                "okr.kr_routine.routine_missing",
                "루틴을 찾을 수 없습니다.",
            ));
        }
    }
    sqlx::query(
        "UPDATE key_results SET routine_id = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(&id)
    .bind(routine_id.as_deref())
    .execute(db.inner())
    .await?;
    fetch_key_result(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_check_in(
    db: State<'_, Db>,
    key_result_id: String,
    week_start: String,
    confidence: OkrConfidence,
    note: Option<String>,
) -> Result<OkrCheckIn, AppError> {
    upsert_check_in_inner(db.inner(), &key_result_id, &week_start, confidence, note).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_check_ins(
    db: State<'_, Db>,
    quarter: String,
) -> Result<Vec<OkrCheckIn>, AppError> {
    list_check_ins_inner(db.inner(), &quarter).await
}

#[tauri::command]
#[specta::specta]
pub async fn objective_signal_stats(
    db: State<'_, Db>,
    quarter: String,
) -> Result<Vec<ObjectiveSignalStats>, AppError> {
    objective_signal_stats_inner(db.inner(), &quarter).await
}

#[cfg(test)]
mod tests {
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{
        CreateKeyResultInput, CreateObjectiveInput, KeyResultKind, ObjectiveStatus, OkrConfidence,
        OkrMilestone, UpdateKeyResultInput, UpdateObjectiveInput,
    };

    use chrono::Datelike;

    #[tokio::test]
    async fn routine_linked_kr_derives_progress_from_checks() {
        let db = fresh_db().await;
        let today = chrono::Local::now().date_naive();
        let quarter = format!("{}-Q{}", today.year(), ((today.month() - 1) / 3) + 1);
        let q_start = super::quarter_window(&quarter).unwrap().0;
        let q_start_s = q_start.format("%Y-%m-%d").to_string();

        // 활성 창=분기 첫날 하루짜리 daily 루틴 → expected는 날짜와 무관하게 항상 1.
        sqlx::query(
            "INSERT INTO routines (id, title, freq, start_date, end_date) \
             VALUES ('r1', '크로스핏', 'daily', ?1, ?1)",
        )
        .bind(&q_start_s)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date, completed_at) \
             VALUES ('c1', 'r1', ?1, datetime('now'))",
        )
        .bind(&q_start_s)
        .execute(&db)
        .await
        .unwrap();

        let objective = super::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: quarter.clone(),
                title: "몸".into(),
                description: None,
                sort_rank: 0,
                linked_area_keys: vec![],
                linked_project_ids: vec![],
            },
        )
        .await
        .unwrap();
        let count_kr = super::create_key_result_inner(
            &db,
            CreateKeyResultInput {
                objective_id: objective.id.clone(),
                title: "크로스핏 48회".into(),
                kind: KeyResultKind::Metric,
                current_value: None,
                target_value: Some(48.0),
                unit: Some("회".into()),
                milestones: vec![],
                sort_rank: 0,
            },
        )
        .await
        .unwrap();
        let pct_kr = super::create_key_result_inner(
            &db,
            CreateKeyResultInput {
                objective_id: objective.id.clone(),
                title: "체크인 100%".into(),
                kind: KeyResultKind::Metric,
                current_value: None,
                target_value: Some(100.0),
                unit: Some("%".into()),
                milestones: vec![],
                sort_rank: 1,
            },
        )
        .await
        .unwrap();
        for kr_id in [&count_kr.id, &pct_kr.id] {
            sqlx::query("UPDATE key_results SET routine_id = 'r1' WHERE id = ?1")
                .bind(kr_id)
                .execute(&db)
                .await
                .unwrap();
        }

        let objectives = super::list_objectives_inner(&db, &quarter).await.unwrap();
        let krs = &objectives
            .iter()
            .find(|o| o.id == objective.id)
            .unwrap()
            .key_results;
        let count = krs.iter().find(|k| k.id == count_kr.id).unwrap();
        let pct = krs.iter().find(|k| k.id == pct_kr.id).unwrap();

        // 횟수형: current=완료수, progress=완료/target.
        let routine = count.routine.as_ref().unwrap();
        assert_eq!((routine.completed, routine.expected), (1, 1));
        assert_eq!(count.current_value, Some(1.0));
        assert!((count.progress - 1.0 / 48.0).abs() < 1e-9);
        // %형(unit %, target 100): completed/expected 비율.
        assert_eq!(pct.current_value, Some(100.0));
        assert!((pct.progress - 1.0).abs() < 1e-9);
    }

    #[test]
    fn quarter_window_parses_bounds() {
        let (start, end) = super::quarter_window("2026-Q3").unwrap();
        assert_eq!(start.to_string(), "2026-07-01");
        assert_eq!(end.to_string(), "2026-09-30");
        let (start, end) = super::quarter_window("2026-Q4").unwrap();
        assert_eq!(start.to_string(), "2026-10-01");
        assert_eq!(end.to_string(), "2026-12-31");
        assert!(super::quarter_window("nope").is_none());
    }

    #[tokio::test]
    async fn okr_migration_creates_core_tables() {
        let db = fresh_db().await;
        for table in ["missions", "objectives", "key_results", "okr_check_ins"] {
            let exists: (i32,) = sqlx::query_as(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            )
            .bind(table)
            .fetch_one(&db)
            .await
            .expect("sqlite_master query");
            assert_eq!(exists.0, 1, "{table} table should exist");
        }
    }

    #[tokio::test]
    async fn okr_crud_round_trips_and_deletes_cascade() {
        let db = fresh_db().await;

        let mission = super::set_mission_inner(&db, "Build the durable operator cockpit", None)
            .await
            .unwrap();
        assert_eq!(mission.id, 1);
        assert_eq!(mission.statement, "Build the durable operator cockpit");
        let loaded = super::get_mission_inner(&db).await.unwrap().unwrap();
        assert_eq!(loaded.statement, mission.statement);

        let objective = super::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: "2026-Q3".into(),
                title: "Ship Mission/OKR backend".into(),
                description: Some("Backend only".into()),
                sort_rank: 10,
                linked_area_keys: vec!["work".into(), "health".into()],
                linked_project_ids: vec!["project-a".into()],
            },
        )
        .await
        .unwrap();
        assert_eq!(objective.key_results.len(), 0);
        assert_eq!(objective.linked_area_keys, vec!["work", "health"]);

        let updated = super::update_objective_inner(
            &db,
            UpdateObjectiveInput {
                id: objective.id.clone(),
                title: "Ship OKR backend".into(),
                description: None,
                sort_rank: 4,
                linked_area_keys: vec!["work".into()],
                linked_project_ids: vec![],
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.title, "Ship OKR backend");
        assert!(updated.description.is_none());
        assert_eq!(updated.sort_rank, 4);

        let kr = super::create_key_result_inner(
            &db,
            CreateKeyResultInput {
                objective_id: objective.id.clone(),
                title: "Expose typed commands".into(),
                kind: KeyResultKind::Metric,
                target_value: Some(10.0),
                current_value: Some(2.0),
                unit: Some("commands".into()),
                milestones: vec![],
                sort_rank: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(kr.objective_id, objective.id);
        assert_eq!(kr.progress, 0.2);

        let closed = super::close_objective_inner(&db, &objective.id, Some("Ready for UI".into()))
            .await
            .unwrap();
        assert_eq!(closed.status, ObjectiveStatus::Closed);
        assert_eq!(closed.closed_reflection.as_deref(), Some("Ready for UI"));

        super::delete_objective_inner(&db, &objective.id)
            .await
            .unwrap();
        let (remaining_krs,): (i32,) =
            sqlx::query_as("SELECT COUNT(*) FROM key_results WHERE objective_id = ?1")
                .bind(&objective.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(remaining_krs, 0, "objective delete should cascade to KRs");
    }

    #[tokio::test]
    async fn okr_check_in_upsert_overwrites_same_week_with_server_snapshot() {
        let db = fresh_db().await;
        let objective = super::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: "2026-Q3".into(),
                title: "Improve operating cadence".into(),
                description: None,
                sort_rank: 0,
                linked_area_keys: vec![],
                linked_project_ids: vec![],
            },
        )
        .await
        .unwrap();
        let kr = super::create_key_result_inner(
            &db,
            CreateKeyResultInput {
                objective_id: objective.id,
                title: "Complete milestones".into(),
                kind: KeyResultKind::Milestone,
                target_value: None,
                current_value: None,
                unit: None,
                milestones: vec![
                    OkrMilestone {
                        label: "schema".into(),
                        done: true,
                    },
                    OkrMilestone {
                        label: "commands".into(),
                        done: false,
                    },
                ],
                sort_rank: 0,
            },
        )
        .await
        .unwrap();

        let first = super::upsert_check_in_inner(
            &db,
            &kr.id,
            "2026-07-06",
            OkrConfidence::AtRisk,
            Some("Need command registration".into()),
        )
        .await
        .unwrap();
        assert_eq!(first.value_snapshot, 0.5);

        let updated_kr = super::update_key_result_inner(
            &db,
            UpdateKeyResultInput {
                id: kr.id.clone(),
                title: "Complete milestones".into(),
                kind: KeyResultKind::Milestone,
                target_value: None,
                current_value: None,
                unit: None,
                milestones: vec![
                    OkrMilestone {
                        label: "schema".into(),
                        done: true,
                    },
                    OkrMilestone {
                        label: "commands".into(),
                        done: true,
                    },
                ],
                sort_rank: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated_kr.progress, 1.0);

        let second = super::upsert_check_in_inner(
            &db,
            &kr.id,
            "2026-07-06",
            OkrConfidence::OnTrack,
            Some("All green".into()),
        )
        .await
        .unwrap();
        assert_eq!(second.id, first.id, "same week should update the row");
        assert_eq!(second.value_snapshot, 1.0);
        assert_eq!(second.confidence, OkrConfidence::OnTrack);
        assert_eq!(second.note.as_deref(), Some("All green"));

        let check_ins = super::list_check_ins_inner(&db, "2026-Q3").await.unwrap();
        assert_eq!(check_ins.len(), 1);
    }

    #[tokio::test]
    async fn objective_signal_stats_aggregates_area_project_counts_and_minutes() {
        let db = fresh_db().await;
        sqlx::query(
            "INSERT INTO projects (id, name, kind, credential_ref) \
             VALUES ('p1', 'Work', 'work', 'cred-p1')",
        )
        .execute(&db)
        .await
        .unwrap();

        let today = chrono::Local::now().date_naive();
        let quarter = format!("{}-Q{}", today.year(), ((today.month() - 1) / 3) + 1);
        let today_s = today.format("%Y-%m-%d").to_string();
        let objective = super::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: quarter.clone(),
                title: "Move work that matters".into(),
                description: None,
                sort_rank: 0,
                linked_area_keys: vec!["health".into()],
                linked_project_ids: vec!["p1".into()],
            },
        )
        .await
        .unwrap();
        let unmapped = super::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: quarter.clone(),
                title: "No links".into(),
                description: None,
                sort_rank: 1,
                linked_area_keys: vec![],
                linked_project_ids: vec![],
            },
        )
        .await
        .unwrap();

        let created_at = format!("{today_s} 09:00:00");
        sqlx::query(
            "INSERT INTO signals (id, project_id, title, source, type, area, created_at, today_done_at) \
             VALUES ('s-both', 'p1', 'matched both once', 'braindump', 'thought', 'health', ?1, ?2)",
        )
        .bind(&created_at)
        .bind(&today_s)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO signals (id, project_id, title, source, type, created_at) \
             VALUES ('s-project', 'p1', 'matched project', 'braindump', 'thought', ?1)",
        )
        .bind(&created_at)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, area_tags, created_at) \
             VALUES ('s-tags', 'matched area tags', 'braindump', 'thought', '[\"health\"]', ?1)",
        )
        .bind(&created_at)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, area, created_at, today_done_at) \
             VALUES ('s-other', 'not matched', 'braindump', 'thought', 'work', ?1, ?2)",
        )
        .bind(&created_at)
        .bind(&today_s)
        .execute(&db)
        .await
        .unwrap();
        for (signal_id, minutes) in [("s-both", 45), ("s-project", 60), ("s-tags", 30)] {
            sqlx::query(
                "INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min) \
                 VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4)",
            )
            .bind(signal_id)
            .bind(&today_s)
            .bind(format!("{today_s}T10:00:00"))
            .bind(minutes)
            .execute(&db)
            .await
            .unwrap();
        }

        let stats = super::objective_signal_stats_inner(&db, &quarter)
            .await
            .unwrap();
        let mapped = stats
            .iter()
            .find(|row| row.objective_id == objective.id)
            .unwrap();
        assert_eq!(mapped.week.captured, 3);
        assert_eq!(mapped.week.completed, 1);
        assert_eq!(mapped.week.scheduled_minutes, 135);
        assert_eq!(mapped.quarter_to_date.captured, 3);
        assert_eq!(mapped.quarter_to_date.completed, 1);
        assert_eq!(mapped.quarter_to_date.scheduled_minutes, 135);

        let empty = stats
            .iter()
            .find(|row| row.objective_id == unmapped.id)
            .unwrap();
        assert_eq!(empty.week.captured, 0);
        assert_eq!(empty.quarter_to_date.scheduled_minutes, 0);
    }
}
