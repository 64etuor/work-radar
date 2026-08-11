//! 운동 세션 + 세트 — "했다"는 관측 사실만. 계획 표면은 없다(routines가 소유).
//!
//! 볼륨·1RM·소모 kcal은 저장하지 않고 조회 시 커널이 계산한다. 소모 kcal은 **그 날 체중**
//! (없으면 그 이전 최근 측정)을 쓴다 — 지금 체중으로 과거 세션을 재계산하면 이력이 흔들린다.

#![allow(clippy::result_large_err)]

use sqlx::SqliteConnection;
use tauri::State;

use super::{clean_optional, new_id, validate_date, validate_positive, validate_range};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    AddWorkoutSetInput, ExerciseModality, ExercisePersonalRecord, ExerciseVolumeRow,
    PatchWorkoutSessionInput, PatchWorkoutSetInput, StartWorkoutSessionInput, WorkoutSession,
    WorkoutSessionField, WorkoutSet, WorkoutSetField, WorkoutVolumeSummary,
};
use crate::workout::{self, VolumeSet};

#[derive(Debug, sqlx::FromRow)]
struct SessionRow {
    id: String,
    date: String,
    started_at: Option<String>,
    ended_at: Option<String>,
    title: Option<String>,
    perceived_exertion: Option<i32>,
    note: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct SetRow {
    id: String,
    session_id: String,
    exercise_id: String,
    exercise_name: String,
    modality: ExerciseModality,
    met: Option<f64>,
    sort_rank: i32,
    reps: Option<i32>,
    weight_kg: Option<f64>,
    duration_sec: Option<i32>,
    distance_m: Option<f64>,
    rest_sec: Option<i32>,
    rpe: Option<i32>,
    note: Option<String>,
}

const SESSION_COLS: &str = "id, date, started_at, ended_at, title, perceived_exertion, note, \
                            created_at, updated_at";

const SET_SELECT: &str = "SELECT s.id, s.session_id, s.exercise_id, e.name AS exercise_name, \
                                 e.modality, e.met, s.sort_rank, s.reps, s.weight_kg, \
                                 s.duration_sec, s.distance_m, s.rest_sec, s.rpe, s.note \
                            FROM workout_sets s JOIN exercises e ON e.id = s.exercise_id";

fn volume_input(rows: &[SetRow]) -> Vec<VolumeSet> {
    rows.iter()
        .map(|r| VolumeSet {
            reps: r.reps,
            weight_kg: r.weight_kg,
            duration_sec: r.duration_sec,
            distance_m: r.distance_m,
        })
        .collect()
}

/// 그 날(또는 그 이전 최근) 측정 체중. 소모 kcal 계산의 입력 — 미래 측정치를 끌어오지 않는다.
pub(crate) async fn weight_on_or_before(
    conn: &mut SqliteConnection,
    date: &str,
) -> Result<Option<f64>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT weight_kg FROM body_metrics \
          WHERE measured_on <= ?1 AND weight_kg IS NOT NULL \
          ORDER BY measured_on DESC LIMIT 1",
    )
    .bind(date)
    .fetch_optional(&mut *conn)
    .await?
    .flatten())
}

fn energy_for(rows: &[SetRow], weight_kg: Option<f64>) -> f64 {
    rows.iter()
        .map(|r| workout::energy_burned_kcal(r.met, weight_kg, r.duration_sec.unwrap_or(0)))
        .sum()
}

fn to_sets(rows: Vec<SetRow>) -> Vec<WorkoutSet> {
    rows.into_iter()
        .enumerate()
        .map(|(idx, r)| WorkoutSet {
            estimated_1rm_kg: workout::estimated_1rm(r.reps, r.weight_kg),
            id: r.id,
            session_id: r.session_id,
            exercise_id: r.exercise_id,
            exercise_name: r.exercise_name,
            modality: r.modality,
            set_no: idx as i32 + 1,
            sort_rank: r.sort_rank,
            reps: r.reps,
            weight_kg: r.weight_kg,
            duration_sec: r.duration_sec,
            distance_m: r.distance_m,
            rest_sec: r.rest_sec,
            rpe: r.rpe,
            note: r.note,
        })
        .collect()
}

pub(crate) async fn fetch_session(db: &Db, id: &str) -> Result<WorkoutSession, AppError> {
    let mut conn = db.acquire().await?;
    let row = sqlx::query_as::<_, SessionRow>(&format!(
        "SELECT {SESSION_COLS} FROM workout_sessions WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::not_found("workout.session.missing", "workout session not found"))?;

    let rows = sqlx::query_as::<_, SetRow>(&format!(
        "{SET_SELECT} WHERE s.session_id = ?1 ORDER BY s.sort_rank, s.created_at, s.id"
    ))
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;

    let weight = weight_on_or_before(&mut conn, &row.date).await?;
    let volume = workout::session_volume(&volume_input(&rows));
    let energy_kcal = energy_for(&rows, weight);

    Ok(WorkoutSession {
        id: row.id,
        date: row.date,
        started_at: row.started_at,
        ended_at: row.ended_at,
        title: row.title,
        perceived_exertion: row.perceived_exertion,
        note: row.note,
        sets: to_sets(rows),
        volume,
        energy_kcal,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn start_workout_session_inner(
    db: &Db,
    input: StartWorkoutSessionInput,
) -> Result<WorkoutSession, AppError> {
    let date = validate_date(&input.date, "workout.session.date")?;
    // **"실적, 계획 아님" 경계를 런타임에 강제한다.** 미래 날짜 세션을 허용하면 이 도메인이
    // 조용히 계획 저장소가 되고(routines가 소유해야 하는 일), 볼륨·에너지 집계가 하지도 않은
    // 운동을 세기 시작한다. 문서로만 선언하고 코드가 막지 않으면 경계가 아니다.
    if date.as_str() > crate::timezone::local_today_string().as_str() {
        return Err(AppError::validation(
            "workout.session.future",
            "a workout session records training that already happened — \
             use routines to plan future sessions",
        ));
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO workout_sessions (id, date, started_at, title, note) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(&id)
    .bind(&date)
    .bind(clean_optional(input.started_at).as_deref())
    .bind(clean_optional(input.title).as_deref())
    .bind(clean_optional(input.note).as_deref())
    .execute(db)
    .await?;
    fetch_session(db, &id).await
}

pub(crate) async fn patch_workout_session_inner(
    db: &Db,
    input: PatchWorkoutSessionInput,
) -> Result<WorkoutSession, AppError> {
    let date = input
        .date
        .as_deref()
        .map(|value| validate_date(value, "workout.session.date"))
        .transpose()?;
    if date
        .as_ref()
        .is_some_and(|value| value.as_str() > crate::timezone::local_today_string().as_str())
    {
        return Err(AppError::validation(
            "workout.session.future",
            "a workout session records training that already happened — \
             use routines to plan future sessions",
        ));
    }
    validate_range(
        input.perceived_exertion,
        1,
        10,
        "workout.session.perceived_exertion",
    )?;
    let clears = &input.clear;
    let conflicting = (input.title.is_some() && clears.contains(&WorkoutSessionField::Title))
        || (input.started_at.is_some() && clears.contains(&WorkoutSessionField::StartedAt))
        || (input.ended_at.is_some() && clears.contains(&WorkoutSessionField::EndedAt))
        || (input.perceived_exertion.is_some()
            && clears.contains(&WorkoutSessionField::PerceivedExertion))
        || (input.note.is_some() && clears.contains(&WorkoutSessionField::Note));
    if conflicting {
        return Err(AppError::validation(
            "workout.session.patch",
            "a field cannot be both set and cleared",
        ));
    }

    let mut tx = db.begin().await?;
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM workout_sessions WHERE id = ?1")
            .bind(&input.id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() {
        return Err(AppError::not_found(
            "workout.session.missing",
            "workout session not found",
        ));
    }

    if let Some(date) = date {
        sqlx::query("UPDATE workout_sessions SET date = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&date)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(title) = clean_optional(input.title) {
        sqlx::query("UPDATE workout_sessions SET title = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&title)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(started) = clean_optional(input.started_at) {
        sqlx::query("UPDATE workout_sessions SET started_at = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&started)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(ended) = clean_optional(input.ended_at) {
        sqlx::query("UPDATE workout_sessions SET ended_at = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&ended)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(rpe) = input.perceived_exertion {
        sqlx::query("UPDATE workout_sessions SET perceived_exertion = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(rpe)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(note) = clean_optional(input.note) {
        sqlx::query("UPDATE workout_sessions SET note = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&note)
            .execute(&mut *tx)
            .await?;
    }
    for field in clears {
        let column = match field {
            WorkoutSessionField::Title => "title",
            WorkoutSessionField::StartedAt => "started_at",
            WorkoutSessionField::EndedAt => "ended_at",
            WorkoutSessionField::PerceivedExertion => "perceived_exertion",
            WorkoutSessionField::Note => "note",
        };
        sqlx::query(&format!(
            "UPDATE workout_sessions SET {column} = NULL WHERE id = ?1"
        ))
        .bind(&input.id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE workout_sessions SET updated_at = datetime('now') WHERE id = ?1")
        .bind(&input.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    fetch_session(db, &input.id).await
}

pub(crate) async fn delete_workout_session_inner(db: &Db, id: &str) -> Result<(), AppError> {
    // 세트는 ON DELETE CASCADE.
    sqlx::query("DELETE FROM workout_sessions WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

fn validate_set_axes(
    reps: Option<i32>,
    weight_kg: Option<f64>,
    duration_sec: Option<i32>,
    distance_m: Option<f64>,
) -> Result<(), AppError> {
    if let Some(reps) = reps {
        if reps <= 0 {
            return Err(AppError::validation("workout.set.reps", "reps must be > 0"));
        }
    }
    if let Some(weight) = weight_kg {
        if !weight.is_finite() || weight < 0.0 {
            return Err(AppError::validation(
                "workout.set.weight",
                "weightKg must be >= 0",
            ));
        }
    }
    if let Some(duration) = duration_sec {
        if duration <= 0 {
            return Err(AppError::validation(
                "workout.set.duration",
                "durationSec must be > 0",
            ));
        }
    }
    if let Some(distance) = distance_m {
        validate_positive(distance, "workout.set.distance")?;
    }
    // 축이 전부 비면 "무엇을 했다"는 정보가 0이다 — 빈 세트는 거부.
    if reps.is_none() && duration_sec.is_none() && distance_m.is_none() {
        return Err(AppError::validation(
            "workout.set.empty",
            "a set needs at least one of reps / durationSec / distanceM",
        ));
    }
    Ok(())
}

pub(crate) async fn add_workout_set_inner(
    db: &Db,
    input: AddWorkoutSetInput,
) -> Result<WorkoutSession, AppError> {
    validate_set_axes(
        input.reps,
        input.weight_kg,
        input.duration_sec,
        input.distance_m,
    )?;
    validate_range(input.rpe, 1, 10, "workout.set.rpe")?;
    if let Some(rest) = input.rest_sec {
        if rest < 0 {
            return Err(AppError::validation(
                "workout.set.rest",
                "restSec must be >= 0",
            ));
        }
    }

    let mut tx = db.begin().await?;
    // 다음 rank = 현재 최대 + 1(같은 세션에 append). COALESCE 기본값은 정수 컬럼이라 -1로 둔다.
    let next_rank: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(sort_rank), -1) + 1 FROM workout_sets WHERE session_id = ?1",
    )
    .bind(&input.session_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO workout_sets \
           (id, session_id, exercise_id, sort_rank, reps, weight_kg, duration_sec, distance_m, \
            rest_sec, rpe, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(new_id())
    .bind(&input.session_id)
    .bind(&input.exercise_id)
    .bind(next_rank)
    .bind(input.reps)
    .bind(input.weight_kg)
    .bind(input.duration_sec)
    .bind(input.distance_m)
    .bind(input.rest_sec)
    .bind(input.rpe)
    .bind(clean_optional(input.note).as_deref())
    .execute(&mut *tx)
    .await
    .map_err(|e| match e {
        // FK 위반 = 없는 세션이거나 없는 종목. 어느 쪽인지 메시지로 나누지 않는다(둘 다 입력 오류).
        sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
            AppError::validation("workout.set.reference", "session or exercise not found")
        }
        other => AppError::from(other),
    })?;
    tx.commit().await?;
    fetch_session(db, &input.session_id).await
}

pub(crate) async fn patch_workout_set_inner(
    db: &Db,
    input: PatchWorkoutSetInput,
) -> Result<WorkoutSession, AppError> {
    validate_range(input.rpe, 1, 10, "workout.set.rpe")?;
    let clears = &input.clear;
    let conflicting = (input.reps.is_some() && clears.contains(&WorkoutSetField::Reps))
        || (input.weight_kg.is_some() && clears.contains(&WorkoutSetField::WeightKg))
        || (input.duration_sec.is_some() && clears.contains(&WorkoutSetField::DurationSec))
        || (input.distance_m.is_some() && clears.contains(&WorkoutSetField::DistanceM))
        || (input.rest_sec.is_some() && clears.contains(&WorkoutSetField::RestSec))
        || (input.rpe.is_some() && clears.contains(&WorkoutSetField::Rpe))
        || (input.note.is_some() && clears.contains(&WorkoutSetField::Note));
    if conflicting {
        return Err(AppError::validation(
            "workout.set.patch",
            "a field cannot be both set and cleared",
        ));
    }

    let mut tx = db.begin().await?;
    let session_id: Option<String> =
        sqlx::query_scalar("SELECT session_id FROM workout_sets WHERE id = ?1")
            .bind(&input.id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(session_id) = session_id else {
        return Err(AppError::not_found(
            "workout.set.missing",
            "workout set not found",
        ));
    };

    if let Some(exercise_id) = clean_optional(input.exercise_id) {
        sqlx::query("UPDATE workout_sets SET exercise_id = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&exercise_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
                    AppError::validation("workout.set.reference", "exercise not found")
                }
                other => AppError::from(other),
            })?;
    }
    if let Some(reps) = input.reps {
        sqlx::query("UPDATE workout_sets SET reps = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(reps)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(weight) = input.weight_kg {
        sqlx::query("UPDATE workout_sets SET weight_kg = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(weight)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(duration) = input.duration_sec {
        sqlx::query("UPDATE workout_sets SET duration_sec = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(duration)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(distance) = input.distance_m {
        sqlx::query("UPDATE workout_sets SET distance_m = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(distance)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(rest) = input.rest_sec {
        sqlx::query("UPDATE workout_sets SET rest_sec = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(rest)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(rpe) = input.rpe {
        sqlx::query("UPDATE workout_sets SET rpe = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(rpe)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(note) = clean_optional(input.note) {
        sqlx::query("UPDATE workout_sets SET note = ?2 WHERE id = ?1")
            .bind(&input.id)
            .bind(&note)
            .execute(&mut *tx)
            .await?;
    }
    for field in clears {
        let column = match field {
            WorkoutSetField::Reps => "reps",
            WorkoutSetField::WeightKg => "weight_kg",
            WorkoutSetField::DurationSec => "duration_sec",
            WorkoutSetField::DistanceM => "distance_m",
            WorkoutSetField::RestSec => "rest_sec",
            WorkoutSetField::Rpe => "rpe",
            WorkoutSetField::Note => "note",
        };
        sqlx::query(&format!(
            "UPDATE workout_sets SET {column} = NULL WHERE id = ?1"
        ))
        .bind(&input.id)
        .execute(&mut *tx)
        .await?;
    }

    // patch 결과가 "축이 전부 빈 세트"가 되면 거부 — 빈 세트는 무엇을 했는지 알려주지 않는다.
    let after: (Option<i32>, Option<i32>, Option<f64>) =
        sqlx::query_as("SELECT reps, duration_sec, distance_m FROM workout_sets WHERE id = ?1")
            .bind(&input.id)
            .fetch_one(&mut *tx)
            .await?;
    if after.0.is_none() && after.1.is_none() && after.2.is_none() {
        return Err(AppError::validation(
            "workout.set.empty",
            "a set needs at least one of reps / durationSec / distanceM",
        ));
    }
    tx.commit().await?;
    fetch_session(db, &session_id).await
}

pub(crate) async fn remove_workout_set_inner(
    db: &Db,
    id: &str,
) -> Result<WorkoutSession, AppError> {
    let mut tx = db.begin().await?;
    let session_id: Option<String> =
        sqlx::query_scalar("SELECT session_id FROM workout_sets WHERE id = ?1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(session_id) = session_id else {
        return Err(AppError::not_found(
            "workout.set.missing",
            "workout set not found",
        ));
    };
    sqlx::query("DELETE FROM workout_sets WHERE id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    fetch_session(db, &session_id).await
}

pub(crate) async fn list_workout_sessions_inner(
    db: &Db,
    from: &str,
    to: &str,
) -> Result<Vec<WorkoutSession>, AppError> {
    let from = validate_date(from, "workout.range.from")?;
    let to = validate_date(to, "workout.range.to")?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM workout_sessions WHERE date BETWEEN ?1 AND ?2 \
          ORDER BY date DESC, created_at DESC",
    )
    .bind(&from)
    .bind(&to)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(fetch_session(db, &id).await?);
    }
    Ok(out)
}

pub(crate) async fn workout_volume_summary_inner(
    db: &Db,
    from: &str,
    to: &str,
) -> Result<WorkoutVolumeSummary, AppError> {
    let sessions = list_workout_sessions_inner(db, from, to).await?;
    let mut volume = crate::models::WorkoutVolume {
        set_count: 0,
        total_reps: 0,
        volume_kg: 0.0,
        duration_sec: 0,
        distance_m: 0.0,
    };
    let mut energy_kcal = 0.0;
    // 종목별 집계는 (id, name) 기준 — 이름만으로 묶으면 동명 종목이 합쳐진다.
    let mut by_exercise: Vec<ExerciseVolumeRow> = Vec::new();
    for session in &sessions {
        volume.set_count += session.volume.set_count;
        volume.total_reps += session.volume.total_reps;
        volume.volume_kg += session.volume.volume_kg;
        volume.duration_sec += session.volume.duration_sec;
        volume.distance_m += session.volume.distance_m;
        energy_kcal += session.energy_kcal;
        for set in &session.sets {
            let tonnage = match (set.reps, set.weight_kg) {
                (Some(reps), Some(weight)) if weight > 0.0 => f64::from(reps) * weight,
                _ => 0.0,
            };
            match by_exercise
                .iter_mut()
                .find(|row| row.exercise_id == set.exercise_id)
            {
                Some(row) => {
                    row.set_count += 1;
                    row.volume_kg += tonnage;
                }
                None => by_exercise.push(ExerciseVolumeRow {
                    exercise_id: set.exercise_id.clone(),
                    exercise_name: set.exercise_name.clone(),
                    set_count: 1,
                    volume_kg: tonnage,
                }),
            }
        }
    }
    by_exercise.sort_by(|a, b| {
        b.volume_kg
            .partial_cmp(&a.volume_kg)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.exercise_name.cmp(&b.exercise_name))
    });

    Ok(WorkoutVolumeSummary {
        from: validate_date(from, "workout.range.from")?,
        to: validate_date(to, "workout.range.to")?,
        session_count: sessions.len() as i32,
        volume,
        energy_kcal,
        by_exercise,
    })
}

/// 종목별 최고 기록 — 추정 1RM 기준(무게×렙 조합이 다른 세트를 비교 가능하게 만든다).
pub(crate) async fn exercise_personal_records_inner(
    db: &Db,
    exercise_id: Option<String>,
) -> Result<Vec<ExercisePersonalRecord>, AppError> {
    let rows = match clean_optional(exercise_id) {
        Some(id) => {
            sqlx::query_as::<_, (String, String, Option<i32>, Option<f64>, String)>(
                "SELECT e.id, e.name, s.reps, s.weight_kg, ws.date \
                   FROM workout_sets s \
                   JOIN exercises e ON e.id = s.exercise_id \
                   JOIN workout_sessions ws ON ws.id = s.session_id \
                  WHERE e.id = ?1 AND s.reps IS NOT NULL AND s.weight_kg IS NOT NULL",
            )
            .bind(&id)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_as::<_, (String, String, Option<i32>, Option<f64>, String)>(
                "SELECT e.id, e.name, s.reps, s.weight_kg, ws.date \
                   FROM workout_sets s \
                   JOIN exercises e ON e.id = s.exercise_id \
                   JOIN workout_sessions ws ON ws.id = s.session_id \
                  WHERE s.reps IS NOT NULL AND s.weight_kg IS NOT NULL",
            )
            .fetch_all(db)
            .await?
        }
    };

    let mut records: Vec<ExercisePersonalRecord> = Vec::new();
    for (id, name, reps, weight, date) in rows {
        let Some(est) = workout::estimated_1rm(reps, weight) else {
            continue;
        };
        match records.iter_mut().find(|r| r.exercise_id == id) {
            Some(existing) => {
                if existing.best_1rm_kg.is_none_or(|best| est > best) {
                    existing.best_1rm_kg = Some(est);
                    existing.best_weight_kg = weight;
                    existing.best_reps = reps;
                    existing.achieved_on = Some(date);
                }
            }
            None => records.push(ExercisePersonalRecord {
                exercise_id: id,
                exercise_name: name,
                best_1rm_kg: Some(est),
                best_weight_kg: weight,
                best_reps: reps,
                achieved_on: Some(date),
            }),
        }
    }
    records.sort_by(|a, b| a.exercise_name.cmp(&b.exercise_name));
    Ok(records)
}

#[tauri::command]
#[specta::specta]
pub async fn start_workout_session(
    db: State<'_, Db>,
    input: StartWorkoutSessionInput,
) -> Result<WorkoutSession, AppError> {
    start_workout_session_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn patch_workout_session(
    db: State<'_, Db>,
    input: PatchWorkoutSessionInput,
) -> Result<WorkoutSession, AppError> {
    patch_workout_session_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_workout_session(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_workout_session_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_workout_session(
    db: State<'_, Db>,
    id: String,
) -> Result<WorkoutSession, AppError> {
    fetch_session(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_workout_sessions(
    db: State<'_, Db>,
    from: String,
    to: String,
) -> Result<Vec<WorkoutSession>, AppError> {
    list_workout_sessions_inner(db.inner(), &from, &to).await
}

#[tauri::command]
#[specta::specta]
pub async fn add_workout_set(
    db: State<'_, Db>,
    input: AddWorkoutSetInput,
) -> Result<WorkoutSession, AppError> {
    add_workout_set_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn patch_workout_set(
    db: State<'_, Db>,
    input: PatchWorkoutSetInput,
) -> Result<WorkoutSession, AppError> {
    patch_workout_set_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_workout_set(db: State<'_, Db>, id: String) -> Result<WorkoutSession, AppError> {
    remove_workout_set_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn workout_volume_summary(
    db: State<'_, Db>,
    from: String,
    to: String,
) -> Result<WorkoutVolumeSummary, AppError> {
    workout_volume_summary_inner(db.inner(), &from, &to).await
}

#[tauri::command]
#[specta::specta]
pub async fn exercise_personal_records(
    db: State<'_, Db>,
    exercise_id: Option<String>,
) -> Result<Vec<ExercisePersonalRecord>, AppError> {
    exercise_personal_records_inner(db.inner(), exercise_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;
    use crate::commands::workout::body::record_body_metric_inner;
    use crate::commands::workout::exercises::test_support::seed_exercise;
    use crate::models::RecordBodyMetricInput;

    async fn session_on(db: &Db, date: &str) -> String {
        start_workout_session_inner(
            db,
            StartWorkoutSessionInput {
                date: date.into(),
                started_at: None,
                title: Some("하체".into()),
                note: None,
            },
        )
        .await
        .expect("session")
        .id
    }

    fn strength_set(
        session_id: &str,
        exercise_id: &str,
        reps: i32,
        weight: f64,
    ) -> AddWorkoutSetInput {
        AddWorkoutSetInput {
            session_id: session_id.into(),
            exercise_id: exercise_id.into(),
            reps: Some(reps),
            weight_kg: Some(weight),
            duration_sec: None,
            distance_m: None,
            rest_sec: Some(90),
            rpe: Some(8),
            note: None,
        }
    }

    #[tokio::test]
    async fn sets_accumulate_volume_and_derive_set_numbers() {
        let db = fresh_db().await;
        let squat = seed_exercise(&db, "백스쿼트", ExerciseModality::Strength, Some(5.0)).await;
        let session = session_on(&db, "2026-07-26").await;

        add_workout_set_inner(&db, strength_set(&session, &squat, 10, 60.0))
            .await
            .unwrap();
        let after = add_workout_set_inner(&db, strength_set(&session, &squat, 8, 70.0))
            .await
            .unwrap();

        assert_eq!(
            after.sets.iter().map(|s| s.set_no).collect::<Vec<_>>(),
            vec![1, 2],
            "세트 번호는 쿼리타임 파생"
        );
        assert_eq!(after.volume.set_count, 2);
        assert_eq!(after.volume.total_reps, 18);
        assert!((after.volume.volume_kg - 1160.0).abs() < 1e-9);
        // 추정 1RM도 파생된다.
        assert!((after.sets[1].estimated_1rm_kg.unwrap() - 70.0 * (1.0 + 8.0 / 30.0)).abs() < 1e-9);
    }

    #[tokio::test]
    async fn future_dated_sessions_are_refused_because_this_domain_records_only() {
        // critic 지적 회귀 가드: 미래 날짜를 허용하면 이 도메인이 조용히 계획 저장소가 되고
        // (routines가 소유해야 하는 일) 볼륨·에너지 집계가 하지도 않은 운동을 센다.
        let db = fresh_db().await;
        let err = start_workout_session_inner(
            &db,
            StartWorkoutSessionInput {
                date: "2099-01-01".into(),
                started_at: None,
                title: Some("계획질".into()),
                note: None,
            },
        )
        .await
        .expect_err("미래 세션 거부");
        assert!(format!("{err:?}").contains("session.future"));
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workout_sessions")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 0);

        // 오늘과 과거는 허용된다.
        let today = crate::timezone::local_today_string();
        assert!(start_workout_session_inner(
            &db,
            StartWorkoutSessionInput {
                date: today,
                started_at: None,
                title: None,
                note: None,
            },
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn session_date_and_metadata_can_be_corrected() {
        let db = fresh_db().await;
        let id = session_on(&db, "2026-07-25").await;
        let updated = patch_workout_session_inner(
            &db,
            PatchWorkoutSessionInput {
                id,
                date: Some("2026-07-26".into()),
                ended_at: Some("10:30".into()),
                perceived_exertion: Some(7),
                note: Some("정정".into()),
                ..PatchWorkoutSessionInput::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.date, "2026-07-26");
        assert_eq!(updated.ended_at.as_deref(), Some("10:30"));
        assert_eq!(updated.perceived_exertion, Some(7));
        assert_eq!(updated.note.as_deref(), Some("정정"));

        let err = patch_workout_session_inner(
            &db,
            PatchWorkoutSessionInput {
                id: updated.id,
                date: Some("2099-01-01".into()),
                ..PatchWorkoutSessionInput::default()
            },
        )
        .await
        .expect_err("미래 날짜 정정 거부");
        assert!(format!("{err:?}").contains("session.future"));
    }

    #[tokio::test]
    async fn one_rep_max_records_use_the_actual_weight_for_singles() {
        // critic 지적: Epley를 1회에 적용하면 싱글이 3.3% 부풀어 최고기록 선택이 오염된다.
        // 120kg×1회(=1RM 120)와 100kg×10회(Epley 133.3)를 비교하면 후자가 이겨야 한다.
        let db = fresh_db().await;
        let squat = seed_exercise(&db, "백스쿼트", ExerciseModality::Strength, None).await;
        let session = session_on(&db, "2026-07-26").await;
        add_workout_set_inner(&db, strength_set(&session, &squat, 1, 120.0))
            .await
            .unwrap();
        let after = add_workout_set_inner(&db, strength_set(&session, &squat, 10, 100.0))
            .await
            .unwrap();

        assert_eq!(
            after.sets[0].estimated_1rm_kg,
            Some(120.0),
            "싱글은 실측 그대로"
        );
        let records = exercise_personal_records_inner(&db, None).await.unwrap();
        let pr = records.iter().find(|r| r.exercise_id == squat).unwrap();
        assert!(
            (pr.best_1rm_kg.unwrap() - 100.0 * (1.0 + 10.0 / 30.0)).abs() < 1e-9,
            "부풀린 싱글이 최고기록을 훔치지 않는다"
        );
        assert_eq!(pr.best_reps, Some(10));
    }

    #[tokio::test]
    async fn empty_sets_are_rejected_on_add_and_on_patch() {
        let db = fresh_db().await;
        let squat = seed_exercise(&db, "백스쿼트", ExerciseModality::Strength, None).await;
        let session = session_on(&db, "2026-07-26").await;

        let err = add_workout_set_inner(
            &db,
            AddWorkoutSetInput {
                session_id: session.clone(),
                exercise_id: squat.clone(),
                reps: None,
                weight_kg: Some(60.0),
                duration_sec: None,
                distance_m: None,
                rest_sec: None,
                rpe: None,
                note: None,
            },
        )
        .await
        .expect_err("무게만 있는 세트는 무엇을 했는지 모른다");
        assert!(format!("{err:?}").contains("at least one"));

        let with_reps = add_workout_set_inner(&db, strength_set(&session, &squat, 5, 60.0))
            .await
            .unwrap();
        let set_id = with_reps.sets[0].id.clone();
        // patch로 reps를 비우면 빈 세트가 되므로 거부되고 원래 값이 유지된다.
        let err = patch_workout_set_inner(
            &db,
            PatchWorkoutSetInput {
                id: set_id.clone(),
                clear: vec![WorkoutSetField::Reps],
                ..Default::default()
            },
        )
        .await
        .expect_err("patch 결과가 빈 세트면 거부");
        assert!(format!("{err:?}").contains("at least one"));
        let still = fetch_session(&db, &session).await.unwrap();
        assert_eq!(still.sets[0].reps, Some(5), "거부된 patch가 롤백됐다");
    }

    #[tokio::test]
    async fn energy_uses_the_weight_measured_on_or_before_the_session_date() {
        let db = fresh_db().await;
        let run = seed_exercise(&db, "러닝", ExerciseModality::Cardio, Some(9.8)).await;
        record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-01".into(),
                weight_kg: Some(70.0),
                body_fat_pct: None,
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: None,
                clear: vec![],
            },
        )
        .await
        .unwrap();
        // 세션 이후 측정 — 과거 세션 계산에 끌어와서는 안 된다.
        record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-30".into(),
                weight_kg: Some(60.0),
                body_fat_pct: None,
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: None,
                clear: vec![],
            },
        )
        .await
        .unwrap();

        // 세션 날짜는 2026-07-10 — 0076이 시딩한 2026-07-26(69kg) 행보다 앞이므로 그 값이
        // 끼어들지 않고 "이전 최근 측정"이 2026-07-01의 70kg임이 분명해진다.
        let session = session_on(&db, "2026-07-10").await;
        let after = add_workout_set_inner(
            &db,
            AddWorkoutSetInput {
                session_id: session,
                exercise_id: run,
                reps: None,
                weight_kg: None,
                duration_sec: Some(1800),
                distance_m: Some(5000.0),
                rest_sec: None,
                rpe: None,
                note: None,
            },
        )
        .await
        .unwrap();
        // 9.8 MET × 70kg × 0.5h = 343
        assert!(
            (after.energy_kcal - 343.0).abs() < 1e-9,
            "세션 날짜 이전 최근 체중(70kg)을 써야 한다: {}",
            after.energy_kcal
        );
    }

    #[tokio::test]
    async fn sessions_without_met_report_zero_energy_rather_than_a_guess() {
        let db = fresh_db().await;
        let plank = seed_exercise(&db, "플랭크", ExerciseModality::Mobility, None).await;
        record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-01".into(),
                weight_kg: Some(69.0),
                body_fat_pct: None,
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: None,
                clear: vec![],
            },
        )
        .await
        .unwrap();
        let session = session_on(&db, "2026-07-26").await;
        let after = add_workout_set_inner(
            &db,
            AddWorkoutSetInput {
                session_id: session,
                exercise_id: plank,
                reps: None,
                weight_kg: None,
                duration_sec: Some(120),
                distance_m: None,
                rest_sec: None,
                rpe: None,
                note: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(after.energy_kcal, 0.0);
        assert_eq!(after.volume.duration_sec, 120, "시간은 여전히 기록된다");
    }

    #[tokio::test]
    async fn volume_summary_groups_by_exercise_and_records_track_best_1rm() {
        let db = fresh_db().await;
        let squat = seed_exercise(&db, "백스쿼트", ExerciseModality::Strength, None).await;
        let bench = seed_exercise(&db, "벤치프레스", ExerciseModality::Strength, None).await;
        let s1 = session_on(&db, "2026-07-20").await;
        let s2 = session_on(&db, "2026-07-26").await;
        add_workout_set_inner(&db, strength_set(&s1, &squat, 10, 100.0))
            .await
            .unwrap();
        add_workout_set_inner(&db, strength_set(&s2, &squat, 5, 120.0))
            .await
            .unwrap();
        add_workout_set_inner(&db, strength_set(&s2, &bench, 10, 60.0))
            .await
            .unwrap();

        let summary = workout_volume_summary_inner(&db, "2026-07-01", "2026-07-31")
            .await
            .unwrap();
        assert_eq!(summary.session_count, 2);
        assert_eq!(summary.volume.set_count, 3);
        assert!((summary.volume.volume_kg - (1000.0 + 600.0 + 600.0)).abs() < 1e-9);
        // 톤수 내림차순 — 스쿼트(1600) > 벤치(600).
        assert_eq!(summary.by_exercise[0].exercise_name, "백스쿼트");
        assert!((summary.by_exercise[0].volume_kg - 1600.0).abs() < 1e-9);
        assert_eq!(summary.by_exercise[1].exercise_name, "벤치프레스");

        let records = exercise_personal_records_inner(&db, None).await.unwrap();
        let squat_pr = records.iter().find(|r| r.exercise_id == squat).unwrap();
        // 120×5 → 140 vs 100×10 → 133.3 : 120kg 세트가 이긴다.
        assert!((squat_pr.best_1rm_kg.unwrap() - 140.0).abs() < 1e-9);
        assert_eq!(squat_pr.best_weight_kg, Some(120.0));
        assert_eq!(squat_pr.achieved_on.as_deref(), Some("2026-07-26"));
    }

    #[tokio::test]
    async fn range_query_is_bounded_by_date_and_deleting_a_session_takes_its_sets() {
        let db = fresh_db().await;
        let squat = seed_exercise(&db, "백스쿼트", ExerciseModality::Strength, None).await;
        let inside = session_on(&db, "2026-07-26").await;
        let outside = session_on(&db, "2026-06-01").await;
        add_workout_set_inner(&db, strength_set(&inside, &squat, 5, 100.0))
            .await
            .unwrap();

        let listed = list_workout_sessions_inner(&db, "2026-07-01", "2026-07-31")
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, inside);

        delete_workout_session_inner(&db, &inside).await.unwrap();
        let sets: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM workout_sets")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(sets.0, 0, "CASCADE로 세트도 사라진다");
        assert!(fetch_session(&db, &outside).await.is_ok());
    }
}
