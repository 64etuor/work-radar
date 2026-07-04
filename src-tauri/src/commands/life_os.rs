// AppError is intentionally the IPC envelope for all local Life OS writes.
#![allow(clippy::result_large_err)]

use chrono::NaiveDate;
use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    CreateMissionHorizonInput, GuardrailTargetKind, LifeOsRecordStatus, MissionHorizon,
    MissionHorizonKind, ObjectiveHorizonLink, OkrGuardrail, SelectWeeklyFocusInput,
    UpdateMissionHorizonInput, UpsertGuardrailInput, WeeklyFocus, WeeklyFocusSourceKind,
    WeeklyFocusStatus, WscKind,
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

#[cfg(test)]
mod tests {
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{
        CreateMissionHorizonInput, CreateObjectiveInput, GuardrailTargetKind, MissionHorizonKind,
        SelectWeeklyFocusInput, WeeklyFocusSourceKind, WscKind,
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
}
