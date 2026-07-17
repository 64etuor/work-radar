//! 레시피 + 재료(g 정규화). 영양은 저장하지 않고 조회 시 커널로 계산 — 계획/기록에 넣는
//! 순간에만 스냅샷이 남는다(plans.rs / logs.rs).

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, clean_required, new_id, validate_positive};
use crate::db::Db;
use crate::diet;
use crate::error::AppError;
use crate::models::{
    CreateRecipeInput, DietMacros, Recipe, RecipeIngredient, RecipeIngredientInput,
    UpdateRecipeInput,
};

#[derive(Debug, sqlx::FromRow)]
struct RecipeRow {
    id: String,
    name: String,
    servings: f64,
    cook_minutes: Option<i32>,
    meal_tags: String,
    instructions: Option<String>,
    archived: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, sqlx::FromRow)]
struct IngredientRow {
    id: String,
    recipe_id: String,
    food_id: String,
    food_name: String,
    qty_g: f64,
    optional: bool,
    note: Option<String>,
    sort_rank: i32,
    kcal_per_100g: f64,
    protein_g_per_100g: f64,
    fat_g_per_100g: f64,
    carb_g_per_100g: f64,
}

const RECIPE_COLS: &str =
    "id, name, servings, cook_minutes, meal_tags, instructions, archived, created_at, updated_at";

fn parse_tags(raw: &str) -> Result<Vec<String>, AppError> {
    serde_json::from_str::<Vec<String>>(raw)
        .map_err(|e| AppError::unexpected("diet.recipe.tags.parse", e.to_string()))
}

fn serialize_tags(tags: Vec<String>) -> Result<String, AppError> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let trimmed = tag.trim().to_lowercase();
        if !trimmed.is_empty() && !out.contains(&trimmed) {
            out.push(trimmed);
        }
    }
    serde_json::to_string(&out).map_err(|e| AppError::unexpected("diet.recipe.tags", e.to_string()))
}

fn validate_ingredients(ingredients: &[RecipeIngredientInput]) -> Result<(), AppError> {
    for ing in ingredients {
        validate_positive(ing.qty_g, "diet.recipe.ingredient.qty")?;
    }
    Ok(())
}

async fn ingredient_rows(db: &Db, recipe_id: &str) -> Result<Vec<IngredientRow>, AppError> {
    Ok(sqlx::query_as::<_, IngredientRow>(
        "SELECT ri.id, ri.recipe_id, ri.food_id, f.name AS food_name, ri.qty_g, ri.optional, \
                ri.note, ri.sort_rank, f.kcal_per_100g, f.protein_g_per_100g, \
                f.fat_g_per_100g, f.carb_g_per_100g \
           FROM recipe_ingredients ri JOIN foods f ON f.id = ri.food_id \
          WHERE ri.recipe_id = ?1 ORDER BY ri.sort_rank, ri.id",
    )
    .bind(recipe_id)
    .fetch_all(db)
    .await?)
}

async fn assemble_recipe(db: &Db, row: RecipeRow) -> Result<Recipe, AppError> {
    let rows = ingredient_rows(db, &row.id).await?;
    // per-100g 매크로는 조회 시점 food 값 — 저장 스냅샷이 아님(의도).
    let per_qty: Vec<(DietMacros, f64)> = rows
        .iter()
        .map(|r| {
            (
                DietMacros {
                    kcal: r.kcal_per_100g,
                    protein_g: r.protein_g_per_100g,
                    fat_g: r.fat_g_per_100g,
                    carb_g: r.carb_g_per_100g,
                },
                r.qty_g,
            )
        })
        .collect();
    let total = diet::recipe_totals(per_qty.iter().map(|(m, q)| (m, *q)));
    let per_serving = diet::per_serving(&total, row.servings);
    let ingredients = rows
        .into_iter()
        .map(|r| RecipeIngredient {
            id: r.id,
            recipe_id: r.recipe_id,
            food_id: r.food_id,
            food_name: r.food_name,
            qty_g: r.qty_g,
            optional: r.optional,
            note: r.note,
            sort_rank: r.sort_rank,
        })
        .collect();
    Ok(Recipe {
        id: row.id,
        name: row.name,
        servings: row.servings,
        cook_minutes: row.cook_minutes,
        meal_tags: parse_tags(&row.meal_tags)?,
        instructions: row.instructions,
        archived: row.archived,
        ingredients,
        total,
        per_serving,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub(crate) async fn fetch_recipe(db: &Db, id: &str) -> Result<Recipe, AppError> {
    let row =
        sqlx::query_as::<_, RecipeRow>(&format!("SELECT {RECIPE_COLS} FROM recipes WHERE id = ?1"))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| AppError::not_found("diet.recipe.missing", "recipe not found"))?;
    assemble_recipe(db, row).await
}

/// (name, 1인분 매크로) — 계획/기록 스냅샷 계산용.
pub(crate) async fn recipe_per_serving(
    db: &Db,
    id: &str,
) -> Result<(String, DietMacros), AppError> {
    let recipe = fetch_recipe(db, id).await?;
    Ok((recipe.name, recipe.per_serving))
}

async fn insert_ingredients(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    recipe_id: &str,
    ingredients: &[RecipeIngredientInput],
) -> Result<(), AppError> {
    for (rank, ing) in ingredients.iter().enumerate() {
        sqlx::query(
            "INSERT INTO recipe_ingredients (id, recipe_id, food_id, qty_g, optional, note, sort_rank) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(new_id())
        .bind(recipe_id)
        .bind(&ing.food_id)
        .bind(ing.qty_g)
        .bind(ing.optional)
        .bind(clean_optional(ing.note.clone()).as_deref())
        .bind(rank as i32)
        .execute(&mut **tx)
        .await
        .map_err(|e| match e {
            // FK 위반 = 존재하지 않는 food — 사용자 입력 오류로 접는다.
            sqlx::Error::Database(ref db_err) if db_err.message().contains("FOREIGN KEY") => {
                AppError::validation("diet.recipe.ingredient.food", "ingredient food not found")
            }
            other => AppError::from(other),
        })?;
    }
    Ok(())
}

pub(crate) async fn create_recipe_inner(
    db: &Db,
    input: CreateRecipeInput,
) -> Result<Recipe, AppError> {
    let name = clean_required(&input.name, "diet.recipe.name", "recipe name")?;
    validate_positive(input.servings, "diet.recipe.servings")?;
    validate_ingredients(&input.ingredients)?;
    let tags = serialize_tags(input.meal_tags)?;
    let instructions = clean_optional(input.instructions);

    let id = new_id();
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO recipes (id, name, servings, cook_minutes, meal_tags, instructions) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&id)
    .bind(&name)
    .bind(input.servings)
    .bind(input.cook_minutes)
    .bind(&tags)
    .bind(instructions.as_deref())
    .execute(&mut *tx)
    .await?;
    insert_ingredients(&mut tx, &id, &input.ingredients).await?;
    tx.commit().await?;
    fetch_recipe(db, &id).await
}

pub(crate) async fn update_recipe_inner(
    db: &Db,
    input: UpdateRecipeInput,
) -> Result<Recipe, AppError> {
    let name = clean_required(&input.name, "diet.recipe.name", "recipe name")?;
    validate_positive(input.servings, "diet.recipe.servings")?;
    validate_ingredients(&input.ingredients)?;
    let tags = serialize_tags(input.meal_tags)?;
    let instructions = clean_optional(input.instructions);

    let mut tx = db.begin().await?;
    let updated = sqlx::query(
        "UPDATE recipes SET name = ?2, servings = ?3, cook_minutes = ?4, meal_tags = ?5, \
           instructions = ?6, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(&input.id)
    .bind(&name)
    .bind(input.servings)
    .bind(input.cook_minutes)
    .bind(&tags)
    .bind(instructions.as_deref())
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.recipe.missing",
            "recipe not found",
        ));
    }
    // 재료는 전체 교체(replace-all) — 과거 계획/기록은 스냅샷이라 영향 없음.
    sqlx::query("DELETE FROM recipe_ingredients WHERE recipe_id = ?1")
        .bind(&input.id)
        .execute(&mut *tx)
        .await?;
    insert_ingredients(&mut tx, &input.id, &input.ingredients).await?;
    tx.commit().await?;
    fetch_recipe(db, &input.id).await
}

pub(crate) async fn list_recipes_inner(
    db: &Db,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Recipe>, AppError> {
    let query = clean_optional(query);
    let rows = match query {
        Some(q) => {
            let like = format!("%{}%", q.to_lowercase());
            sqlx::query_as::<_, RecipeRow>(&format!(
                "SELECT {RECIPE_COLS} FROM recipes \
                  WHERE (?1 OR archived = 0) AND lower(name) LIKE ?2 ORDER BY name"
            ))
            .bind(include_archived)
            .bind(&like)
            .fetch_all(db)
            .await?
        }
        None => {
            sqlx::query_as::<_, RecipeRow>(&format!(
                "SELECT {RECIPE_COLS} FROM recipes WHERE (?1 OR archived = 0) ORDER BY name"
            ))
            .bind(include_archived)
            .fetch_all(db)
            .await?
        }
    };
    let mut recipes = Vec::with_capacity(rows.len());
    for row in rows {
        recipes.push(assemble_recipe(db, row).await?);
    }
    Ok(recipes)
}

pub(crate) async fn set_recipe_archived_inner(
    db: &Db,
    id: &str,
    archived: bool,
) -> Result<Recipe, AppError> {
    let updated =
        sqlx::query("UPDATE recipes SET archived = ?2, updated_at = datetime('now') WHERE id = ?1")
            .bind(id)
            .bind(archived)
            .execute(db)
            .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.recipe.missing",
            "recipe not found",
        ));
    }
    fetch_recipe(db, id).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_recipe(
    db: State<'_, Db>,
    input: CreateRecipeInput,
) -> Result<Recipe, AppError> {
    create_recipe_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_recipe(
    db: State<'_, Db>,
    input: UpdateRecipeInput,
) -> Result<Recipe, AppError> {
    update_recipe_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_recipe(db: State<'_, Db>, id: String) -> Result<Recipe, AppError> {
    fetch_recipe(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_recipes(
    db: State<'_, Db>,
    query: Option<String>,
    include_archived: bool,
) -> Result<Vec<Recipe>, AppError> {
    list_recipes_inner(db.inner(), query, include_archived).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_recipe_archived(
    db: State<'_, Db>,
    id: String,
    archived: bool,
) -> Result<Recipe, AppError> {
    set_recipe_archived_inner(db.inner(), &id, archived).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{CreateRecipeInput, RecipeIngredientInput};

    /// 알리오 올리오 2인분: 면 160g + 오일 20g. (food는 호출자가 seed.)
    pub(crate) async fn seed_recipe(
        db: &Db,
        name: &str,
        servings: f64,
        ingredients: Vec<(String, f64)>,
    ) -> String {
        super::create_recipe_inner(
            db,
            CreateRecipeInput {
                name: name.into(),
                servings,
                cook_minutes: Some(25),
                meal_tags: vec!["dinner".into()],
                instructions: None,
                ingredients: ingredients
                    .into_iter()
                    .map(|(food_id, qty_g)| RecipeIngredientInput {
                        food_id,
                        qty_g,
                        optional: false,
                        note: None,
                    })
                    .collect(),
            },
        )
        .await
        .expect("seed recipe")
        .id
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::seed_recipe;
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{CreateRecipeInput, RecipeIngredientInput, UpdateRecipeInput};

    #[tokio::test]
    async fn recipe_nutrition_is_computed_from_ingredients_at_query_time() {
        let db = fresh_db().await;
        let pasta = seed_food(&db, "파스타면", 371.0, 13.0).await;
        let oil = seed_food(&db, "올리브오일", 884.0, 0.0).await;
        let recipe_id = seed_recipe(
            &db,
            "알리오 올리오",
            2.0,
            vec![(pasta.clone(), 160.0), (oil, 20.0)],
        )
        .await;

        let recipe = super::fetch_recipe(&db, &recipe_id).await.unwrap();
        // 371×1.6 + 884×0.2 = 593.6 + 176.8 = 770.4 kcal 전체, 1인분 385.2.
        assert!((recipe.total.kcal - 770.4).abs() < 1e-9);
        assert!((recipe.per_serving.kcal - 385.2).abs() < 1e-9);
        assert_eq!(recipe.ingredients.len(), 2);
        assert_eq!(recipe.ingredients[0].food_name, "파스타면");
        assert_eq!(recipe.meal_tags, vec!["dinner"]);

        // food 영양 수정 → 레시피 조회값도 따라간다(저장 스냅샷 아님).
        sqlx::query("UPDATE foods SET kcal_per_100g = 400.0 WHERE id = ?1")
            .bind(&pasta)
            .execute(&db)
            .await
            .unwrap();
        let after = super::fetch_recipe(&db, &recipe_id).await.unwrap();
        assert!((after.total.kcal - (400.0 * 1.6 + 176.8)).abs() < 1e-9);
    }

    #[tokio::test]
    async fn update_replaces_ingredients_wholesale() {
        let db = fresh_db().await;
        let pasta = seed_food(&db, "파스타면", 371.0, 13.0).await;
        let shrimp = seed_food(&db, "새우", 85.0, 20.0).await;
        let recipe_id = seed_recipe(&db, "알리오 올리오", 1.0, vec![(pasta, 80.0)]).await;

        let updated = super::update_recipe_inner(
            &db,
            UpdateRecipeInput {
                id: recipe_id.clone(),
                name: "새우 알리오 올리오".into(),
                servings: 1.0,
                cook_minutes: Some(20),
                meal_tags: vec!["Dinner".into(), "dinner".into()],
                instructions: None,
                ingredients: vec![RecipeIngredientInput {
                    food_id: shrimp,
                    qty_g: 150.0,
                    optional: false,
                    note: None,
                }],
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "새우 알리오 올리오");
        assert_eq!(updated.ingredients.len(), 1, "replace-all");
        assert_eq!(updated.meal_tags, vec!["dinner"], "태그 dedup+lower");
        assert!((updated.total.kcal - 127.5).abs() < 1e-9);
    }

    #[tokio::test]
    async fn unknown_ingredient_food_is_a_validation_error_and_rolls_back() {
        let db = fresh_db().await;
        let result = super::create_recipe_inner(
            &db,
            CreateRecipeInput {
                name: "유령 레시피".into(),
                servings: 1.0,
                cook_minutes: None,
                meal_tags: vec![],
                instructions: None,
                ingredients: vec![RecipeIngredientInput {
                    food_id: "ghost".into(),
                    qty_g: 100.0,
                    optional: false,
                    note: None,
                }],
            },
        )
        .await;
        assert!(result.is_err());
        let count: (i32,) = sqlx::query_as("SELECT COUNT(*) FROM recipes")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "tx 롤백 — 반쪽 레시피 없음");
    }
}
