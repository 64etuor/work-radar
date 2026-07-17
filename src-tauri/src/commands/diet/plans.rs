//! 식단 계획 — meal_plans / planned_meals / planned_meal_items.
//! 항목 영양은 **추가 시점 스냅샷**(커널 계산) — 이후 food/recipe 수정이 과거 계획을 바꾸지 않는다.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::foods::food_per_100g;
use super::goals::active_diet_goal_inner;
use super::recipes::recipe_per_serving;
use super::{clean_optional, new_id, validate_date, validate_positive};
use crate::db::Db;
use crate::diet;
use crate::error::AppError;
use crate::models::{
    AddPlannedMealInput, AddPlannedMealItemInput, CreateMealPlanInput, MealPlan, MealPlanDetail,
    MealPlanStatus, MealType, PlannedMeal, PlannedMealItem, PlannedMealStatus,
};

const PLAN_COLS: &str = "id, start_date, end_date, status, calorie_target, protein_min_g, note, \
     created_at, updated_at";

#[derive(Debug, sqlx::FromRow)]
struct PlannedMealRow {
    id: String,
    plan_id: String,
    date: String,
    meal_type: MealType,
    scheduled_time: Option<String>,
    status: PlannedMealStatus,
    eaten_at: Option<String>,
    note: Option<String>,
    sort_rank: i32,
}

#[derive(Debug, sqlx::FromRow)]
struct ItemRow {
    id: String,
    planned_meal_id: String,
    recipe_id: Option<String>,
    food_id: Option<String>,
    label: String,
    servings: Option<f64>,
    qty_g: Option<f64>,
    kcal: f64,
    protein_g: f64,
    fat_g: f64,
    carb_g: f64,
    note: Option<String>,
}

/// 항목 조회 — label은 조회 시점 recipe/food 이름(둘 다 지워졌으면 '(removed)').
const ITEM_SELECT: &str = "SELECT i.id, i.planned_meal_id, i.recipe_id, i.food_id, \
       COALESCE(r.name, f.name, '(removed)') AS label, i.servings, i.qty_g, \
       i.kcal, i.protein_g, i.fat_g, i.carb_g, i.note \
  FROM planned_meal_items i \
  LEFT JOIN recipes r ON r.id = i.recipe_id \
  LEFT JOIN foods f ON f.id = i.food_id";

fn item_from_row(row: ItemRow) -> PlannedMealItem {
    PlannedMealItem {
        id: row.id,
        planned_meal_id: row.planned_meal_id,
        recipe_id: row.recipe_id,
        food_id: row.food_id,
        label: row.label,
        servings: row.servings,
        qty_g: row.qty_g,
        kcal: row.kcal,
        protein_g: row.protein_g,
        fat_g: row.fat_g,
        carb_g: row.carb_g,
        note: row.note,
    }
}

async fn items_for_meal(db: &Db, meal_id: &str) -> Result<Vec<PlannedMealItem>, AppError> {
    let rows = sqlx::query_as::<_, ItemRow>(&format!(
        "{ITEM_SELECT} WHERE i.planned_meal_id = ?1 ORDER BY i.id"
    ))
    .bind(meal_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(item_from_row).collect())
}

async fn meal_from_row(db: &Db, row: PlannedMealRow) -> Result<PlannedMeal, AppError> {
    let items = items_for_meal(db, &row.id).await?;
    Ok(PlannedMeal {
        id: row.id,
        plan_id: row.plan_id,
        date: row.date,
        meal_type: row.meal_type,
        scheduled_time: row.scheduled_time,
        status: row.status,
        eaten_at: row.eaten_at,
        note: row.note,
        sort_rank: row.sort_rank,
        items,
    })
}

pub(crate) async fn fetch_planned_meal(db: &Db, id: &str) -> Result<PlannedMeal, AppError> {
    let row = sqlx::query_as::<_, PlannedMealRow>(
        "SELECT id, plan_id, date, meal_type, scheduled_time, status, eaten_at, note, sort_rank \
           FROM planned_meals WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("diet.meal.missing", "planned meal not found"))?;
    meal_from_row(db, row).await
}

/// 날짜 기준 식사 조회(archived 계획 제외) — MCP `wr_diet_meals_for_date`가 사용.
pub(crate) async fn list_planned_meals_for_date(
    db: &Db,
    date: &str,
) -> Result<Vec<PlannedMeal>, AppError> {
    validate_date(date, "diet.meal.date")?;
    let rows = sqlx::query_as::<_, PlannedMealRow>(
        "SELECT m.id, m.plan_id, m.date, m.meal_type, m.scheduled_time, m.status, m.eaten_at, \
                m.note, m.sort_rank \
           FROM planned_meals m JOIN meal_plans p ON p.id = m.plan_id \
          WHERE m.date = ?1 AND p.status != 'archived' \
          ORDER BY m.sort_rank, m.scheduled_time, m.id",
    )
    .bind(date.trim())
    .fetch_all(db)
    .await?;
    let mut meals = Vec::with_capacity(rows.len());
    for row in rows {
        meals.push(meal_from_row(db, row).await?);
    }
    Ok(meals)
}

pub(crate) async fn create_meal_plan_inner(
    db: &Db,
    input: CreateMealPlanInput,
) -> Result<MealPlan, AppError> {
    let start = validate_date(&input.start_date, "diet.plan.start_date")?;
    let end = validate_date(&input.end_date, "diet.plan.end_date")?;
    if end < start {
        return Err(AppError::validation(
            "diet.plan.window",
            "end_date must be on/after start_date",
        ));
    }
    let note = clean_optional(input.note);
    // 생성 시점 활성 목표 스냅샷 — 이후 목표 변경이 이 계획의 기준을 바꾸지 않는다.
    let goal = active_diet_goal_inner(db, input.start_date.trim()).await?;
    Ok(sqlx::query_as::<_, MealPlan>(&format!(
        "INSERT INTO meal_plans (id, start_date, end_date, calorie_target, protein_min_g, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING {PLAN_COLS}"
    ))
    .bind(new_id())
    .bind(input.start_date.trim())
    .bind(input.end_date.trim())
    .bind(goal.as_ref().map(|g| g.calorie_target))
    .bind(goal.as_ref().and_then(|g| g.protein_min_g))
    .bind(note.as_deref())
    .fetch_one(db)
    .await?)
}

pub(crate) async fn list_meal_plans_inner(db: &Db) -> Result<Vec<MealPlan>, AppError> {
    Ok(sqlx::query_as::<_, MealPlan>(&format!(
        "SELECT {PLAN_COLS} FROM meal_plans ORDER BY start_date DESC, created_at DESC"
    ))
    .fetch_all(db)
    .await?)
}

pub(crate) async fn get_meal_plan_inner(db: &Db, id: &str) -> Result<MealPlanDetail, AppError> {
    let plan =
        sqlx::query_as::<_, MealPlan>(&format!("SELECT {PLAN_COLS} FROM meal_plans WHERE id = ?1"))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| AppError::not_found("diet.plan.missing", "meal plan not found"))?;
    let rows = sqlx::query_as::<_, PlannedMealRow>(
        "SELECT id, plan_id, date, meal_type, scheduled_time, status, eaten_at, note, sort_rank \
           FROM planned_meals WHERE plan_id = ?1 ORDER BY date, sort_rank, id",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    let mut meals = Vec::with_capacity(rows.len());
    for row in rows {
        meals.push(meal_from_row(db, row).await?);
    }
    Ok(MealPlanDetail { plan, meals })
}

pub(crate) async fn set_meal_plan_status_inner(
    db: &Db,
    id: &str,
    status: MealPlanStatus,
) -> Result<MealPlan, AppError> {
    sqlx::query_as::<_, MealPlan>(&format!(
        "UPDATE meal_plans SET status = ?2, updated_at = datetime('now') WHERE id = ?1 \
         RETURNING {PLAN_COLS}"
    ))
    .bind(id)
    .bind(status)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("diet.plan.missing", "meal plan not found"))
}

pub(crate) async fn add_planned_meal_inner(
    db: &Db,
    input: AddPlannedMealInput,
) -> Result<PlannedMeal, AppError> {
    let date = validate_date(&input.date, "diet.meal.date")?;
    let plan: Option<(String, String)> =
        sqlx::query_as("SELECT start_date, end_date FROM meal_plans WHERE id = ?1")
            .bind(&input.plan_id)
            .fetch_optional(db)
            .await?;
    let (start, end) =
        plan.ok_or_else(|| AppError::not_found("diet.plan.missing", "meal plan not found"))?;
    let date_s = date.format("%Y-%m-%d").to_string();
    if date_s.as_str() < start.as_str() || date_s.as_str() > end.as_str() {
        return Err(AppError::validation(
            "diet.meal.date_window",
            "date is outside the plan window",
        ));
    }
    let id = new_id();
    sqlx::query(
        "INSERT INTO planned_meals (id, plan_id, date, meal_type, scheduled_time, note, sort_rank) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&id)
    .bind(&input.plan_id)
    .bind(&date_s)
    .bind(input.meal_type)
    .bind(clean_optional(input.scheduled_time).as_deref())
    .bind(clean_optional(input.note).as_deref())
    .bind(input.sort_rank)
    .execute(db)
    .await?;
    fetch_planned_meal(db, &id).await
}

pub(crate) async fn remove_planned_meal_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM planned_meals WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn set_planned_meal_status_inner(
    db: &Db,
    id: &str,
    status: PlannedMealStatus,
) -> Result<PlannedMeal, AppError> {
    let updated = sqlx::query(
        "UPDATE planned_meals SET status = ?2, \
           eaten_at = CASE WHEN ?2 IN ('eaten','partial') THEN COALESCE(eaten_at, datetime('now')) \
                           ELSE NULL END \
         WHERE id = ?1",
    )
    .bind(id)
    .bind(status)
    .execute(db)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(AppError::not_found(
            "diet.meal.missing",
            "planned meal not found",
        ));
    }
    fetch_planned_meal(db, id).await
}

pub(crate) async fn add_planned_meal_item_inner(
    db: &Db,
    input: AddPlannedMealItemInput,
) -> Result<PlannedMealItem, AppError> {
    // recipe_id XOR food_id 강제(스키마 CHECK와 동일 규칙을 경계에서 먼저).
    let macros = match (&input.recipe_id, &input.food_id) {
        (Some(recipe_id), None) => {
            let servings = input.servings.ok_or_else(|| {
                AppError::validation(
                    "diet.item.servings",
                    "servings is required for a recipe item",
                )
            })?;
            validate_positive(servings, "diet.item.servings")?;
            let (_, per_serving) = recipe_per_serving(db, recipe_id).await?;
            diet::scale_macros(&per_serving, servings)
        }
        (None, Some(food_id)) => {
            let qty_g = input.qty_g.ok_or_else(|| {
                AppError::validation("diet.item.qty", "qty_g is required for a food item")
            })?;
            validate_positive(qty_g, "diet.item.qty")?;
            let (_, per_100g) = food_per_100g(db, food_id).await?;
            diet::macros_for_qty(&per_100g, qty_g)
        }
        _ => {
            return Err(AppError::validation(
                "diet.item.source",
                "exactly one of recipe_id or food_id is required",
            ))
        }
    };
    // 존재 확인(친절한 에러) — meal이 없으면 FK가 막지만 코드가 불투명해진다.
    let meal_exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM planned_meals WHERE id = ?1")
            .bind(&input.planned_meal_id)
            .fetch_optional(db)
            .await?;
    if meal_exists.is_none() {
        return Err(AppError::not_found(
            "diet.meal.missing",
            "planned meal not found",
        ));
    }

    let id = new_id();
    sqlx::query(
        "INSERT INTO planned_meal_items \
         (id, planned_meal_id, recipe_id, food_id, servings, qty_g, kcal, protein_g, fat_g, carb_g, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )
    .bind(&id)
    .bind(&input.planned_meal_id)
    .bind(input.recipe_id.as_deref())
    .bind(input.food_id.as_deref())
    .bind(if input.recipe_id.is_some() { input.servings } else { None })
    .bind(if input.food_id.is_some() { input.qty_g } else { None })
    .bind(macros.kcal)
    .bind(macros.protein_g)
    .bind(macros.fat_g)
    .bind(macros.carb_g)
    .bind(clean_optional(input.note).as_deref())
    .execute(db)
    .await?;

    let row = sqlx::query_as::<_, ItemRow>(&format!("{ITEM_SELECT} WHERE i.id = ?1"))
        .bind(&id)
        .fetch_one(db)
        .await?;
    Ok(item_from_row(row))
}

pub(crate) async fn remove_planned_meal_item_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM planned_meal_items WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn create_meal_plan(
    db: State<'_, Db>,
    input: CreateMealPlanInput,
) -> Result<MealPlan, AppError> {
    create_meal_plan_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_meal_plans(db: State<'_, Db>) -> Result<Vec<MealPlan>, AppError> {
    list_meal_plans_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_meal_plan(db: State<'_, Db>, id: String) -> Result<MealPlanDetail, AppError> {
    get_meal_plan_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_meal_plan_status(
    db: State<'_, Db>,
    id: String,
    status: MealPlanStatus,
) -> Result<MealPlan, AppError> {
    set_meal_plan_status_inner(db.inner(), &id, status).await
}

#[tauri::command]
#[specta::specta]
pub async fn add_planned_meal(
    db: State<'_, Db>,
    input: AddPlannedMealInput,
) -> Result<PlannedMeal, AppError> {
    add_planned_meal_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_planned_meal(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    remove_planned_meal_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_planned_meal_status(
    db: State<'_, Db>,
    id: String,
    status: PlannedMealStatus,
) -> Result<PlannedMeal, AppError> {
    set_planned_meal_status_inner(db.inner(), &id, status).await
}

#[tauri::command]
#[specta::specta]
pub async fn add_planned_meal_item(
    db: State<'_, Db>,
    input: AddPlannedMealItemInput,
) -> Result<PlannedMealItem, AppError> {
    add_planned_meal_item_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn remove_planned_meal_item(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    remove_planned_meal_item_inner(db.inner(), &id).await
}

#[cfg(test)]
pub(crate) mod test_support {
    use crate::db::Db;
    use crate::models::{AddPlannedMealInput, CreateMealPlanInput, MealType};

    pub(crate) async fn seed_plan(db: &Db, start: &str, end: &str) -> String {
        super::create_meal_plan_inner(
            db,
            CreateMealPlanInput {
                start_date: start.into(),
                end_date: end.into(),
                note: None,
            },
        )
        .await
        .expect("seed plan")
        .id
    }

    pub(crate) async fn seed_meal(
        db: &Db,
        plan_id: &str,
        date: &str,
        meal_type: MealType,
    ) -> String {
        super::add_planned_meal_inner(
            db,
            AddPlannedMealInput {
                plan_id: plan_id.into(),
                date: date.into(),
                meal_type,
                scheduled_time: None,
                note: None,
                sort_rank: 0,
            },
        )
        .await
        .expect("seed meal")
        .id
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{seed_meal, seed_plan};
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::diet::recipes::test_support::seed_recipe;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{AddPlannedMealItemInput, MealType, PlannedMealStatus, SetDietGoalInput};

    #[tokio::test]
    async fn plan_snapshots_active_goal_at_creation() {
        let db = fresh_db().await;
        crate::commands::diet::goals::set_diet_goal_inner(
            &db,
            SetDietGoalInput {
                effective_date: "2026-07-01".into(),
                calorie_target: 2200.0,
                calorie_tolerance_pct: Some(7.0),
                protein_min_g: Some(140.0),
                fat_min_g: None,
                carb_target_g: None,
                fiber_min_g: None,
                note: None,
            },
        )
        .await
        .unwrap();

        let plan_id = seed_plan(&db, "2026-07-20", "2026-07-26").await;
        let detail = super::get_meal_plan_inner(&db, &plan_id).await.unwrap();
        assert_eq!(detail.plan.calorie_target, Some(2200.0));
        assert_eq!(detail.plan.protein_min_g, Some(140.0));

        // 이후 목표를 바꿔도 기존 계획 스냅샷은 불변.
        crate::commands::diet::goals::set_diet_goal_inner(
            &db,
            SetDietGoalInput {
                effective_date: "2026-07-10".into(),
                calorie_target: 1800.0,
                calorie_tolerance_pct: None,
                protein_min_g: None,
                fat_min_g: None,
                carb_target_g: None,
                fiber_min_g: None,
                note: None,
            },
        )
        .await
        .unwrap();
        let after = super::get_meal_plan_inner(&db, &plan_id).await.unwrap();
        assert_eq!(after.plan.calorie_target, Some(2200.0));
    }

    #[tokio::test]
    async fn item_snapshot_survives_later_food_edits() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let plan_id = seed_plan(&db, "2026-07-20", "2026-07-26").await;
        let meal_id = seed_meal(&db, &plan_id, "2026-07-20", MealType::Lunch).await;

        let item = super::add_planned_meal_item_inner(
            &db,
            AddPlannedMealItemInput {
                planned_meal_id: meal_id.clone(),
                recipe_id: None,
                food_id: Some(chicken.clone()),
                servings: None,
                qty_g: Some(150.0),
                note: None,
            },
        )
        .await
        .unwrap();
        assert!((item.kcal - 180.0).abs() < 1e-9);
        assert!((item.protein_g - 33.0).abs() < 1e-9);
        assert_eq!(item.label, "닭다리살");

        // food 영양을 바꿔도 계획 항목 스냅샷은 그대로(과거 계획 불변 원칙).
        sqlx::query("UPDATE foods SET kcal_per_100g = 999.0 WHERE id = ?1")
            .bind(&chicken)
            .execute(&db)
            .await
            .unwrap();
        let meal = super::fetch_planned_meal(&db, &meal_id).await.unwrap();
        assert!((meal.items[0].kcal - 180.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn recipe_item_uses_per_serving_snapshot() {
        let db = fresh_db().await;
        let pasta = seed_food(&db, "파스타면", 371.0, 13.0).await;
        let recipe = seed_recipe(&db, "알리오 올리오", 2.0, vec![(pasta, 160.0)]).await;
        let plan_id = seed_plan(&db, "2026-07-20", "2026-07-26").await;
        let meal_id = seed_meal(&db, &plan_id, "2026-07-21", MealType::Dinner).await;

        let item = super::add_planned_meal_item_inner(
            &db,
            AddPlannedMealItemInput {
                planned_meal_id: meal_id,
                recipe_id: Some(recipe),
                food_id: None,
                servings: Some(1.5),
                qty_g: None,
                note: None,
            },
        )
        .await
        .unwrap();
        // 전체 593.6 / 2인분 = 296.8, ×1.5 = 445.2.
        assert!((item.kcal - 445.2).abs() < 1e-9);
    }

    #[tokio::test]
    async fn item_source_must_be_exactly_one_and_meal_dates_stay_in_window() {
        let db = fresh_db().await;
        let plan_id = seed_plan(&db, "2026-07-20", "2026-07-26").await;
        let meal_id = seed_meal(&db, &plan_id, "2026-07-20", MealType::Breakfast).await;

        // 둘 다 없음 / 둘 다 있음 → validation.
        let neither = super::add_planned_meal_item_inner(
            &db,
            AddPlannedMealItemInput {
                planned_meal_id: meal_id.clone(),
                recipe_id: None,
                food_id: None,
                servings: None,
                qty_g: None,
                note: None,
            },
        )
        .await;
        assert!(neither.is_err());

        // 계획 창 밖 날짜 거부.
        let out_of_window = super::add_planned_meal_inner(
            &db,
            crate::models::AddPlannedMealInput {
                plan_id: plan_id.clone(),
                date: "2026-08-01".into(),
                meal_type: MealType::Lunch,
                scheduled_time: None,
                note: None,
                sort_rank: 0,
            },
        )
        .await;
        assert!(out_of_window.is_err());

        // skipped 전이 + 되돌리기(planned로) — eaten_at 정리.
        let skipped =
            super::set_planned_meal_status_inner(&db, &meal_id, PlannedMealStatus::Skipped)
                .await
                .unwrap();
        assert_eq!(skipped.status, PlannedMealStatus::Skipped);
        assert!(skipped.eaten_at.is_none());
        let eaten = super::set_planned_meal_status_inner(&db, &meal_id, PlannedMealStatus::Eaten)
            .await
            .unwrap();
        assert!(eaten.eaten_at.is_some());
        let back = super::set_planned_meal_status_inner(&db, &meal_id, PlannedMealStatus::Planned)
            .await
            .unwrap();
        assert!(back.eaten_at.is_none(), "planned로 되돌리면 eaten_at 제거");
    }
}
