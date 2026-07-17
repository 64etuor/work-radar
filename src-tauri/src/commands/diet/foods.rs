//! 표준 식품 + 검색 별칭. 영양은 100g당 인라인 컬럼(models::Food 참조).

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, clean_required, new_id, validate_non_negative};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{DietMacros, Food, FoodType, UpsertFoodInput};

#[derive(Debug, sqlx::FromRow)]
struct FoodRow {
    id: String,
    name: String,
    food_type: FoodType,
    preparation: Option<String>,
    default_serving_g: Option<f64>,
    kcal_per_100g: f64,
    protein_g_per_100g: f64,
    fat_g_per_100g: f64,
    carb_g_per_100g: f64,
    fiber_g_per_100g: Option<f64>,
    sodium_mg_per_100g: Option<f64>,
    source: String,
    source_ref: Option<String>,
    archived: bool,
    created_at: String,
    updated_at: String,
}

const FOOD_COLS: &str = "id, name, food_type, preparation, default_serving_g, kcal_per_100g, \
     protein_g_per_100g, fat_g_per_100g, carb_g_per_100g, fiber_g_per_100g, sodium_mg_per_100g, \
     source, source_ref, archived, created_at, updated_at";

/// 별칭 정규화 — lower + 연속 공백 1칸. 검색/UNIQUE 비교의 단일 기준.
pub(crate) fn normalize_alias(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

async fn aliases_for(db: &Db, food_id: &str) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT alias FROM food_aliases WHERE food_id = ?1 ORDER BY created_at, alias",
    )
    .bind(food_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(alias,)| alias).collect())
}

async fn food_from_row(db: &Db, row: FoodRow) -> Result<Food, AppError> {
    let aliases = aliases_for(db, &row.id).await?;
    Ok(Food {
        id: row.id,
        name: row.name,
        food_type: row.food_type,
        preparation: row.preparation,
        default_serving_g: row.default_serving_g,
        kcal_per_100g: row.kcal_per_100g,
        protein_g_per_100g: row.protein_g_per_100g,
        fat_g_per_100g: row.fat_g_per_100g,
        carb_g_per_100g: row.carb_g_per_100g,
        fiber_g_per_100g: row.fiber_g_per_100g,
        sodium_mg_per_100g: row.sodium_mg_per_100g,
        source: row.source,
        source_ref: row.source_ref,
        archived: row.archived,
        aliases,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn fetch_food(db: &Db, id: &str) -> Result<Food, AppError> {
    let row = sqlx::query_as::<_, FoodRow>(&format!("SELECT {FOOD_COLS} FROM foods WHERE id = ?1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("diet.food.missing", "food not found"))?;
    food_from_row(db, row).await
}

/// (name, 100g당 매크로) — 계획/기록 스냅샷 계산용 공용 헬퍼.
pub(crate) async fn food_per_100g(db: &Db, id: &str) -> Result<(String, DietMacros), AppError> {
    let row: Option<(String, f64, f64, f64, f64)> = sqlx::query_as(
        "SELECT name, kcal_per_100g, protein_g_per_100g, fat_g_per_100g, carb_g_per_100g \
           FROM foods WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let (name, kcal, protein, fat, carb) =
        row.ok_or_else(|| AppError::not_found("diet.food.missing", "food not found"))?;
    Ok((
        name,
        DietMacros {
            kcal,
            protein_g: protein,
            fat_g: fat,
            carb_g: carb,
        },
    ))
}

fn validate_food_input(input: &UpsertFoodInput) -> Result<(), AppError> {
    validate_non_negative(input.kcal_per_100g, "diet.food.kcal")?;
    validate_non_negative(input.protein_g_per_100g, "diet.food.protein")?;
    validate_non_negative(input.fat_g_per_100g, "diet.food.fat")?;
    validate_non_negative(input.carb_g_per_100g, "diet.food.carb")?;
    for (value, code) in [
        (input.fiber_g_per_100g, "diet.food.fiber"),
        (input.sodium_mg_per_100g, "diet.food.sodium"),
        (input.default_serving_g, "diet.food.serving"),
    ] {
        if let Some(v) = value {
            validate_non_negative(v, code)?;
        }
    }
    Ok(())
}

pub(crate) async fn upsert_food_inner(db: &Db, input: UpsertFoodInput) -> Result<Food, AppError> {
    let name = clean_required(&input.name, "diet.food.name", "food name")?;
    validate_food_input(&input)?;
    let preparation = clean_optional(input.preparation.clone());
    // source/source_ref는 provenance — UPDATE에서 caller가 안 보내면 기존 값을 보존한다
    // (COALESCE). 에이전트 갱신이 사용자 등록 식품을 조용히 'agent' 소유로 뒤집지 않게(critic).
    let source = clean_optional(input.source.clone());
    let source_ref = clean_optional(input.source_ref.clone());

    let id = match input.id {
        Some(existing) => {
            let updated = sqlx::query(
                "UPDATE foods SET name = ?2, food_type = ?3, preparation = ?4, \
                   default_serving_g = ?5, kcal_per_100g = ?6, protein_g_per_100g = ?7, \
                   fat_g_per_100g = ?8, carb_g_per_100g = ?9, fiber_g_per_100g = ?10, \
                   sodium_mg_per_100g = ?11, source = COALESCE(?12, source), \
                   source_ref = COALESCE(?13, source_ref), \
                   updated_at = datetime('now') \
                 WHERE id = ?1",
            )
            .bind(&existing)
            .bind(&name)
            .bind(input.food_type)
            .bind(preparation.as_deref())
            .bind(input.default_serving_g)
            .bind(input.kcal_per_100g)
            .bind(input.protein_g_per_100g)
            .bind(input.fat_g_per_100g)
            .bind(input.carb_g_per_100g)
            .bind(input.fiber_g_per_100g)
            .bind(input.sodium_mg_per_100g)
            .bind(&source)
            .bind(source_ref.as_deref())
            .execute(db)
            .await?;
            if updated.rows_affected() == 0 {
                return Err(AppError::not_found("diet.food.missing", "food not found"));
            }
            existing
        }
        None => {
            let id = new_id();
            sqlx::query(
                "INSERT INTO foods (id, name, food_type, preparation, default_serving_g, \
                   kcal_per_100g, protein_g_per_100g, fat_g_per_100g, carb_g_per_100g, \
                   fiber_g_per_100g, sodium_mg_per_100g, source, source_ref) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )
            .bind(&id)
            .bind(&name)
            .bind(input.food_type)
            .bind(preparation.as_deref())
            .bind(input.default_serving_g)
            .bind(input.kcal_per_100g)
            .bind(input.protein_g_per_100g)
            .bind(input.fat_g_per_100g)
            .bind(input.carb_g_per_100g)
            .bind(input.fiber_g_per_100g)
            .bind(input.sodium_mg_per_100g)
            // INSERT는 NOT NULL — 미지정이면 'manual'(UPDATE는 COALESCE로 기존 값 보존).
            .bind(source.clone().unwrap_or_else(|| "manual".to_string()))
            .bind(source_ref.as_deref())
            .execute(db)
            .await?;
            id
        }
    };
    fetch_food(db, &id).await
}

pub(crate) async fn list_foods_inner(
    db: &Db,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Food>, AppError> {
    let query = clean_optional(query);
    let rows = match query {
        Some(q) => {
            let like = format!("%{}%", normalize_alias(&q));
            sqlx::query_as::<_, FoodRow>(&format!(
                "SELECT DISTINCT {cols} FROM foods f \
                   LEFT JOIN food_aliases a ON a.food_id = f.id \
                  WHERE (?1 OR f.archived = 0) \
                    AND (lower(f.name) LIKE ?2 OR a.normalized LIKE ?2) \
                  ORDER BY f.name",
                cols = FOOD_COLS
                    .split(", ")
                    .map(|c| format!("f.{c}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
            .bind(include_archived)
            .bind(&like)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_as::<_, FoodRow>(&format!(
                "SELECT {FOOD_COLS} FROM foods WHERE (?1 OR archived = 0) ORDER BY name"
            ))
            .bind(include_archived)
            .fetch_all(db)
            .await?
        }
    };
    let mut foods = Vec::with_capacity(rows.len());
    for row in rows {
        foods.push(food_from_row(db, row).await?);
    }
    Ok(foods)
}

pub(crate) async fn set_food_archived_inner(
    db: &Db,
    id: &str,
    archived: bool,
) -> Result<Food, AppError> {
    let updated =
        sqlx::query("UPDATE foods SET archived = ?2, updated_at = datetime('now') WHERE id = ?1")
            .bind(id)
            .bind(archived)
            .execute(db)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found("diet.food.missing", "food not found"));
    }
    fetch_food(db, id).await
}

pub(crate) async fn add_food_alias_inner(
    db: &Db,
    food_id: &str,
    alias: &str,
) -> Result<Food, AppError> {
    let alias = clean_required(alias, "diet.food.alias", "alias")?;
    let normalized = normalize_alias(&alias);
    // UNIQUE(normalized) 충돌 → 이미 있는 별칭(같은 food든 다른 food든)으로 안내.
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO food_aliases (id, food_id, alias, normalized) \
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(new_id())
    .bind(food_id)
    .bind(&alias)
    .bind(&normalized)
    .execute(db)
    .await?;
    if inserted.rows_affected() == 0 {
        return Err(AppError::validation(
            "diet.food.alias.duplicate",
            "alias already exists",
        ));
    }
    fetch_food(db, food_id).await
}

pub(crate) async fn remove_food_alias_inner(db: &Db, alias: &str) -> Result<(), AppError> {
    let normalized = normalize_alias(alias);
    sqlx::query("DELETE FROM food_aliases WHERE normalized = ?1")
        .bind(&normalized)
        .execute(db)
        .await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn upsert_food(db: State<'_, Db>, input: UpsertFoodInput) -> Result<Food, AppError> {
    upsert_food_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_foods(
    db: State<'_, Db>,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Food>, AppError> {
    list_foods_inner(db.inner(), query, include_archived).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_food_archived(
    db: State<'_, Db>,
    id: String,
    archived: bool,
) -> Result<Food, AppError> {
    set_food_archived_inner(db.inner(), &id, archived).await
}

#[tauri::command]
#[specta::specta]
pub async fn add_food_alias(
    db: State<'_, Db>,
    food_id: String,
    alias: String,
) -> Result<Food, AppError> {
    add_food_alias_inner(db.inner(), &food_id, &alias).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_food_alias(db: State<'_, Db>, alias: String) -> Result<(), AppError> {
    remove_food_alias_inner(db.inner(), &alias).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{FoodType, UpsertFoodInput};

    pub(crate) fn food_input(name: &str, kcal: f64, protein: f64) -> UpsertFoodInput {
        UpsertFoodInput {
            id: None,
            name: name.to_string(),
            food_type: FoodType::Ingredient,
            preparation: None,
            default_serving_g: None,
            kcal_per_100g: kcal,
            protein_g_per_100g: protein,
            fat_g_per_100g: 0.0,
            carb_g_per_100g: 0.0,
            fiber_g_per_100g: None,
            sodium_mg_per_100g: None,
            source: None,
            source_ref: None,
        }
    }

    pub(crate) async fn seed_food(db: &Db, name: &str, kcal: f64, protein: f64) -> String {
        super::upsert_food_inner(db, food_input(name, kcal, protein))
            .await
            .expect("seed food")
            .id
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{food_input, seed_food};
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn upsert_creates_then_updates_without_new_row() {
        let db = fresh_db().await;
        let created = super::upsert_food_inner(&db, food_input("닭다리살", 120.0, 22.0))
            .await
            .unwrap();
        assert_eq!(created.name, "닭다리살");
        assert_eq!(created.source, "manual");

        let mut update = food_input("닭다리살(껍질 없음)", 119.0, 22.5);
        update.id = Some(created.id.clone());
        let updated = super::upsert_food_inner(&db, update).await.unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "닭다리살(껍질 없음)");

        let count: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM foods")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 1);

        // 존재하지 않는 id 갱신은 not_found.
        let mut missing = food_input("x", 1.0, 0.0);
        missing.id = Some("nope".into());
        assert!(super::upsert_food_inner(&db, missing).await.is_err());
    }

    #[tokio::test]
    async fn alias_search_finds_food_and_duplicates_are_rejected() {
        let db = fresh_db().await;
        let food_id = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let with_alias = super::add_food_alias_inner(&db, &food_id, "닭  정육")
            .await
            .unwrap();
        assert_eq!(with_alias.aliases, vec!["닭  정육"]);

        // 정규화("닭 정육") 기준 검색 매칭.
        let found = super::list_foods_inner(&db, Some("정육".into()), false)
            .await
            .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, food_id);

        // 같은 정규화 별칭 재등록 거부(공백만 달라도 중복).
        assert!(super::add_food_alias_inner(&db, &food_id, "닭 정육")
            .await
            .is_err());

        super::remove_food_alias_inner(&db, "닭 정육")
            .await
            .unwrap();
        let after = super::fetch_food(&db, &food_id).await.unwrap();
        assert!(after.aliases.is_empty());
    }

    #[tokio::test]
    async fn archived_foods_hidden_unless_requested() {
        let db = fresh_db().await;
        let food_id = seed_food(&db, "옛날 식품", 100.0, 1.0).await;
        super::set_food_archived_inner(&db, &food_id, true)
            .await
            .unwrap();
        assert!(super::list_foods_inner(&db, None, false)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            super::list_foods_inner(&db, None, true)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn nan_macros_are_rejected() {
        let db = fresh_db().await;
        let result = super::upsert_food_inner(&db, food_input("bad", f64::NAN, 0.0)).await;
        assert!(result.is_err(), "NaN kcal은 경계에서 거부");
    }
}
