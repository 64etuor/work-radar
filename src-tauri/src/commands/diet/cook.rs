//! 조리(cook) — 레시피를 실제로 만들어 먹는 **한 번의 사실**을 단일 tx로 기록한다.
//! 설계 정본: `docs/plans/2026-07-26-recipe-authoring-workout.md` §6.
//!
//! 0073은 "섭취 기록 → 재고 자동 차감"을 의도적으로 미뤄뒀다(`record_meal_log`은 재고를 건드리지
//! 않는다). 여기서 그 결정을 **명시적 커맨드**로 해소한다:
//!
//! - `record_meal_log`은 **여전히** 재고를 건드리지 않는다.
//! - 재고 차감 경로는 `consume_pantry`(명시)와 `cook_recipe`(조리) 둘뿐이고, 후자는
//!   `pantry_events.meal_log_id`로 로그와 연결되므로 감사에서 이중 계상이 식별된다.
//! - 재료가 부족하면 **전체 롤백** — 반쯤 차감하고 먹은 것으로 기록하지 않는다.
//!
//! 추천(`recipe_suggestions`)은 결정론 커널(`diet::suggest_recipes`)의 얇은 배선이다.
//! LLM이 아니라 재고 커버리지·유통기한 압력·목표 적합도의 고정 가중 합이 순위를 정한다.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, new_id, validate_date, validate_positive};
use crate::db::Db;
use crate::diet::{self, FefoLot};
use crate::error::AppError;
use crate::models::{
    CookRecipeInput, CookRecipeResult, DietMacros, MealLog, PantryEventKind, RecipeSuggestion,
};

/// 부족 재료 한 줄 — 에러 메시지에 실어 "무엇이 얼마나 모자라 실패했는지"를 그대로 노출한다.
fn shortfall_line(name: &str, need: f64, have: f64) -> String {
    format!("{name} {:.0}g 필요 / {:.0}g 보유", need, have)
}

pub(crate) async fn cook_recipe_inner(
    db: &Db,
    input: CookRecipeInput,
) -> Result<CookRecipeResult, AppError> {
    validate_date(&input.date, "diet.cook.date")?;
    let servings = input.servings.unwrap_or(1.0);
    validate_positive(servings, "diet.cook.servings")?;
    let at = clean_optional(input.at).unwrap_or_else(|| crate::timezone::now_local().to_rfc3339());
    let note = clean_optional(input.note);
    let consume = input.consume_pantry.unwrap_or(true);

    // 스케일 + 영양 스냅샷은 tx 진입 전에 계산해 둔다(검증은 tx 밖에서 끝낸다 — §4 규약).
    let scaled = super::recipes::scaled_recipe_inner(db, &input.recipe_id, Some(servings)).await?;
    let macros = DietMacros {
        kcal: scaled.total.kcal,
        protein_g: scaled.total.protein_g,
        fat_g: scaled.total.fat_g,
        carb_g: scaled.total.carb_g,
    };

    let mut tx = db.begin().await?;

    // 1) 계획 연결이 있으면 상태 전이(로그 없는 eaten이 남지 않게 같은 tx).
    if let Some(planned_meal_id) = input.planned_meal_id.as_deref() {
        let updated = sqlx::query(
            "UPDATE planned_meals SET status = 'eaten', eaten_at = ?2 \
                                   WHERE id = ?1",
        )
        .bind(planned_meal_id)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 0 {
            return Err(AppError::not_found(
                "diet.cook.planned_meal",
                "planned meal not found",
            ));
        }
    }

    // 2) 섭취 기록(영양 = 커널 스냅샷 — 이후 레시피 수정에 소급되지 않는다).
    let log_id = new_id();
    sqlx::query(
        "INSERT INTO meal_logs (id, date, at, planned_meal_id, recipe_id, description, servings, \
           kcal, protein_g, fat_g, carb_g, satisfaction, fullness, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
    )
    .bind(&log_id)
    .bind(input.date.trim())
    .bind(&at)
    .bind(input.planned_meal_id.as_deref())
    .bind(&input.recipe_id)
    .bind(&scaled.name)
    .bind(servings)
    .bind(macros.kcal)
    .bind(macros.protein_g)
    .bind(macros.fat_g)
    .bind(macros.carb_g)
    .bind(input.satisfaction)
    .bind(input.fullness)
    .bind(note.as_deref())
    .execute(&mut *tx)
    .await?;

    // 3) 재료별 FEFO 차감 + consumed 이벤트. 읽기를 tx 안에 두어 동시 조리 레이스에서
    //    잘못된 계획이 커밋되지 않게 한다(`remaining_qty_g >= 0` CHECK가 최종 방어선).
    let mut consumed_g = 0.0;
    let mut lots_touched = 0u32;
    let mut shortfalls: Vec<String> = Vec::new();

    if consume {
        // **필수 재료를 optional보다 먼저 차감한다.** 같은 food_id가 optional 행과 필수 행에
        // 함께 있으면(예: "두부 50g 선택" + "두부 100g") 배열 순서에 따라 optional이 재고를
        // 먼저 먹어 필수 재료가 부당하게 부족 판정되고 조리 전체가 실패한다 — optional은
        // 남는 재고에만 손대야 한다(critic 지적).
        let ordered: Vec<&crate::models::ScaledIngredient> = scaled
            .ingredients
            .iter()
            .filter(|i| !i.optional)
            .chain(scaled.ingredients.iter().filter(|i| i.optional))
            .collect();

        for ingredient in ordered {
            // to_taste(간 맞춰서)는 명목값이라 재고에서 빼지 않는다 — 소금 0.4g 때문에
            // 조리가 실패하면 계약이 쓸모없어진다.
            if ingredient.to_taste {
                continue;
            }
            let lots: Vec<(String, Option<String>, f64)> = sqlx::query_as(
                "SELECT id, expires_on, remaining_qty_g FROM pantry_lots \
                  WHERE food_id = ?1 AND remaining_qty_g > 0 \
                  ORDER BY acquired_on, created_at",
            )
            .bind(&ingredient.food_id)
            .fetch_all(&mut *tx)
            .await?;
            let fefo_lots: Vec<FefoLot> = lots
                .into_iter()
                .map(|(id, expires_on, remaining_qty_g)| FefoLot {
                    id,
                    expires_on,
                    remaining_qty_g,
                })
                .collect();
            let available: f64 = fefo_lots.iter().map(|l| l.remaining_qty_g).sum();
            let (takes, shortfall) = diet::fefo_allocate(&fefo_lots, ingredient.qty_g);

            if shortfall > 1e-9 {
                // optional 재료의 부족은 조리를 막지 않는다 — 있으면 쓰고 없으면 건너뛴다.
                if ingredient.optional {
                    continue;
                }
                shortfalls.push(shortfall_line(
                    &ingredient.food_name,
                    ingredient.qty_g,
                    available,
                ));
                continue;
            }

            for (lot_id, take) in &takes {
                sqlx::query(
                    "UPDATE pantry_lots SET remaining_qty_g = remaining_qty_g - ?2, \
                       updated_at = datetime('now') WHERE id = ?1",
                )
                .bind(lot_id)
                .bind(take)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO pantry_events (id, lot_id, kind, delta_g, reason, meal_log_id) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .bind(new_id())
                .bind(lot_id)
                .bind(PantryEventKind::Consumed)
                .bind(-take)
                .bind(format!("cooked {}", scaled.name))
                .bind(&log_id)
                .execute(&mut *tx)
                .await?;
                consumed_g += take;
                lots_touched += 1;
            }
        }

        // 부족분이 하나라도 있으면 **전체 롤백**. 부분 차감 + "먹었다" 기록이 남으면
        // 재고와 원장이 동시에 틀어진다.
        if !shortfalls.is_empty() {
            return Err(AppError::validation(
                "diet.cook.insufficient_stock",
                format!(
                    "not enough stock to cook — nothing was consumed or logged: {}",
                    shortfalls.join("; ")
                ),
            ));
        }
    }

    let log = sqlx::query_as::<_, MealLog>(&format!(
        "SELECT {} FROM meal_logs WHERE id = ?1",
        super::logs::LOG_COLS
    ))
    .bind(&log_id)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(CookRecipeResult {
        log,
        consumed_g,
        lots_touched: lots_touched as i32,
        pantry_consumed: consume,
    })
}

/// 재고 기반 추천. 활성 목표가 있으면 "끼니당 kcal"(목표 ÷ 하루 끼니 수 가정 3)로 적합도를 본다.
pub(crate) async fn recipe_suggestions_inner(
    db: &Db,
    today: &str,
    limit: Option<i32>,
) -> Result<Vec<RecipeSuggestion>, AppError> {
    validate_date(today, "diet.suggest.date")?;
    let limit = limit.unwrap_or(10).clamp(1, 50) as usize;

    let recipes = super::recipes::list_recipes_inner(db, None, false).await?;
    let candidates: Vec<diet::SuggestionCandidate> = recipes
        .iter()
        .map(|r| diet::SuggestionCandidate {
            recipe_id: r.id.clone(),
            name: r.name.clone(),
            servings: r.servings,
            per_serving: r.per_serving,
            ingredients: r
                .ingredients
                .iter()
                // to_taste는 재고 커버리지 계산에서 제외 — 소금 유무로 추천 순위가 흔들리면 안 된다.
                .filter(|i| !i.to_taste)
                .map(|i| diet::SuggestionIngredient {
                    food_id: i.food_id.clone(),
                    food_name: i.food_name.clone(),
                    qty_g: i.qty_g,
                })
                .collect(),
        })
        .collect();

    // 재고는 식품별 합계 + 그중 가장 이른 유통기한(FEFO 압력의 입력).
    let stock: Vec<diet::StockEntry> = sqlx::query_as::<_, (String, f64, Option<String>)>(
        "SELECT food_id, COALESCE(SUM(remaining_qty_g), 0.0), MIN(expires_on) \
           FROM pantry_lots WHERE remaining_qty_g > 0 GROUP BY food_id",
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(food_id, available_g, earliest_expiry)| diet::StockEntry {
        food_id,
        available_g,
        earliest_expiry,
    })
    .collect();

    let target_per_meal = super::goals::active_diet_goal_inner(db, today)
        .await?
        .map(|goal| goal.calorie_target / 3.0);

    Ok(diet::suggest_recipes(
        &candidates,
        &stock,
        today,
        target_per_meal,
        limit,
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn cook_recipe(
    db: State<'_, Db>,
    input: CookRecipeInput,
) -> Result<CookRecipeResult, AppError> {
    cook_recipe_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn recipe_suggestions(
    db: State<'_, Db>,
    today: String,
    limit: Option<i32>,
) -> Result<Vec<RecipeSuggestion>, AppError> {
    recipe_suggestions_inner(db.inner(), &today, limit).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::diet::recipes::test_support::seed_recipe;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{AddPantryLotInput, PantryLocation};

    async fn stock_up(db: &Db, food: &str, qty_g: f64, expires_on: Option<&str>) {
        crate::commands::diet::pantry::add_pantry_lot_inner(
            db,
            AddPantryLotInput {
                food_id: food.to_string(),
                location: PantryLocation::Fridge,
                acquired_on: "2026-07-20".into(),
                expires_on: expires_on.map(str::to_string),
                initial_qty_g: qty_g,
                note: None,
            },
        )
        .await
        .expect("stock up");
    }

    fn cook(recipe_id: &str, servings: f64) -> CookRecipeInput {
        CookRecipeInput {
            recipe_id: recipe_id.to_string(),
            servings: Some(servings),
            date: "2026-07-26".into(),
            at: Some("2026-07-26T19:00:00+09:00".into()),
            planned_meal_id: None,
            consume_pantry: None,
            satisfaction: None,
            fullness: None,
            note: None,
        }
    }

    #[tokio::test]
    async fn cooking_consumes_stock_and_logs_the_meal_in_one_shot() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let recipe = seed_recipe(&db, "두부조림", 2.0, vec![(tofu.clone(), 200.0)]).await;
        stock_up(&db, &tofu, 500.0, Some("2026-07-30")).await;

        let result = cook_recipe_inner(&db, cook(&recipe, 2.0)).await.unwrap();
        assert!(result.pantry_consumed);
        assert!((result.consumed_g - 200.0).abs() < 1e-9);
        assert_eq!(result.lots_touched, 1);
        // 2인분 전체 = 200g × 0.8kcal/g = 160kcal.
        assert!((result.log.kcal - 160.0).abs() < 1e-9);
        assert_eq!(result.log.recipe_id.as_deref(), Some(recipe.as_str()));

        let remaining: (f64,) =
            sqlx::query_as("SELECT remaining_qty_g FROM pantry_lots WHERE food_id = ?1")
                .bind(&tofu)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!((remaining.0 - 300.0).abs() < 1e-9);

        // consumed 이벤트가 로그에 연결돼 있다(감사에서 이중 계상 식별 가능).
        let event: (String, f64, Option<String>) = sqlx::query_as(
            "SELECT kind, delta_g, meal_log_id FROM pantry_events WHERE kind = 'consumed'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(event.0, "consumed");
        assert!((event.1 - -200.0).abs() < 1e-9);
        assert_eq!(event.2.as_deref(), Some(result.log.id.as_str()));
    }

    #[tokio::test]
    async fn insufficient_stock_rolls_back_everything() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let paste = seed_food(&db, "된장", 190.0, 12.0).await;
        let recipe = seed_recipe(
            &db,
            "된장찌개",
            2.0,
            vec![(tofu.clone(), 200.0), (paste.clone(), 30.0)],
        )
        .await;
        // 두부는 충분, 된장은 부족 → 두부가 먼저 차감되더라도 전체가 롤백돼야 한다.
        stock_up(&db, &tofu, 500.0, None).await;
        stock_up(&db, &paste, 10.0, None).await;

        let err = cook_recipe_inner(&db, cook(&recipe, 2.0))
            .await
            .expect_err("재고 부족은 실패");
        let msg = format!("{err:?}");
        assert!(msg.contains("된장"), "무엇이 모자란지 노출: {msg}");

        let logs: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM meal_logs")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(logs.0, 0, "먹은 기록이 남지 않았다");
        let events: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM pantry_events WHERE kind = 'consumed'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(events.0, 0, "부분 차감 0건");
        let tofu_left: (f64,) =
            sqlx::query_as("SELECT remaining_qty_g FROM pantry_lots WHERE food_id = ?1")
                .bind(&tofu)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(
            (tofu_left.0 - 500.0).abs() < 1e-9,
            "먼저 처리된 재료도 원복됐다"
        );
    }

    #[tokio::test]
    async fn record_meal_log_still_leaves_stock_alone_so_there_is_no_double_count() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let recipe = seed_recipe(&db, "두부조림", 1.0, vec![(tofu.clone(), 100.0)]).await;
        stock_up(&db, &tofu, 300.0, None).await;

        crate::commands::diet::logs::record_meal_log_inner(
            &db,
            crate::models::RecordMealLogInput {
                date: "2026-07-26".into(),
                at: None,
                planned_meal_id: None,
                ratio: None,
                recipe_id: Some(recipe.clone()),
                servings: Some(1.0),
                food_id: None,
                qty_g: None,
                manual: None,
                description: None,
                satisfaction: None,
                fullness: None,
                note: None,
            },
        )
        .await
        .unwrap();

        let after_log: (f64,) =
            sqlx::query_as("SELECT remaining_qty_g FROM pantry_lots WHERE food_id = ?1")
                .bind(&tofu)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(
            (after_log.0 - 300.0).abs() < 1e-9,
            "record_meal_log은 재고를 건드리지 않는다 — cook_recipe와 이중 차감이 불가능"
        );

        // 같은 레시피를 조리하면 그때만 차감된다.
        cook_recipe_inner(&db, cook(&recipe, 1.0)).await.unwrap();
        let after_cook: (f64,) =
            sqlx::query_as("SELECT remaining_qty_g FROM pantry_lots WHERE food_id = ?1")
                .bind(&tofu)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!((after_cook.0 - 200.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn cooking_without_consuming_only_logs() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let recipe = seed_recipe(&db, "두부조림", 1.0, vec![(tofu.clone(), 100.0)]).await;
        // 재고가 아예 없어도 consume_pantry=false면 기록은 된다(외식/남의 집 조리).
        let mut input = cook(&recipe, 1.0);
        input.consume_pantry = Some(false);
        let result = cook_recipe_inner(&db, input).await.unwrap();
        assert!(!result.pantry_consumed);
        assert_eq!(result.consumed_g, 0.0);
        assert_eq!(result.lots_touched, 0);
        assert!((result.log.kcal - 80.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn optional_and_to_taste_ingredients_do_not_block_cooking() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let salt = seed_food(&db, "소금", 0.0, 0.0).await;
        let herb = seed_food(&db, "고수", 20.0, 2.0).await;
        let recipe = super::super::recipes::create_recipe_inner(
            &db,
            crate::models::CreateRecipeInput {
                name: "두부조림".into(),
                servings: 1.0,
                cook_minutes: None,
                meal_tags: vec![],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![
                    crate::commands::diet::recipes::test_support::ingredient(tofu.clone(), 100.0),
                    crate::models::RecipeIngredientInput {
                        food_id: salt,
                        qty_g: Some(2.0),
                        qty: Some(1.0),
                        unit: Some("pinch".into()),
                        to_taste: true,
                        optional: false,
                        note: None,
                    },
                    crate::models::RecipeIngredientInput {
                        food_id: herb,
                        qty_g: Some(5.0),
                        qty: None,
                        unit: None,
                        to_taste: false,
                        optional: true,
                        note: None,
                    },
                ],
                steps: vec![],
                changed_by: None,
            },
        )
        .await
        .unwrap()
        .id;
        // 두부만 재고에 있다 — 소금(간 맞춰서)과 고수(선택)는 없어도 조리가 성립해야 한다.
        stock_up(&db, &tofu, 150.0, None).await;

        let result = cook_recipe_inner(&db, cook(&recipe, 1.0)).await.unwrap();
        assert!((result.consumed_g - 100.0).abs() < 1e-9, "두부만 차감");
        assert_eq!(result.lots_touched, 1);
    }

    #[tokio::test]
    async fn optional_row_does_not_starve_a_required_row_of_the_same_food() {
        // critic 지적 회귀 가드: 같은 두부가 optional 50g + 필수 100g로 들어있고 재고는 120g.
        // optional을 먼저 차감하면 필수 100g이 30g 부족해져 조리 전체가 부당하게 실패한다.
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let recipe = super::super::recipes::create_recipe_inner(
            &db,
            crate::models::CreateRecipeInput {
                name: "두부 두 번 쓰기".into(),
                servings: 1.0,
                cook_minutes: None,
                meal_tags: vec![],
                source_url: None,
                yield_g: None,
                notes: None,
                ingredients: vec![
                    // optional이 배열에서 **앞**에 온다 — 순서가 결과를 바꾸면 안 된다.
                    crate::models::RecipeIngredientInput {
                        food_id: tofu.clone(),
                        qty_g: Some(50.0),
                        qty: None,
                        unit: None,
                        to_taste: false,
                        optional: true,
                        note: None,
                    },
                    crate::commands::diet::recipes::test_support::ingredient(tofu.clone(), 100.0),
                ],
                steps: vec![],
                changed_by: None,
            },
        )
        .await
        .unwrap()
        .id;
        stock_up(&db, &tofu, 120.0, None).await;

        let result = cook_recipe_inner(&db, cook(&recipe, 1.0))
            .await
            .expect("필수 100g은 재고 120g으로 충족된다");
        // 필수 100g 차감 후 남은 20g으로는 optional 50g을 채울 수 없으니 optional은 건너뛴다.
        assert!(
            (result.consumed_g - 100.0).abs() < 1e-9,
            "필수만 차감: {}",
            result.consumed_g
        );
        let remaining: (f64,) =
            sqlx::query_as("SELECT remaining_qty_g FROM pantry_lots WHERE food_id = ?1")
                .bind(&tofu)
                .fetch_one(&db)
                .await
                .unwrap();
        assert!((remaining.0 - 20.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn cooking_a_planned_meal_marks_it_eaten() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let recipe = seed_recipe(&db, "두부조림", 1.0, vec![(tofu.clone(), 100.0)]).await;
        stock_up(&db, &tofu, 300.0, None).await;

        let plan = crate::commands::diet::plans::create_meal_plan_inner(
            &db,
            crate::models::CreateMealPlanInput {
                start_date: "2026-07-26".into(),
                end_date: "2026-07-26".into(),
                note: None,
            },
        )
        .await
        .unwrap();
        let meal = crate::commands::diet::plans::add_planned_meal_inner(
            &db,
            crate::models::AddPlannedMealInput {
                plan_id: plan.id,
                date: "2026-07-26".into(),
                meal_type: crate::models::MealType::Dinner,
                scheduled_time: None,
                sort_rank: 0,
                note: None,
            },
        )
        .await
        .unwrap();

        let mut input = cook(&recipe, 1.0);
        input.planned_meal_id = Some(meal.id.clone());
        cook_recipe_inner(&db, input).await.unwrap();

        let status: (String,) = sqlx::query_as("SELECT status FROM planned_meals WHERE id = ?1")
            .bind(&meal.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(status.0, "eaten");
    }

    #[tokio::test]
    async fn suggestions_prefer_what_is_in_stock_and_expiring() {
        let db = fresh_db().await;
        let tofu = seed_food(&db, "두부", 80.0, 8.0).await;
        let beef = seed_food(&db, "소고기", 250.0, 26.0).await;
        let milk = seed_food(&db, "우유", 60.0, 3.0).await;
        let in_stock = seed_recipe(&db, "두부조림", 1.0, vec![(tofu.clone(), 100.0)]).await;
        let expiring = seed_recipe(&db, "우유스프", 1.0, vec![(milk.clone(), 100.0)]).await;
        let _missing = seed_recipe(&db, "스테이크", 1.0, vec![(beef, 200.0)]).await;

        stock_up(&db, &tofu, 300.0, Some("2027-01-01")).await;
        stock_up(&db, &milk, 300.0, Some("2026-07-27")).await;

        let out = recipe_suggestions_inner(&db, "2026-07-26", Some(10))
            .await
            .unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].recipe_id, expiring, "유통기한 임박 소진이 1순위");
        assert_eq!(out[1].recipe_id, in_stock);
        assert_eq!(out[2].name, "스테이크");
        assert_eq!(out[2].coverage_pct, 0.0);
        assert_eq!(out[2].missing, vec!["소고기"]);
        assert_eq!(out[0].earliest_expiry.as_deref(), Some("2026-07-27"));
    }
}
