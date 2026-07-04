// AppError is intentionally the IPC envelope for all local Life OS writes.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::hash::{Hash, Hasher};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    AcceptLifeOsRecommendationInput, AreaTag, CreateMissionHorizonInput,
    DismissLifeOsRecommendationInput, GenerateLifeOsReviewInput, GuardrailTargetKind,
    LifeOsAuditEvent, LifeOsDiagnosis, LifeOsRecommendation, LifeOsRecommendationKind,
    LifeOsRecommendationStatus, LifeOsRecordStatus, LifeOsSignalReview, LifeOsSnapshot,
    MissionHorizon, MissionHorizonKind, Objective, ObjectiveHorizonLink, ObjectiveStatus,
    OkrGuardrail, Quadrant, RecordLifeOsAuditInput, SelectWeeklyFocusInput,
    UpdateMissionHorizonInput, UpsertGuardrailInput, WeeklyFocus, WeeklyFocusSourceKind,
    WeeklyFocusStatus, WorkSignal, WscKind,
};

#[derive(Debug, sqlx::FromRow)]
struct MissionHorizonRow {
    id: String,
    title: String,
    description: Option<String>,
    horizon_kind: MissionHorizonKind,
    wsc_kind: Option<WscKind>,
    area_keys: String,
    status: LifeOsRecordStatus,
    sort_rank: i32,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct GuardrailRow {
    id: String,
    quarter: String,
    area_key: String,
    label: String,
    target_kind: GuardrailTargetKind,
    target_value: Option<f64>,
    unit: Option<String>,
    source_routine_ids: String,
    status: LifeOsRecordStatus,
    sort_rank: i32,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct LifeOsSnapshotRow {
    id: String,
    week_start: String,
    quarter: String,
    range_start: String,
    range_end: String,
    diagnosis_json: String,
    recommendation_json: Option<String>,
    source_hash: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct LifeOsRecommendationRow {
    id: String,
    snapshot_id: Option<String>,
    week_start: String,
    kind: LifeOsRecommendationKind,
    title: String,
    reason: Option<String>,
    source_kind: Option<WeeklyFocusSourceKind>,
    source_id: Option<String>,
    confidence: i32,
    payload_json: String,
    status: LifeOsRecommendationStatus,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
pub(crate) struct WeeklyFocusRow {
    pub(crate) id: String,
    pub(crate) week_start: String,
    pub(crate) title: String,
    pub(crate) source_kind: WeeklyFocusSourceKind,
    pub(crate) source_id: Option<String>,
    pub(crate) objective_id: Option<String>,
    pub(crate) key_result_id: Option<String>,
    pub(crate) horizon_id: Option<String>,
    pub(crate) status: WeeklyFocusStatus,
    pub(crate) estimated_minutes: Option<i32>,
    pub(crate) reason: Option<String>,
    pub(crate) must_do_signal_ids: String,
    pub(crate) not_do_signal_ids: String,
    pub(crate) guardrail_ids: String,
    pub(crate) shrink_count: i32,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
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

pub(crate) fn normalize_string_vec(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !out.iter().any(|existing| existing == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    out
}

pub(crate) fn serialize_string_vec(
    values: Vec<String>,
    code: &'static str,
) -> Result<String, AppError> {
    serde_json::to_string(&normalize_string_vec(values))
        .map_err(|e| AppError::unexpected(code, e.to_string()))
}

pub(crate) fn parse_string_vec(raw: &str, code: &'static str) -> Result<Vec<String>, AppError> {
    serde_json::from_str::<Vec<String>>(raw).map_err(|e| AppError::unexpected(code, e.to_string()))
}

pub(crate) fn validate_date(raw: &str, code: &'static str) -> Result<(), AppError> {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| AppError::validation(code, "date must be YYYY-MM-DD"))
}

fn horizon_from_row(row: MissionHorizonRow) -> Result<MissionHorizon, AppError> {
    Ok(MissionHorizon {
        id: row.id,
        title: row.title,
        description: row.description,
        horizon_kind: row.horizon_kind,
        wsc_kind: row.wsc_kind,
        area_keys: parse_string_vec(&row.area_keys, "life_os.horizon.areas.parse")?,
        status: row.status,
        sort_rank: row.sort_rank,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn guardrail_from_row(row: GuardrailRow) -> Result<OkrGuardrail, AppError> {
    Ok(OkrGuardrail {
        id: row.id,
        quarter: row.quarter,
        area_key: row.area_key,
        label: row.label,
        target_kind: row.target_kind,
        target_value: row.target_value,
        unit: row.unit,
        source_routine_ids: parse_string_vec(
            &row.source_routine_ids,
            "life_os.guardrail.routines.parse",
        )?,
        status: row.status,
        sort_rank: row.sort_rank,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) fn weekly_focus_from_row(row: WeeklyFocusRow) -> Result<WeeklyFocus, AppError> {
    Ok(WeeklyFocus {
        id: row.id,
        week_start: row.week_start,
        title: row.title,
        source_kind: row.source_kind,
        source_id: row.source_id,
        objective_id: row.objective_id,
        key_result_id: row.key_result_id,
        horizon_id: row.horizon_id,
        status: row.status,
        estimated_minutes: row.estimated_minutes,
        reason: row.reason,
        must_do_signal_ids: parse_string_vec(
            &row.must_do_signal_ids,
            "life_os.weekly_focus.must_do.parse",
        )?,
        not_do_signal_ids: parse_string_vec(
            &row.not_do_signal_ids,
            "life_os.weekly_focus.not_do.parse",
        )?,
        guardrail_ids: parse_string_vec(
            &row.guardrail_ids,
            "life_os.weekly_focus.guardrails.parse",
        )?,
        shrink_count: row.shrink_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn list_mission_horizons_inner(db: &Db) -> Result<Vec<MissionHorizon>, AppError> {
    let rows = sqlx::query_as::<_, MissionHorizonRow>(
        "SELECT id, title, description, horizon_kind, wsc_kind, area_keys, status, sort_rank, \
                created_at, updated_at \
           FROM mission_horizons \
          ORDER BY sort_rank, created_at",
    )
    .fetch_all(db)
    .await?;
    rows.into_iter().map(horizon_from_row).collect()
}

pub(crate) async fn create_mission_horizon_inner(
    db: &Db,
    input: CreateMissionHorizonInput,
) -> Result<MissionHorizon, AppError> {
    let title = clean_required(&input.title, "life_os.horizon.title", "horizon title")?;
    let description = clean_optional(input.description);
    let area_keys = serialize_string_vec(input.area_keys, "life_os.horizon.areas.serialize")?;
    let row = sqlx::query_as::<_, MissionHorizonRow>(
        "INSERT INTO mission_horizons \
         (id, title, description, horizon_kind, wsc_kind, area_keys, sort_rank) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6) \
         RETURNING id, title, description, horizon_kind, wsc_kind, area_keys, status, sort_rank, \
                   created_at, updated_at",
    )
    .bind(&title)
    .bind(description.as_deref())
    .bind(input.horizon_kind)
    .bind(input.wsc_kind)
    .bind(&area_keys)
    .bind(input.sort_rank)
    .fetch_one(db)
    .await?;
    horizon_from_row(row)
}

pub(crate) async fn update_mission_horizon_inner(
    db: &Db,
    input: UpdateMissionHorizonInput,
) -> Result<MissionHorizon, AppError> {
    let title = clean_required(&input.title, "life_os.horizon.title", "horizon title")?;
    let description = clean_optional(input.description);
    let area_keys = serialize_string_vec(input.area_keys, "life_os.horizon.areas.serialize")?;
    let row = sqlx::query_as::<_, MissionHorizonRow>(
        "UPDATE mission_horizons SET \
           title = ?2, description = ?3, horizon_kind = ?4, wsc_kind = ?5, area_keys = ?6, \
           status = ?7, sort_rank = ?8, updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING id, title, description, horizon_kind, wsc_kind, area_keys, status, sort_rank, \
                   created_at, updated_at",
    )
    .bind(&input.id)
    .bind(&title)
    .bind(description.as_deref())
    .bind(input.horizon_kind)
    .bind(input.wsc_kind)
    .bind(&area_keys)
    .bind(input.status)
    .bind(input.sort_rank)
    .fetch_one(db)
    .await?;
    horizon_from_row(row)
}

pub(crate) async fn delete_mission_horizon_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM mission_horizons WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn list_guardrails_inner(
    db: &Db,
    quarter: &str,
) -> Result<Vec<OkrGuardrail>, AppError> {
    let quarter = clean_required(quarter, "life_os.guardrail.quarter", "quarter")?;
    let rows = sqlx::query_as::<_, GuardrailRow>(
        "SELECT id, quarter, area_key, label, target_kind, target_value, unit, \
                source_routine_ids, status, sort_rank, created_at, updated_at \
           FROM okr_guardrails \
          WHERE quarter = ?1 \
          ORDER BY sort_rank, created_at",
    )
    .bind(&quarter)
    .fetch_all(db)
    .await?;
    rows.into_iter().map(guardrail_from_row).collect()
}

pub(crate) async fn upsert_guardrail_inner(
    db: &Db,
    input: UpsertGuardrailInput,
) -> Result<OkrGuardrail, AppError> {
    let quarter = clean_required(&input.quarter, "life_os.guardrail.quarter", "quarter")?;
    let area_key = clean_required(&input.area_key, "life_os.guardrail.area", "area")?;
    let label = clean_required(&input.label, "life_os.guardrail.label", "guardrail label")?;
    let unit = clean_optional(input.unit);
    let source_routine_ids = serialize_string_vec(
        input.source_routine_ids,
        "life_os.guardrail.routines.serialize",
    )?;
    let row = if let Some(id) = input.id {
        sqlx::query_as::<_, GuardrailRow>(
            "UPDATE okr_guardrails SET \
               quarter = ?2, area_key = ?3, label = ?4, target_kind = ?5, target_value = ?6, \
               unit = ?7, source_routine_ids = ?8, sort_rank = ?9, updated_at = datetime('now') \
             WHERE id = ?1 \
             RETURNING id, quarter, area_key, label, target_kind, target_value, unit, \
                       source_routine_ids, status, sort_rank, created_at, updated_at",
        )
        .bind(&id)
        .bind(&quarter)
        .bind(&area_key)
        .bind(&label)
        .bind(input.target_kind)
        .bind(input.target_value)
        .bind(unit.as_deref())
        .bind(&source_routine_ids)
        .bind(input.sort_rank)
        .fetch_one(db)
        .await?
    } else {
        sqlx::query_as::<_, GuardrailRow>(
            "INSERT INTO okr_guardrails \
             (id, quarter, area_key, label, target_kind, target_value, unit, source_routine_ids, sort_rank) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             RETURNING id, quarter, area_key, label, target_kind, target_value, unit, \
                       source_routine_ids, status, sort_rank, created_at, updated_at",
        )
        .bind(&quarter)
        .bind(&area_key)
        .bind(&label)
        .bind(input.target_kind)
        .bind(input.target_value)
        .bind(unit.as_deref())
        .bind(&source_routine_ids)
        .bind(input.sort_rank)
        .fetch_one(db)
        .await?
    };
    guardrail_from_row(row)
}

pub(crate) async fn delete_guardrail_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM okr_guardrails WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn list_objective_horizon_links_inner(
    db: &Db,
    quarter: &str,
) -> Result<Vec<ObjectiveHorizonLink>, AppError> {
    let quarter = clean_required(quarter, "life_os.objective_horizon.quarter", "quarter")?;
    Ok(sqlx::query_as::<_, ObjectiveHorizonLink>(
        "SELECT l.objective_id, l.horizon_id \
           FROM objective_horizon_links l \
           JOIN objectives o ON o.id = l.objective_id \
          WHERE o.quarter = ?1 \
          ORDER BY o.sort_rank, l.horizon_id",
    )
    .bind(&quarter)
    .fetch_all(db)
    .await?)
}

pub(crate) async fn link_objective_horizon_inner(
    db: &Db,
    objective_id: &str,
    horizon_id: &str,
) -> Result<(), AppError> {
    let objective_id = clean_required(
        objective_id,
        "life_os.objective_horizon.objective_id",
        "objective id",
    )?;
    let horizon_id = clean_required(
        horizon_id,
        "life_os.objective_horizon.horizon_id",
        "horizon id",
    )?;
    sqlx::query(
        "INSERT INTO objective_horizon_links (objective_id, horizon_id) VALUES (?1, ?2) \
         ON CONFLICT(objective_id, horizon_id) DO NOTHING",
    )
    .bind(&objective_id)
    .bind(&horizon_id)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn unlink_objective_horizon_inner(
    db: &Db,
    objective_id: &str,
    horizon_id: &str,
) -> Result<(), AppError> {
    sqlx::query("DELETE FROM objective_horizon_links WHERE objective_id = ?1 AND horizon_id = ?2")
        .bind(objective_id)
        .bind(horizon_id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn selected_weekly_focus_inner(
    db: &Db,
    week_start: &str,
) -> Result<Option<WeeklyFocus>, AppError> {
    validate_date(week_start, "life_os.weekly_focus.week_start")?;
    let row = sqlx::query_as::<_, WeeklyFocusRow>(
        "SELECT id, week_start, title, source_kind, source_id, objective_id, key_result_id, \
                horizon_id, status, estimated_minutes, reason, must_do_signal_ids, \
                not_do_signal_ids, guardrail_ids, shrink_count, created_at, updated_at \
           FROM weekly_focuses \
          WHERE week_start = ?1 AND status = 'selected' \
          LIMIT 1",
    )
    .bind(week_start)
    .fetch_optional(db)
    .await?;
    row.map(weekly_focus_from_row).transpose()
}

pub(crate) async fn select_weekly_focus_inner(
    db: &Db,
    input: SelectWeeklyFocusInput,
) -> Result<WeeklyFocus, AppError> {
    validate_date(&input.week_start, "life_os.weekly_focus.week_start")?;
    let title = clean_required(
        &input.title,
        "life_os.weekly_focus.title",
        "weekly focus title",
    )?;
    let reason = clean_optional(input.reason);
    let must_do_signal_ids = serialize_string_vec(
        input.must_do_signal_ids,
        "life_os.weekly_focus.must_do.serialize",
    )?;
    let not_do_signal_ids = serialize_string_vec(
        input.not_do_signal_ids,
        "life_os.weekly_focus.not_do.serialize",
    )?;
    let guardrail_ids = serialize_string_vec(
        input.guardrail_ids,
        "life_os.weekly_focus.guardrails.serialize",
    )?;

    if let Some(existing) = selected_weekly_focus_inner(db, &input.week_start).await? {
        if !input.replace_existing {
            return Err(AppError::validation(
                "life_os.weekly_focus.conflict",
                "selected weekly focus already exists",
            ));
        }
        let row = sqlx::query_as::<_, WeeklyFocusRow>(
            "UPDATE weekly_focuses SET \
               title = ?2, source_kind = ?3, source_id = ?4, objective_id = ?5, key_result_id = ?6, \
               horizon_id = ?7, estimated_minutes = ?8, reason = ?9, must_do_signal_ids = ?10, \
               not_do_signal_ids = ?11, guardrail_ids = ?12, updated_at = datetime('now') \
             WHERE id = ?1 \
             RETURNING id, week_start, title, source_kind, source_id, objective_id, key_result_id, \
                       horizon_id, status, estimated_minutes, reason, must_do_signal_ids, \
                       not_do_signal_ids, guardrail_ids, shrink_count, created_at, updated_at",
        )
        .bind(&existing.id)
        .bind(&title)
        .bind(input.source_kind)
        .bind(input.source_id.as_deref())
        .bind(input.objective_id.as_deref())
        .bind(input.key_result_id.as_deref())
        .bind(input.horizon_id.as_deref())
        .bind(input.estimated_minutes)
        .bind(reason.as_deref())
        .bind(&must_do_signal_ids)
        .bind(&not_do_signal_ids)
        .bind(&guardrail_ids)
        .fetch_one(db)
        .await?;
        return weekly_focus_from_row(row);
    }

    let row = sqlx::query_as::<_, WeeklyFocusRow>(
        "INSERT INTO weekly_focuses \
         (id, week_start, title, source_kind, source_id, objective_id, key_result_id, horizon_id, \
          estimated_minutes, reason, must_do_signal_ids, not_do_signal_ids, guardrail_ids) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         RETURNING id, week_start, title, source_kind, source_id, objective_id, key_result_id, \
                   horizon_id, status, estimated_minutes, reason, must_do_signal_ids, \
                   not_do_signal_ids, guardrail_ids, shrink_count, created_at, updated_at",
    )
    .bind(&input.week_start)
    .bind(&title)
    .bind(input.source_kind)
    .bind(input.source_id.as_deref())
    .bind(input.objective_id.as_deref())
    .bind(input.key_result_id.as_deref())
    .bind(input.horizon_id.as_deref())
    .bind(input.estimated_minutes)
    .bind(reason.as_deref())
    .bind(&must_do_signal_ids)
    .bind(&not_do_signal_ids)
    .bind(&guardrail_ids)
    .fetch_one(db)
    .await?;
    weekly_focus_from_row(row)
}

#[derive(Debug, Clone)]
struct RecommendationDraft {
    kind: LifeOsRecommendationKind,
    title: String,
    reason: Option<String>,
    source_kind: Option<WeeklyFocusSourceKind>,
    source_id: Option<String>,
    confidence: i32,
    payload_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    signal_reviews: Vec<LifeOsSignalReview>,
}

fn recommendation_from_row(row: LifeOsRecommendationRow) -> LifeOsRecommendation {
    LifeOsRecommendation {
        id: row.id,
        snapshot_id: row.snapshot_id,
        week_start: row.week_start,
        kind: row.kind,
        title: row.title,
        reason: row.reason,
        source_kind: row.source_kind,
        source_id: row.source_id,
        confidence: row.confidence,
        payload_json: row.payload_json,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

async fn snapshot_from_row(db: &Db, row: LifeOsSnapshotRow) -> Result<LifeOsSnapshot, AppError> {
    let diagnosis = serde_json::from_str::<LifeOsDiagnosis>(&row.diagnosis_json)
        .map_err(|e| AppError::unexpected("life_os.snapshot.diagnosis.parse", e.to_string()))?;
    let payload = row
        .recommendation_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<SnapshotPayload>(raw).ok())
        .unwrap_or(SnapshotPayload {
            signal_reviews: Vec::new(),
        });
    let recommendations = list_life_os_recommendations_for_snapshot_inner(db, &row.id).await?;
    Ok(LifeOsSnapshot {
        id: row.id,
        week_start: row.week_start,
        quarter: row.quarter,
        range_start: row.range_start,
        range_end: row.range_end,
        diagnosis,
        signal_reviews: payload.signal_reviews,
        recommendations,
        source_hash: row.source_hash,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn list_life_os_recommendations_for_snapshot_inner(
    db: &Db,
    snapshot_id: &str,
) -> Result<Vec<LifeOsRecommendation>, AppError> {
    let rows = sqlx::query_as::<_, LifeOsRecommendationRow>(
        "SELECT id, snapshot_id, week_start, kind, title, reason, source_kind, source_id, \
                confidence, payload_json, status, created_at, updated_at \
           FROM life_os_recommendations \
          WHERE snapshot_id = ?1 \
          ORDER BY status, kind, created_at",
    )
    .bind(snapshot_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(recommendation_from_row).collect())
}

pub(crate) async fn list_life_os_recommendations_inner(
    db: &Db,
    week_start: &str,
) -> Result<Vec<LifeOsRecommendation>, AppError> {
    validate_date(week_start, "life_os.recommendation.week_start")?;
    let rows = sqlx::query_as::<_, LifeOsRecommendationRow>(
        "SELECT id, snapshot_id, week_start, kind, title, reason, source_kind, source_id, \
                confidence, payload_json, status, created_at, updated_at \
           FROM life_os_recommendations \
          WHERE week_start = ?1 \
          ORDER BY status, kind, created_at",
    )
    .bind(week_start)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(recommendation_from_row).collect())
}

pub(crate) async fn latest_life_os_review_inner(
    db: &Db,
    week_start: &str,
    quarter: &str,
) -> Result<Option<LifeOsSnapshot>, AppError> {
    validate_date(week_start, "life_os.snapshot.week_start")?;
    let quarter = clean_required(quarter, "life_os.snapshot.quarter", "quarter")?;
    let row = sqlx::query_as::<_, LifeOsSnapshotRow>(
        "SELECT id, week_start, quarter, range_start, range_end, diagnosis_json, \
                recommendation_json, source_hash, created_at, updated_at \
           FROM life_os_snapshots \
          WHERE week_start = ?1 AND quarter = ?2 \
          ORDER BY updated_at DESC, created_at DESC \
          LIMIT 1",
    )
    .bind(week_start)
    .bind(&quarter)
    .fetch_optional(db)
    .await?;
    match row {
        Some(row) => snapshot_from_row(db, row).await.map(Some),
        None => Ok(None),
    }
}

pub(crate) async fn generate_life_os_review_inner(
    db: &Db,
    input: GenerateLifeOsReviewInput,
) -> Result<LifeOsSnapshot, AppError> {
    validate_date(&input.week_start, "life_os.snapshot.week_start")?;
    validate_date(&input.range_start, "life_os.snapshot.range_start")?;
    validate_date(&input.range_end, "life_os.snapshot.range_end")?;
    let quarter = clean_required(&input.quarter, "life_os.snapshot.quarter", "quarter")?;

    let signals = fetch_review_signals(db, &input.range_start, &input.range_end).await?;
    let objectives = crate::commands::okr::list_objectives_inner(db, &quarter).await?;
    let guardrails = list_guardrails_inner(db, &quarter).await?;

    let mut signal_reviews = Vec::with_capacity(signals.len());
    let mut area_counts: HashMap<String, i32> = HashMap::new();
    let mut q1_count = 0;
    let mut q2_count = 0;
    let mut q3_count = 0;
    let mut q4_count = 0;
    let mut unclassified_count = 0;
    let mut guardrail_risk_count = 0;

    for signal in &signals {
        let review = review_signal(signal, &objectives, &guardrails);
        *area_counts.entry(review.area_key.clone()).or_insert(0) += 1;
        match review.quadrant_hint.as_deref() {
            Some("q1_do_now") => q1_count += 1,
            Some("q2_schedule") => q2_count += 1,
            Some("q3_quick_contain") => q3_count += 1,
            Some("q4_drop") => q4_count += 1,
            _ => unclassified_count += 1,
        }
        if review.guardrail_risk {
            guardrail_risk_count += 1;
        }
        signal_reviews.push(review);
    }

    let dominant_area_key = area_counts
        .into_iter()
        .max_by_key(|(_, count)| *count)
        .map(|(area, _)| area);
    let diagnosis = LifeOsDiagnosis {
        q1_count,
        q2_count,
        q3_count,
        q4_count,
        unclassified_count,
        guardrail_risk_count,
        dominant_area_key,
        method: "local_rules_v1".into(),
    };
    let drafts =
        build_recommendations(&input.week_start, &signal_reviews, &objectives, &guardrails);
    let source_hash = source_hash(&signals, &objectives, &guardrails, &diagnosis)?;
    let diagnosis_json = serde_json::to_string(&diagnosis)
        .map_err(|e| AppError::unexpected("life_os.snapshot.diagnosis.serialize", e.to_string()))?;
    let payload_json = serde_json::to_string(&SnapshotPayload {
        signal_reviews: signal_reviews.clone(),
    })
    .map_err(|e| AppError::unexpected("life_os.snapshot.payload.serialize", e.to_string()))?;

    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, LifeOsSnapshotRow>(
        "INSERT INTO life_os_snapshots \
         (id, week_start, quarter, range_start, range_end, diagnosis_json, recommendation_json, source_hash) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(week_start, quarter, source_hash) DO UPDATE SET \
           range_start = excluded.range_start, range_end = excluded.range_end, \
           diagnosis_json = excluded.diagnosis_json, recommendation_json = excluded.recommendation_json, \
           updated_at = datetime('now') \
         RETURNING id, week_start, quarter, range_start, range_end, diagnosis_json, \
                   recommendation_json, source_hash, created_at, updated_at",
    )
    .bind(&input.week_start)
    .bind(&quarter)
    .bind(&input.range_start)
    .bind(&input.range_end)
    .bind(&diagnosis_json)
    .bind(&payload_json)
    .bind(&source_hash)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM life_os_recommendations WHERE snapshot_id = ?1 AND status = 'proposed'",
    )
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    for draft in drafts {
        insert_recommendation(&mut tx, &row.id, &input.week_start, draft).await?;
    }
    tx.commit().await?;
    snapshot_from_row(db, row).await
}

pub(crate) async fn accept_life_os_recommendation_inner(
    db: &Db,
    input: AcceptLifeOsRecommendationInput,
) -> Result<WeeklyFocus, AppError> {
    let recommendation = fetch_recommendation(db, &input.recommendation_id).await?;
    let focus = select_weekly_focus_inner(
        db,
        SelectWeeklyFocusInput {
            week_start: recommendation.week_start.clone(),
            title: recommendation.title.clone(),
            source_kind: recommendation
                .source_kind
                .unwrap_or(WeeklyFocusSourceKind::Pattern),
            source_id: recommendation
                .source_id
                .clone()
                .or_else(|| Some(recommendation.id.clone())),
            objective_id: if matches!(
                recommendation.source_kind,
                Some(WeeklyFocusSourceKind::Objective)
            ) {
                recommendation.source_id.clone()
            } else {
                None
            },
            key_result_id: if matches!(
                recommendation.source_kind,
                Some(WeeklyFocusSourceKind::KeyResult)
            ) {
                recommendation.source_id.clone()
            } else {
                None
            },
            horizon_id: if matches!(
                recommendation.source_kind,
                Some(WeeklyFocusSourceKind::Horizon)
            ) {
                recommendation.source_id.clone()
            } else {
                None
            },
            estimated_minutes: Some(90),
            reason: recommendation.reason.clone(),
            must_do_signal_ids: payload_signal_ids(&recommendation.payload_json, "mustDoSignalIds"),
            not_do_signal_ids: payload_signal_ids(&recommendation.payload_json, "notDoSignalIds"),
            guardrail_ids: payload_signal_ids(&recommendation.payload_json, "guardrailIds"),
            replace_existing: input.replace_existing,
        },
    )
    .await?;
    sqlx::query(
        "UPDATE life_os_recommendations SET status = 'accepted', updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(&recommendation.id)
    .execute(db)
    .await?;
    Ok(focus)
}

pub(crate) async fn dismiss_life_os_recommendation_inner(
    db: &Db,
    input: DismissLifeOsRecommendationInput,
) -> Result<LifeOsRecommendation, AppError> {
    let note = clean_optional(input.reason);
    let row = sqlx::query_as::<_, LifeOsRecommendationRow>(
        "UPDATE life_os_recommendations SET \
           status = 'dismissed', reason = COALESCE(?2, reason), updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING id, snapshot_id, week_start, kind, title, reason, source_kind, source_id, \
                   confidence, payload_json, status, created_at, updated_at",
    )
    .bind(&input.recommendation_id)
    .bind(note.as_deref())
    .fetch_one(db)
    .await?;
    Ok(recommendation_from_row(row))
}

pub(crate) async fn record_life_os_audit_event_inner(
    db: &Db,
    input: RecordLifeOsAuditInput,
) -> Result<LifeOsAuditEvent, AppError> {
    validate_date(&input.week_start, "life_os.audit.week_start")?;
    let target_id = clean_required(&input.target_id, "life_os.audit.target_id", "target id")?;
    let note = clean_optional(input.note);
    let event = sqlx::query_as::<_, LifeOsAuditEvent>(
        "INSERT INTO life_os_audit_events \
         (id, week_start, target_kind, target_id, outcome, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5) \
         RETURNING id, week_start, target_kind, target_id, outcome, note, created_at",
    )
    .bind(&input.week_start)
    .bind(input.target_kind)
    .bind(&target_id)
    .bind(input.outcome)
    .bind(note.as_deref())
    .fetch_one(db)
    .await?;
    if matches!(
        event.target_kind,
        crate::models::LifeOsTargetKind::WeeklyFocus
    ) && matches!(event.outcome, crate::models::LifeOsAuditOutcome::TooLarge)
    {
        sqlx::query("UPDATE weekly_focuses SET shrink_count = shrink_count + 1, updated_at = datetime('now') WHERE id = ?1")
            .bind(&event.target_id)
            .execute(db)
            .await?;
    }
    Ok(event)
}

pub(crate) async fn list_life_os_audit_events_inner(
    db: &Db,
    week_start: &str,
) -> Result<Vec<LifeOsAuditEvent>, AppError> {
    validate_date(week_start, "life_os.audit.week_start")?;
    Ok(sqlx::query_as::<_, LifeOsAuditEvent>(
        "SELECT id, week_start, target_kind, target_id, outcome, note, created_at \
           FROM life_os_audit_events \
          WHERE week_start = ?1 \
          ORDER BY created_at DESC",
    )
    .bind(week_start)
    .fetch_all(db)
    .await?)
}

async fn fetch_recommendation(db: &Db, id: &str) -> Result<LifeOsRecommendation, AppError> {
    let id = clean_required(id, "life_os.recommendation.id", "recommendation id")?;
    let row = sqlx::query_as::<_, LifeOsRecommendationRow>(
        "SELECT id, snapshot_id, week_start, kind, title, reason, source_kind, source_id, \
                confidence, payload_json, status, created_at, updated_at \
           FROM life_os_recommendations \
          WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(db)
    .await?;
    Ok(recommendation_from_row(row))
}

async fn fetch_review_signals(
    db: &Db,
    range_start: &str,
    range_end: &str,
) -> Result<Vec<WorkSignal>, AppError> {
    Ok(sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {} FROM signals \
          WHERE status NOT IN ('done','archived') \
            AND (substr(created_at, 1, 10) BETWEEN ?1 AND ?2 \
              OR substr(updated_at, 1, 10) BETWEEN ?1 AND ?2 \
              OR today_for_date BETWEEN ?1 AND ?2) \
          ORDER BY updated_at DESC, created_at DESC \
          LIMIT 80",
        crate::commands::signal_store::SIGNAL_COLS
    ))
    .bind(range_start)
    .bind(range_end)
    .fetch_all(db)
    .await?)
}

async fn insert_recommendation(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    snapshot_id: &str,
    week_start: &str,
    draft: RecommendationDraft,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO life_os_recommendations \
         (id, snapshot_id, week_start, kind, title, reason, source_kind, source_id, confidence, payload_json) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(snapshot_id)
    .bind(week_start)
    .bind(draft.kind)
    .bind(&draft.title)
    .bind(draft.reason.as_deref())
    .bind(draft.source_kind)
    .bind(draft.source_id.as_deref())
    .bind(draft.confidence)
    .bind(&draft.payload_json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn review_signal(
    signal: &WorkSignal,
    objectives: &[Objective],
    guardrails: &[OkrGuardrail],
) -> LifeOsSignalReview {
    let text = format!(
        "{} {}",
        signal.title.to_lowercase(),
        signal.body.clone().unwrap_or_default().to_lowercase()
    );
    let area_key = signal
        .area
        .or(signal.suggested_area)
        .map(AreaTag::as_key)
        .unwrap_or_else(|| infer_area_key(&text, signal.kind).as_key())
        .to_string();
    let quadrant_hint = quadrant_hint(signal, &text);
    let okr_relevant = objectives
        .iter()
        .any(|objective| objective_relevant(objective, &area_key, &text));
    let guardrail_risk = guardrails
        .iter()
        .any(|guardrail| guardrail.area_key == area_key);
    let one_thing_candidate = matches!(quadrant_hint.as_deref(), Some("q2_schedule"))
        && okr_relevant
        || text.contains("자동화")
        || text.contains("반복");
    let processing_action = match quadrant_hint.as_deref() {
        Some("q1_do_now") => "today",
        Some("q2_schedule") if one_thing_candidate => "one_thing_candidate",
        Some("q2_schedule") => "schedule",
        Some("q3_quick_contain") => "delegate",
        Some("q4_drop") => "drop",
        _ => "hold",
    }
    .to_string();
    let reason = if okr_relevant {
        "분기 OKR과 연결되는 후보"
    } else if guardrail_risk {
        "가드레일 위험 신호"
    } else {
        "최근 브레인덤프 패턴 기반 힌트"
    }
    .to_string();
    LifeOsSignalReview {
        signal_id: signal.id.clone(),
        title: signal.title.clone(),
        area_key,
        quadrant_hint,
        okr_relevant,
        guardrail_risk,
        one_thing_candidate,
        processing_action,
        reason,
    }
}

fn build_recommendations(
    week_start: &str,
    reviews: &[LifeOsSignalReview],
    objectives: &[Objective],
    guardrails: &[OkrGuardrail],
) -> Vec<RecommendationDraft> {
    let mut out = Vec::new();
    let one_thing = reviews.iter().find(|review| review.one_thing_candidate);
    let active_objective = objectives
        .iter()
        .find(|objective| matches!(objective.status, ObjectiveStatus::Active));
    let weekly_title = one_thing
        .map(|review| review.title.clone())
        .or_else(|| active_objective.map(|objective| objective.title.clone()))
        .unwrap_or_else(|| "반복되는 긴급 업무 원인 1개 제거".into());
    let source_kind = one_thing
        .map(|_| WeeklyFocusSourceKind::Signal)
        .or(active_objective.map(|_| WeeklyFocusSourceKind::Objective))
        .or(Some(WeeklyFocusSourceKind::Pattern));
    let source_id = one_thing
        .map(|review| review.signal_id.clone())
        .or_else(|| active_objective.map(|objective| objective.id.clone()));
    out.push(RecommendationDraft {
        kind: LifeOsRecommendationKind::WeeklyFocus,
        title: weekly_title,
        reason: Some(format!("{week_start} 주간 OKR/브레인덤프 기반 도미노 후보")),
        source_kind,
        source_id,
        confidence: 72,
        payload_json: serde_json::json!({
            "mustDoSignalIds": one_thing.map(|review| vec![review.signal_id.clone()]).unwrap_or_default(),
            "notDoSignalIds": [],
            "guardrailIds": []
        })
        .to_string(),
    });

    let q1_count = reviews
        .iter()
        .filter(|review| review.quadrant_hint.as_deref() == Some("q1_do_now"))
        .count();
    if q1_count >= 2 {
        out.push(RecommendationDraft {
            kind: LifeOsRecommendationKind::Q1Prevention,
            title: "반복 긴급 업무의 유입 경로 하나 막기".into(),
            reason: Some("중요+긴급 힌트가 반복되어 예방 과제가 필요합니다.".into()),
            source_kind: Some(WeeklyFocusSourceKind::Pattern),
            source_id: None,
            confidence: 68,
            payload_json: serde_json::json!({ "mustDoSignalIds": [], "notDoSignalIds": [], "guardrailIds": [] }).to_string(),
        });
    }

    let q3_count = reviews
        .iter()
        .filter(|review| review.quadrant_hint.as_deref() == Some("q3_quick_contain"))
        .count();
    if q3_count >= 2 {
        out.push(RecommendationDraft {
            kind: LifeOsRecommendationKind::Q3Containment,
            title: "요청 대응 템플릿/일괄 처리 슬롯 만들기".into(),
            reason: Some("안 중요+긴급 힌트가 많아 직접 처리량을 줄여야 합니다.".into()),
            source_kind: Some(WeeklyFocusSourceKind::Pattern),
            source_id: None,
            confidence: 64,
            payload_json: serde_json::json!({ "mustDoSignalIds": [], "notDoSignalIds": [], "guardrailIds": [] }).to_string(),
        });
    }

    if let Some(guardrail) = guardrails.iter().find(|guardrail| {
        reviews
            .iter()
            .any(|review| review.area_key == guardrail.area_key && review.guardrail_risk)
    }) {
        out.push(RecommendationDraft {
            kind: LifeOsRecommendationKind::GuardrailRecovery,
            title: format!("가드레일 복구: {}", guardrail.label),
            reason: Some("Life Wheel 방어선과 연결된 방치 신호가 있습니다.".into()),
            source_kind: Some(WeeklyFocusSourceKind::Pattern),
            source_id: Some(guardrail.id.clone()),
            confidence: 70,
            payload_json: serde_json::json!({
                "mustDoSignalIds": [],
                "notDoSignalIds": [],
                "guardrailIds": [guardrail.id]
            })
            .to_string(),
        });
    }

    let unclassified = reviews
        .iter()
        .filter(|review| review.processing_action == "hold")
        .count();
    if unclassified >= 3 {
        out.push(RecommendationDraft {
            kind: LifeOsRecommendationKind::DecisionTask,
            title: "미결정 브레인덤프 3개를 30분 결정 과제로 묶기".into(),
            reason: Some("보류 힌트가 누적되어 저장소가 아니라 결정 과제가 필요합니다.".into()),
            source_kind: Some(WeeklyFocusSourceKind::Pattern),
            source_id: None,
            confidence: 62,
            payload_json: serde_json::json!({ "mustDoSignalIds": [], "notDoSignalIds": [], "guardrailIds": [] }).to_string(),
        });
    }
    out
}

fn infer_area_key(text: &str, kind: Option<crate::models::Kind>) -> AreaTag {
    if contains_any(text, &["운동", "건강", "수면", "병원", "치과"]) {
        AreaTag::Health
    } else if contains_any(text, &["가족", "아이", "아내", "부모"]) {
        AreaTag::Family
    } else if contains_any(text, &["돈", "예산", "세금", "결제", "카드"]) {
        AreaTag::Finances
    } else if contains_any(text, &["학습", "공부", "책", "읽"]) {
        AreaTag::Studies
    } else if matches!(kind, Some(crate::models::Kind::Work))
        || contains_any(
            text,
            &[
                "대표",
                "팀",
                "보고",
                "요청",
                "업무",
                "프로젝트",
                "pr",
                "자동화",
            ],
        )
    {
        AreaTag::Work
    } else {
        AreaTag::Other
    }
}

fn quadrant_hint(signal: &WorkSignal, text: &str) -> Option<String> {
    if !matches!(signal.quadrant, Quadrant::Unclassified) {
        return Some(quadrant_key(signal.quadrant).to_string());
    }
    if let Some(raw) = signal.suggested_quadrant.as_deref() {
        if matches!(
            raw,
            "q1_do_now" | "q2_schedule" | "q3_quick_contain" | "q4_drop"
        ) {
            return Some(raw.to_string());
        }
    }
    if contains_any(text, &["긴급", "오늘", "마감", "대표", "당장"]) {
        Some("q1_do_now".into())
    } else if contains_any(
        text,
        &["자동화", "반복", "운동", "루틴", "설계", "okr", "학습"],
    ) {
        Some("q2_schedule".into())
    } else if contains_any(text, &["메일", "확인", "답장", "요청"]) {
        Some("q3_quick_contain".into())
    } else if contains_any(text, &["유튜브", "충동", "리서치만"]) {
        Some("q4_drop".into())
    } else {
        None
    }
}

fn quadrant_key(quadrant: Quadrant) -> &'static str {
    match quadrant {
        Quadrant::Q1DoNow => "q1_do_now",
        Quadrant::Q2Schedule => "q2_schedule",
        Quadrant::Q3QuickContain => "q3_quick_contain",
        Quadrant::Q4Drop => "q4_drop",
        Quadrant::Unclassified => "unclassified",
    }
}

fn objective_relevant(objective: &Objective, area_key: &str, text: &str) -> bool {
    objective
        .linked_area_keys
        .iter()
        .any(|area| area == area_key)
        || contains_any(
            text,
            &objective
                .title
                .split_whitespace()
                .filter(|token| token.chars().count() >= 2)
                .collect::<Vec<_>>(),
        )
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn source_hash(
    signals: &[WorkSignal],
    objectives: &[Objective],
    guardrails: &[OkrGuardrail],
    diagnosis: &LifeOsDiagnosis,
) -> Result<String, AppError> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for signal in signals {
        signal.id.hash(&mut hasher);
        signal.updated_at.hash(&mut hasher);
        signal.title.hash(&mut hasher);
    }
    for objective in objectives {
        objective.id.hash(&mut hasher);
        objective.updated_at.hash(&mut hasher);
        objective.title.hash(&mut hasher);
    }
    for guardrail in guardrails {
        guardrail.id.hash(&mut hasher);
        guardrail.updated_at.hash(&mut hasher);
        guardrail.label.hash(&mut hasher);
    }
    serde_json::to_string(diagnosis)
        .map_err(|e| AppError::unexpected("life_os.source_hash", e.to_string()))?
        .hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn payload_signal_ids(payload_json: &str, key: &str) -> Vec<String> {
    serde_json::from_str::<serde_json::Value>(payload_json)
        .ok()
        .and_then(|value| value.get(key).and_then(|item| item.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

#[tauri::command]
#[specta::specta]
pub async fn list_mission_horizons(db: State<'_, Db>) -> Result<Vec<MissionHorizon>, AppError> {
    list_mission_horizons_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_mission_horizon(
    db: State<'_, Db>,
    input: CreateMissionHorizonInput,
) -> Result<MissionHorizon, AppError> {
    create_mission_horizon_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_mission_horizon(
    db: State<'_, Db>,
    input: UpdateMissionHorizonInput,
) -> Result<MissionHorizon, AppError> {
    update_mission_horizon_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_mission_horizon(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_mission_horizon_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_guardrails(
    db: State<'_, Db>,
    quarter: String,
) -> Result<Vec<OkrGuardrail>, AppError> {
    list_guardrails_inner(db.inner(), &quarter).await
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_guardrail(
    db: State<'_, Db>,
    input: UpsertGuardrailInput,
) -> Result<OkrGuardrail, AppError> {
    upsert_guardrail_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_guardrail(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_guardrail_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_objective_horizon_links(
    db: State<'_, Db>,
    quarter: String,
) -> Result<Vec<ObjectiveHorizonLink>, AppError> {
    list_objective_horizon_links_inner(db.inner(), &quarter).await
}

#[tauri::command]
#[specta::specta]
pub async fn link_objective_horizon(
    db: State<'_, Db>,
    objective_id: String,
    horizon_id: String,
) -> Result<(), AppError> {
    link_objective_horizon_inner(db.inner(), &objective_id, &horizon_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn unlink_objective_horizon(
    db: State<'_, Db>,
    objective_id: String,
    horizon_id: String,
) -> Result<(), AppError> {
    unlink_objective_horizon_inner(db.inner(), &objective_id, &horizon_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn selected_weekly_focus(
    db: State<'_, Db>,
    week_start: String,
) -> Result<Option<WeeklyFocus>, AppError> {
    selected_weekly_focus_inner(db.inner(), &week_start).await
}

#[tauri::command]
#[specta::specta]
pub async fn select_weekly_focus(
    db: State<'_, Db>,
    input: SelectWeeklyFocusInput,
) -> Result<WeeklyFocus, AppError> {
    select_weekly_focus_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn latest_life_os_review(
    db: State<'_, Db>,
    week_start: String,
    quarter: String,
) -> Result<Option<LifeOsSnapshot>, AppError> {
    latest_life_os_review_inner(db.inner(), &week_start, &quarter).await
}

#[tauri::command]
#[specta::specta]
pub async fn generate_life_os_review(
    db: State<'_, Db>,
    input: GenerateLifeOsReviewInput,
) -> Result<LifeOsSnapshot, AppError> {
    generate_life_os_review_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_life_os_recommendations(
    db: State<'_, Db>,
    week_start: String,
) -> Result<Vec<LifeOsRecommendation>, AppError> {
    list_life_os_recommendations_inner(db.inner(), &week_start).await
}

#[tauri::command]
#[specta::specta]
pub async fn accept_life_os_recommendation(
    db: State<'_, Db>,
    input: AcceptLifeOsRecommendationInput,
) -> Result<WeeklyFocus, AppError> {
    accept_life_os_recommendation_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn dismiss_life_os_recommendation(
    db: State<'_, Db>,
    input: DismissLifeOsRecommendationInput,
) -> Result<LifeOsRecommendation, AppError> {
    dismiss_life_os_recommendation_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn record_life_os_audit_event(
    db: State<'_, Db>,
    input: RecordLifeOsAuditInput,
) -> Result<LifeOsAuditEvent, AppError> {
    record_life_os_audit_event_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_life_os_audit_events(
    db: State<'_, Db>,
    week_start: String,
) -> Result<Vec<LifeOsAuditEvent>, AppError> {
    list_life_os_audit_events_inner(db.inner(), &week_start).await
}

#[cfg(test)]
mod tests {
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{
        AcceptLifeOsRecommendationInput, CreateMissionHorizonInput, CreateObjectiveInput,
        CreateSignalInput, GenerateLifeOsReviewInput, GuardrailTargetKind, Kind,
        LifeOsAuditOutcome, LifeOsRecommendationKind, LifeOsRecommendationStatus, LifeOsTargetKind,
        MissionHorizonKind, RecordLifeOsAuditInput, SelectWeeklyFocusInput, WeeklyFocusSourceKind,
        WscKind,
    };

    #[tokio::test]
    async fn life_os_migrations_create_core_tables() {
        let db = fresh_db().await;
        for table in [
            "mission_horizons",
            "objective_horizon_links",
            "okr_guardrails",
            "weekly_focuses",
            "sprint_cycles",
            "life_os_snapshots",
            "life_os_dismissals",
        ] {
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
    async fn horizon_and_guardrail_crud_round_trip() {
        let db = fresh_db().await;

        let horizon = super::create_mission_horizon_inner(
            &db,
            CreateMissionHorizonInput {
                title: "Build a calmer operating system".into(),
                description: Some("Long-term direction".into()),
                horizon_kind: MissionHorizonKind::ThreeYear,
                wsc_kind: Some(WscKind::W),
                area_keys: vec!["work".into(), "health".into(), "work".into()],
                sort_rank: 2,
            },
        )
        .await
        .unwrap();
        assert_eq!(horizon.title, "Build a calmer operating system");
        assert_eq!(horizon.area_keys, vec!["work", "health"]);

        let horizons = super::list_mission_horizons_inner(&db).await.unwrap();
        assert_eq!(horizons.len(), 1);
        assert_eq!(horizons[0].id, horizon.id);

        let guardrail = super::upsert_guardrail_inner(
            &db,
            crate::models::UpsertGuardrailInput {
                id: None,
                quarter: "2026-Q3".into(),
                area_key: "health".into(),
                label: "주 3회 운동".into(),
                target_kind: GuardrailTargetKind::RoutineCount,
                target_value: Some(3.0),
                unit: Some("회".into()),
                source_routine_ids: vec!["routine-1".into(), "routine-1".into()],
                sort_rank: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(guardrail.source_routine_ids, vec!["routine-1"]);

        let guardrails = super::list_guardrails_inner(&db, "2026-Q3").await.unwrap();
        assert_eq!(guardrails.len(), 1);
        assert_eq!(guardrails[0].id, guardrail.id);
    }

    #[tokio::test]
    async fn objective_horizon_links_round_trip_and_cascade() {
        let db = fresh_db().await;
        let objective = crate::commands::okr::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: "2026-Q3".into(),
                title: "Stabilize weekly operations".into(),
                description: None,
                sort_rank: 0,
                linked_area_keys: vec![],
                linked_project_ids: vec![],
            },
        )
        .await
        .unwrap();
        let horizon = super::create_mission_horizon_inner(
            &db,
            CreateMissionHorizonInput {
                title: "Operate calmly at scale".into(),
                description: None,
                horizon_kind: MissionHorizonKind::OneYear,
                wsc_kind: Some(WscKind::S),
                area_keys: vec!["work".into()],
                sort_rank: 0,
            },
        )
        .await
        .unwrap();

        super::link_objective_horizon_inner(&db, &objective.id, &horizon.id)
            .await
            .unwrap();
        super::link_objective_horizon_inner(&db, &objective.id, &horizon.id)
            .await
            .unwrap();
        let links = super::list_objective_horizon_links_inner(&db, "2026-Q3")
            .await
            .unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].objective_id, objective.id);
        assert_eq!(links[0].horizon_id, horizon.id);

        crate::commands::okr::delete_objective_inner(&db, &objective.id)
            .await
            .unwrap();
        let remaining = super::list_objective_horizon_links_inner(&db, "2026-Q3")
            .await
            .unwrap();
        assert!(
            remaining.is_empty(),
            "objective delete should cascade links"
        );
    }

    #[tokio::test]
    async fn selected_weekly_focus_has_one_selected_row_per_week() {
        let db = fresh_db().await;
        let first = super::select_weekly_focus_inner(
            &db,
            SelectWeeklyFocusInput {
                week_start: "2026-07-06".into(),
                title: "Manual weekly focus".into(),
                source_kind: WeeklyFocusSourceKind::Manual,
                source_id: None,
                objective_id: None,
                key_result_id: None,
                horizon_id: None,
                estimated_minutes: Some(90),
                reason: Some("Chosen in review".into()),
                must_do_signal_ids: vec![],
                not_do_signal_ids: vec![],
                guardrail_ids: vec![],
                replace_existing: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(first.title, "Manual weekly focus");

        let conflict = super::select_weekly_focus_inner(
            &db,
            SelectWeeklyFocusInput {
                week_start: "2026-07-06".into(),
                title: "Second focus".into(),
                source_kind: WeeklyFocusSourceKind::Manual,
                source_id: None,
                objective_id: None,
                key_result_id: None,
                horizon_id: None,
                estimated_minutes: None,
                reason: None,
                must_do_signal_ids: vec![],
                not_do_signal_ids: vec![],
                guardrail_ids: vec![],
                replace_existing: false,
            },
        )
        .await;
        assert!(
            conflict.is_err(),
            "selected focus needs explicit replacement"
        );

        let replaced = super::select_weekly_focus_inner(
            &db,
            SelectWeeklyFocusInput {
                week_start: "2026-07-06".into(),
                title: "Second focus".into(),
                source_kind: WeeklyFocusSourceKind::Manual,
                source_id: None,
                objective_id: None,
                key_result_id: None,
                horizon_id: None,
                estimated_minutes: None,
                reason: None,
                must_do_signal_ids: vec![],
                not_do_signal_ids: vec![],
                guardrail_ids: vec![],
                replace_existing: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(replaced.id, first.id);
        assert_eq!(replaced.title, "Second focus");
    }

    #[tokio::test]
    async fn generated_review_persists_ai_recommendations_without_deciding_cards() {
        let db = fresh_db().await;
        crate::commands::okr::create_objective_inner(
            &db,
            CreateObjectiveInput {
                quarter: "2026-Q3".into(),
                title: "업무 자동화로 긴급 대응 줄이기".into(),
                description: None,
                sort_rank: 0,
                linked_area_keys: vec!["work".into()],
                linked_project_ids: vec![],
            },
        )
        .await
        .unwrap();
        super::upsert_guardrail_inner(
            &db,
            crate::models::UpsertGuardrailInput {
                id: None,
                quarter: "2026-Q3".into(),
                area_key: "health".into(),
                label: "주 3회 운동".into(),
                target_kind: GuardrailTargetKind::RoutineCount,
                target_value: Some(3.0),
                unit: Some("회".into()),
                source_routine_ids: vec![],
                sort_rank: 0,
            },
        )
        .await
        .unwrap();
        let urgent = crate::commands::signal_store::insert_signal(
            &db,
            &CreateSignalInput {
                title: "대표님 요청 자료 긴급 정리".into(),
                kind: Some(Kind::Work),
                project_id: None,
            },
        )
        .await
        .unwrap();
        crate::commands::signal_store::insert_signal(
            &db,
            &CreateSignalInput {
                title: "운동 계속 밀림".into(),
                kind: Some(Kind::Personal),
                project_id: None,
            },
        )
        .await
        .unwrap();
        crate::commands::signal_store::insert_signal(
            &db,
            &CreateSignalInput {
                title: "반복 보고 자동화 설계".into(),
                kind: Some(Kind::Work),
                project_id: None,
            },
        )
        .await
        .unwrap();

        let review = super::generate_life_os_review_inner(
            &db,
            GenerateLifeOsReviewInput {
                week_start: "2026-06-29".into(),
                quarter: "2026-Q3".into(),
                range_start: "2026-06-29".into(),
                range_end: "2026-07-05".into(),
            },
        )
        .await
        .unwrap();

        assert_eq!(review.week_start, "2026-06-29");
        assert!(
            review
                .signal_reviews
                .iter()
                .any(|item| item.signal_id == urgent.id
                    && item.quadrant_hint.as_deref() == Some("q1_do_now")
                    && item.processing_action == "today"),
            "review should produce AI hints without changing the card"
        );
        let quadrant_after: (crate::models::Quadrant,) =
            sqlx::query_as("SELECT quadrant FROM signals WHERE id = ?1")
                .bind(&urgent.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            quadrant_after.0,
            crate::models::Quadrant::Unclassified,
            "Life OS review must not decide the matrix"
        );
        assert!(review.recommendations.iter().any(|recommendation| {
            recommendation.kind == LifeOsRecommendationKind::WeeklyFocus
                && recommendation.status == LifeOsRecommendationStatus::Proposed
        }));
        assert!(review.recommendations.iter().any(|recommendation| {
            recommendation.kind == LifeOsRecommendationKind::GuardrailRecovery
        }));

        let stored = super::list_life_os_recommendations_inner(&db, "2026-06-29")
            .await
            .unwrap();
        assert_eq!(stored.len(), review.recommendations.len());
    }

    #[tokio::test]
    async fn recommendation_accept_and_audit_round_trip() {
        let db = fresh_db().await;
        let review = super::generate_life_os_review_inner(
            &db,
            GenerateLifeOsReviewInput {
                week_start: "2026-06-29".into(),
                quarter: "2026-Q3".into(),
                range_start: "2026-06-29".into(),
                range_end: "2026-07-05".into(),
            },
        )
        .await
        .unwrap();
        let recommendation = review
            .recommendations
            .iter()
            .find(|item| item.kind == LifeOsRecommendationKind::WeeklyFocus)
            .expect("weekly focus recommendation");

        let focus = super::accept_life_os_recommendation_inner(
            &db,
            AcceptLifeOsRecommendationInput {
                recommendation_id: recommendation.id.clone(),
                replace_existing: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(focus.title, recommendation.title);

        let audit = super::record_life_os_audit_event_inner(
            &db,
            RecordLifeOsAuditInput {
                week_start: "2026-06-29".into(),
                target_kind: LifeOsTargetKind::WeeklyFocus,
                target_id: focus.id.clone(),
                outcome: LifeOsAuditOutcome::TooLarge,
                note: Some("90분 단위로 줄여야 함".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(audit.target_id, focus.id);

        let events = super::list_life_os_audit_events_inner(&db, "2026-06-29")
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].outcome, LifeOsAuditOutcome::TooLarge);
    }
}
