//! 장보기 목록 — 계획 필요량(레시피 전개) − 재고 − 미입고 주문 = 순필요량(커널 net_needed).
//! 저장하지 않고 매번 계산(제안일 뿐 원장이 아님 — PRD의 "LLM은 제안, 계산은 결정론"과 동형).

#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;

use tauri::State;

use crate::db::Db;
use crate::diet;
use crate::error::AppError;
use crate::models::ShoppingListEntry;

pub(crate) async fn diet_shopping_list_inner(
    db: &Db,
    plan_id: &str,
) -> Result<Vec<ShoppingListEntry>, AppError> {
    let plan_exists: Option<String> = sqlx::query_scalar("SELECT id FROM meal_plans WHERE id = ?1")
        .bind(plan_id)
        .fetch_optional(db)
        .await?;
    if plan_exists.is_none() {
        return Err(AppError::not_found(
            "diet.plan.missing",
            "meal plan not found",
        ));
    }

    // (food_id, name, required_g) — 아직 안 먹은(planned) 식사만. 이미 먹었거나 스킵한
    // 식사의 재료는 다시 살 필요가 없다.
    let direct: Vec<(String, String, f64)> = sqlx::query_as(
        "SELECT f.id, f.name, SUM(i.qty_g) \
           FROM planned_meal_items i \
           JOIN planned_meals m ON m.id = i.planned_meal_id \
           JOIN foods f ON f.id = i.food_id \
          WHERE m.plan_id = ?1 AND m.status = 'planned' AND i.food_id IS NOT NULL \
          GROUP BY f.id, f.name",
    )
    .bind(plan_id)
    .fetch_all(db)
    .await?;

    // 레시피 항목 전개: 재료 g × (항목 인분 / 레시피 기준 인분).
    let expanded: Vec<(String, String, f64)> = sqlx::query_as(
        "SELECT f.id, f.name, SUM(ri.qty_g * i.servings / r.servings) \
           FROM planned_meal_items i \
           JOIN planned_meals m ON m.id = i.planned_meal_id \
           JOIN recipes r ON r.id = i.recipe_id \
           JOIN recipe_ingredients ri ON ri.recipe_id = r.id \
           JOIN foods f ON f.id = ri.food_id \
          WHERE m.plan_id = ?1 AND m.status = 'planned' AND i.recipe_id IS NOT NULL \
          GROUP BY f.id, f.name",
    )
    .bind(plan_id)
    .fetch_all(db)
    .await?;

    let mut required: BTreeMap<String, (String, f64)> = BTreeMap::new();
    for (food_id, name, qty) in direct.into_iter().chain(expanded) {
        let entry = required
            .entry(food_id)
            .or_insert_with(|| (name.clone(), 0.0));
        entry.1 += qty;
    }
    if required.is_empty() {
        return Ok(Vec::new());
    }

    let available: Vec<(String, f64)> = sqlx::query_as(
        "SELECT food_id, SUM(remaining_qty_g) FROM pantry_lots \
          WHERE remaining_qty_g > 0 GROUP BY food_id",
    )
    .fetch_all(db)
    .await?;
    let available: BTreeMap<String, f64> = available.into_iter().collect();

    // 미입고 pending = 취소되지 않은 주문의 received=0 라인 중량. 주문이 delivered여도 라인이
    // 아직 입고(receive_order_line) 전이면 곧 재고가 될 물량이므로 pending으로 센다 —
    // 주문 상태와 라인 입고는 직교(critic MINOR-3).
    let pending: Vec<(String, f64)> = sqlx::query_as(
        "SELECT l.food_id, SUM(COALESCE(l.total_g, 0.0)) \
           FROM grocery_order_lines l \
           JOIN grocery_orders o ON o.id = l.order_id \
          WHERE l.food_id IS NOT NULL AND l.received = 0 AND o.status != 'cancelled' \
          GROUP BY l.food_id",
    )
    .fetch_all(db)
    .await?;
    let pending: BTreeMap<String, f64> = pending.into_iter().collect();

    let mut entries: Vec<ShoppingListEntry> = required
        .into_iter()
        .map(|(food_id, (food_name, required_g))| {
            let available_g = available.get(&food_id).copied().unwrap_or(0.0);
            let pending_g = pending.get(&food_id).copied().unwrap_or(0.0);
            ShoppingListEntry {
                net_needed_g: diet::net_needed(required_g, available_g, pending_g),
                food_id,
                food_name,
                required_g,
                available_g,
                pending_g,
            }
        })
        .collect();
    entries.sort_by(|a, b| {
        b.net_needed_g
            .partial_cmp(&a.net_needed_g)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.food_name.cmp(&b.food_name))
    });
    Ok(entries)
}

#[tauri::command]
#[specta::specta]
pub async fn diet_shopping_list(
    db: State<'_, Db>,
    plan_id: String,
) -> Result<Vec<ShoppingListEntry>, AppError> {
    diet_shopping_list_inner(db.inner(), &plan_id).await
}

#[cfg(test)]
mod tests {
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::diet::orders::test_support::seed_order;
    use crate::commands::diet::pantry::test_support::seed_lot;
    use crate::commands::diet::plans::test_support::{seed_meal, seed_plan};
    use crate::commands::diet::recipes::test_support::seed_recipe;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{AddPlannedMealItemInput, MealType};

    #[tokio::test]
    async fn shopping_list_expands_recipes_subtracts_stock_and_pending() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let pasta = seed_food(&db, "파스타면", 371.0, 13.0).await;

        // 레시피(2인분 기준: 면 160g) — 계획에는 1.5인분 → 면 120g 필요.
        let recipe = seed_recipe(&db, "알리오 올리오", 2.0, vec![(pasta.clone(), 160.0)]).await;
        let plan = seed_plan(&db, "2026-07-20", "2026-07-26").await;
        let lunch = seed_meal(&db, &plan, "2026-07-20", MealType::Lunch).await;
        let dinner = seed_meal(&db, &plan, "2026-07-21", MealType::Dinner).await;

        // 직접 food 항목: 닭 700g + 500g(이틀) = 1200g.
        for (meal, qty) in [(&lunch, 700.0), (&dinner, 500.0)] {
            crate::commands::diet::plans::add_planned_meal_item_inner(
                &db,
                AddPlannedMealItemInput {
                    planned_meal_id: meal.clone(),
                    recipe_id: None,
                    food_id: Some(chicken.clone()),
                    servings: None,
                    qty_g: Some(qty),
                    note: None,
                },
            )
            .await
            .unwrap();
        }
        crate::commands::diet::plans::add_planned_meal_item_inner(
            &db,
            AddPlannedMealItemInput {
                planned_meal_id: dinner.clone(),
                recipe_id: Some(recipe),
                food_id: None,
                servings: Some(1.5),
                qty_g: None,
                note: None,
            },
        )
        .await
        .unwrap();

        // 재고: 닭 300g. 미입고 주문: 닭 500g.
        seed_lot(&db, &chicken, 300.0, "2026-07-10", Some("2026-07-25")).await;
        seed_order(
            &db,
            vec![("닭다리살 500g".into(), Some(chicken.clone()), Some(500.0))],
        )
        .await;

        let list = super::diet_shopping_list_inner(&db, &plan).await.unwrap();
        assert_eq!(list.len(), 2);
        let chicken_entry = list.iter().find(|e| e.food_id == chicken).unwrap();
        assert_eq!(chicken_entry.required_g, 1200.0);
        assert_eq!(chicken_entry.available_g, 300.0);
        assert_eq!(chicken_entry.pending_g, 500.0);
        assert_eq!(chicken_entry.net_needed_g, 400.0);
        let pasta_entry = list.iter().find(|e| e.food_id == pasta).unwrap();
        assert!((pasta_entry.required_g - 120.0).abs() < 1e-9, "160×1.5/2");
        assert_eq!(pasta_entry.net_needed_g, 120.0);

        // 주문이 delivered여도 라인이 미입고면 여전히 pending(주문 상태 ⊥ 라인 입고 — MINOR-3).
        sqlx::query("UPDATE grocery_orders SET status = 'delivered'")
            .execute(&db)
            .await
            .unwrap();
        let list = super::diet_shopping_list_inner(&db, &plan).await.unwrap();
        let chicken_entry = list.iter().find(|e| e.food_id == chicken).unwrap();
        assert_eq!(chicken_entry.pending_g, 500.0);
        // 취소된 주문의 라인은 pending에서 제외.
        sqlx::query("UPDATE grocery_orders SET status = 'cancelled'")
            .execute(&db)
            .await
            .unwrap();
        let list = super::diet_shopping_list_inner(&db, &plan).await.unwrap();
        let chicken_entry = list.iter().find(|e| e.food_id == chicken).unwrap();
        assert_eq!(chicken_entry.pending_g, 0.0);
        assert_eq!(chicken_entry.net_needed_g, 900.0);
    }

    #[tokio::test]
    async fn eaten_meals_do_not_demand_groceries() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let plan = seed_plan(&db, "2026-07-20", "2026-07-26").await;
        let meal = seed_meal(&db, &plan, "2026-07-20", MealType::Lunch).await;
        crate::commands::diet::plans::add_planned_meal_item_inner(
            &db,
            AddPlannedMealItemInput {
                planned_meal_id: meal.clone(),
                recipe_id: None,
                food_id: Some(chicken),
                servings: None,
                qty_g: Some(500.0),
                note: None,
            },
        )
        .await
        .unwrap();
        crate::commands::diet::plans::set_planned_meal_status_inner(
            &db,
            &meal,
            crate::models::PlannedMealStatus::Eaten,
        )
        .await
        .unwrap();

        let list = super::diet_shopping_list_inner(&db, &plan).await.unwrap();
        assert!(list.is_empty(), "이미 먹은 식사는 필요량에서 제외");
    }
}
