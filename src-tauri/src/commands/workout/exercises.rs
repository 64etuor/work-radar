//! 종목 라이브러리 — 이름/별칭 검색 + MET 계수(소모 kcal 계산 입력).
//! `foods`/`food_aliases`와 같은 패턴(정규화 UNIQUE 별칭).

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, clean_required, new_id, normalize_alias, validate_positive};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{Exercise, ExerciseModality, UpsertExerciseInput};

#[derive(Debug, sqlx::FromRow)]
struct ExerciseRow {
    id: String,
    name: String,
    modality: ExerciseModality,
    primary_muscle: Option<String>,
    equipment: Option<String>,
    met: Option<f64>,
    source: String,
    source_ref: Option<String>,
    archived: bool,
    created_at: String,
    updated_at: String,
}

const COLS: &str = "id, name, modality, primary_muscle, equipment, met, source, source_ref, \
                    archived, created_at, updated_at";

async fn aliases_for(db: &Db, exercise_id: &str) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT alias FROM exercise_aliases WHERE exercise_id = ?1 ORDER BY alias",
    )
    .bind(exercise_id)
    .fetch_all(db)
    .await?)
}

async fn assemble(db: &Db, row: ExerciseRow) -> Result<Exercise, AppError> {
    let aliases = aliases_for(db, &row.id).await?;
    Ok(Exercise {
        id: row.id,
        name: row.name,
        modality: row.modality,
        primary_muscle: row.primary_muscle,
        equipment: row.equipment,
        met: row.met,
        source: row.source,
        source_ref: row.source_ref,
        archived: row.archived,
        aliases,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn fetch_exercise(db: &Db, id: &str) -> Result<Exercise, AppError> {
    let row =
        sqlx::query_as::<_, ExerciseRow>(&format!("SELECT {COLS} FROM exercises WHERE id = ?1"))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| AppError::not_found("workout.exercise.missing", "exercise not found"))?;
    assemble(db, row).await
}

pub(crate) async fn upsert_exercise_inner(
    db: &Db,
    input: UpsertExerciseInput,
) -> Result<Exercise, AppError> {
    let name = clean_required(&input.name, "workout.exercise.name", "exercise name")?;
    if let Some(met) = input.met {
        validate_positive(met, "workout.exercise.met")?;
    }
    let primary_muscle = clean_optional(input.primary_muscle);
    let equipment = clean_optional(input.equipment);
    let source_ref = clean_optional(input.source_ref);

    match input.id.as_deref() {
        Some(id) => {
            // 갱신은 provenance(source)를 건드리지 않는다 — 어디서 온 종목인지 보존.
            let updated = sqlx::query(
                "UPDATE exercises SET name = ?2, modality = ?3, primary_muscle = ?4, \
                   equipment = ?5, met = ?6, source_ref = ?7, updated_at = datetime('now') \
                 WHERE id = ?1",
            )
            .bind(id)
            .bind(&name)
            .bind(input.modality)
            .bind(primary_muscle.as_deref())
            .bind(equipment.as_deref())
            .bind(input.met)
            .bind(source_ref.as_deref())
            .execute(db)
            .await?;
            if updated.rows_affected() == 0 {
                return Err(AppError::not_found(
                    "workout.exercise.missing",
                    "exercise not found",
                ));
            }
            fetch_exercise(db, id).await
        }
        None => {
            let id = new_id();
            sqlx::query(
                "INSERT INTO exercises \
                   (id, name, modality, primary_muscle, equipment, met, source, source_ref) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .bind(&id)
            .bind(&name)
            .bind(input.modality)
            .bind(primary_muscle.as_deref())
            .bind(equipment.as_deref())
            .bind(input.met)
            .bind(clean_optional(input.source).unwrap_or_else(|| "manual".to_string()))
            .bind(source_ref.as_deref())
            .execute(db)
            .await?;
            fetch_exercise(db, &id).await
        }
    }
}

pub(crate) async fn list_exercises_inner(
    db: &Db,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Exercise>, AppError> {
    let query = clean_optional(query);
    let ids: Vec<String> = match query {
        Some(q) => {
            let like = format!("%{}%", normalize_alias(&q));
            // 이름 또는 별칭 부분 일치 — 별칭이 있어야 "렛풀다운"/"랫풀다운"이 같이 잡힌다.
            sqlx::query_scalar(
                "SELECT e.id FROM exercises e \
                  WHERE (?1 OR e.archived = 0) \
                    AND (lower(e.name) LIKE ?2 \
                         OR EXISTS (SELECT 1 FROM exercise_aliases a \
                                     WHERE a.exercise_id = e.id AND a.normalized LIKE ?2)) \
                  ORDER BY e.name",
            )
            .bind(include_archived)
            .bind(&like)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_scalar("SELECT id FROM exercises WHERE (?1 OR archived = 0) ORDER BY name")
                .bind(include_archived)
                .fetch_all(db)
                .await?
        }
    };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        out.push(fetch_exercise(db, &id).await?);
    }
    Ok(out)
}

pub(crate) async fn set_exercise_archived_inner(
    db: &Db,
    id: &str,
    archived: bool,
) -> Result<Exercise, AppError> {
    let updated = sqlx::query(
        "UPDATE exercises SET archived = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .bind(archived)
    .execute(db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "workout.exercise.missing",
            "exercise not found",
        ));
    }
    fetch_exercise(db, id).await
}

pub(crate) async fn add_exercise_alias_inner(
    db: &Db,
    exercise_id: &str,
    alias: &str,
) -> Result<Exercise, AppError> {
    let alias = clean_required(alias, "workout.alias.value", "alias")?;
    let normalized = normalize_alias(&alias);
    if normalized.is_empty() {
        return Err(AppError::validation(
            "workout.alias.value",
            "alias is empty",
        ));
    }
    sqlx::query(
        "INSERT INTO exercise_aliases (id, exercise_id, alias, normalized) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(new_id())
    .bind(exercise_id)
    .bind(&alias)
    .bind(&normalized)
    .execute(db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.message().contains("UNIQUE") => {
            AppError::validation("workout.alias.duplicate", "alias already used")
        }
        sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
            AppError::not_found("workout.exercise.missing", "exercise not found")
        }
        other => AppError::from(other),
    })?;
    fetch_exercise(db, exercise_id).await
}

pub(crate) async fn remove_exercise_alias_inner(
    db: &Db,
    exercise_id: &str,
    alias: &str,
) -> Result<Exercise, AppError> {
    sqlx::query("DELETE FROM exercise_aliases WHERE exercise_id = ?1 AND normalized = ?2")
        .bind(exercise_id)
        .bind(normalize_alias(alias))
        .execute(db)
        .await?;
    fetch_exercise(db, exercise_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_exercise(
    db: State<'_, Db>,
    input: UpsertExerciseInput,
) -> Result<Exercise, AppError> {
    upsert_exercise_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_exercises(
    db: State<'_, Db>,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Exercise>, AppError> {
    list_exercises_inner(db.inner(), query, include_archived).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_exercise_archived(
    db: State<'_, Db>,
    id: String,
    archived: bool,
) -> Result<Exercise, AppError> {
    set_exercise_archived_inner(db.inner(), &id, archived).await
}

#[tauri::command]
#[specta::specta]
pub async fn add_exercise_alias(
    db: State<'_, Db>,
    exercise_id: String,
    alias: String,
) -> Result<Exercise, AppError> {
    add_exercise_alias_inner(db.inner(), &exercise_id, &alias).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_exercise_alias(
    db: State<'_, Db>,
    exercise_id: String,
    alias: String,
) -> Result<Exercise, AppError> {
    remove_exercise_alias_inner(db.inner(), &exercise_id, &alias).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{ExerciseModality, UpsertExerciseInput};

    pub(crate) async fn seed_exercise(
        db: &Db,
        name: &str,
        modality: ExerciseModality,
        met: Option<f64>,
    ) -> String {
        super::upsert_exercise_inner(
            db,
            UpsertExerciseInput {
                id: None,
                name: name.into(),
                modality,
                primary_muscle: None,
                equipment: None,
                met,
                source: None,
                source_ref: None,
            },
        )
        .await
        .expect("seed exercise")
        .id
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::seed_exercise;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{ExerciseModality, UpsertExerciseInput};

    #[tokio::test]
    async fn search_matches_name_or_alias() {
        let db = fresh_db().await;
        let squat = seed_exercise(&db, "백스쿼트", ExerciseModality::Strength, Some(5.0)).await;
        seed_exercise(&db, "러닝", ExerciseModality::Cardio, Some(9.8)).await;
        super::add_exercise_alias_inner(&db, &squat, "  Back   Squat ")
            .await
            .unwrap();

        let by_name = super::list_exercises_inner(&db, Some("스쿼트".into()), false)
            .await
            .unwrap();
        assert_eq!(by_name.len(), 1);
        assert_eq!(by_name[0].aliases, vec!["Back   Squat"]);

        // 별칭은 정규화(lower + 공백 압축)되어 저장되므로 소문자/공백 무시 검색이 된다.
        let by_alias = super::list_exercises_inner(&db, Some("back squat".into()), false)
            .await
            .unwrap();
        assert_eq!(by_alias.len(), 1);
        assert_eq!(by_alias[0].id, squat);

        let none = super::list_exercises_inner(&db, Some("데드리프트".into()), false)
            .await
            .unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn duplicate_alias_is_a_validation_error() {
        let db = fresh_db().await;
        let a = seed_exercise(&db, "벤치프레스", ExerciseModality::Strength, None).await;
        let b = seed_exercise(&db, "인클라인 벤치", ExerciseModality::Strength, None).await;
        super::add_exercise_alias_inner(&db, &a, "bench")
            .await
            .unwrap();
        let err = super::add_exercise_alias_inner(&db, &b, "BENCH")
            .await
            .expect_err("정규화 후 중복");
        assert!(format!("{err:?}").contains("already used"));
    }

    #[tokio::test]
    async fn updating_an_exercise_preserves_provenance_and_rejects_bad_met() {
        let db = fresh_db().await;
        let id = super::upsert_exercise_inner(
            &db,
            UpsertExerciseInput {
                id: None,
                name: "러닝".into(),
                modality: ExerciseModality::Cardio,
                primary_muscle: None,
                equipment: None,
                met: Some(9.8),
                source: Some("compendium".into()),
                source_ref: Some("12030".into()),
            },
        )
        .await
        .unwrap()
        .id;

        let updated = super::upsert_exercise_inner(
            &db,
            UpsertExerciseInput {
                id: Some(id.clone()),
                name: "러닝 (야외)".into(),
                modality: ExerciseModality::Cardio,
                primary_muscle: None,
                equipment: None,
                met: Some(10.0),
                // source를 다시 보내도 무시된다 — provenance는 생성 시점 값을 유지.
                source: Some("manual".into()),
                source_ref: Some("12030".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "러닝 (야외)");
        assert_eq!(updated.source, "compendium", "provenance 보존");
        assert_eq!(updated.met, Some(10.0));

        let err = super::upsert_exercise_inner(
            &db,
            UpsertExerciseInput {
                id: Some(id),
                name: "러닝".into(),
                modality: ExerciseModality::Cardio,
                primary_muscle: None,
                equipment: None,
                met: Some(0.0),
                source: None,
                source_ref: None,
            },
        )
        .await
        .expect_err("MET 0 거부");
        assert!(format!("{err:?}").contains("> 0"));
    }
}
