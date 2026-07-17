//! 실제 섭취 원장(meal_logs) + 일일 영양 요약. 영양 출처는 정확히 하나
//! (계획 / 레시피 / 식품 / 수동) — models::RecordMealLogInput doc 참조.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::foods::food_per_100g;
use super::goals::active_diet_goal_inner;
use super::recipes::recipe_per_serving;
use super::{clean_optional, validate_date, validate_positive, validate_score};
use crate::db::Db;
use crate::diet;
use crate::error::AppError;
use crate::models::{DailyNutrition, DietMacros, MealLog, RecordMealLogInput};

const LOG_COLS: &str = "id, date, at, planned_meal_id, recipe_id, food_id, description, servings, \
     qty_g, kcal, protein_g, fat_g, carb_g, satisfaction, fullness, note, created_at";

/// 스냅샷 매크로 검증 — 수동 입력도 커널 계산값과 같은 안전 조건(유한·비음수)을 지킨다.
fn validate_macros(m: &DietMacros) -> Result<(), AppError> {
    for (v, code) in [
        (m.kcal, "diet.log.kcal"),
        (m.protein_g, "diet.log.protein"),
        (m.fat_g, "diet.log.fat"),
        (m.carb_g, "diet.log.carb"),
    ] {
        if !v.is_finite() || v < 0.0 {
            return Err(AppError::validation(code, "macro must be non-negative"));
        }
    }
    Ok(())
}

pub(crate) async fn record_meal_log_inner(
    db: &Db,
    input: RecordMealLogInput,
) -> Result<MealLog, AppError> {
    validate_date(&input.date, "diet.log.date")?;
    let satisfaction = validate_score(input.satisfaction, "diet.log.satisfaction")?;
    let fullness = validate_score(input.fullness, "diet.log.fullness")?;
    let at = clean_optional(input.at).unwrap_or_else(|| crate::timezone::now_local().to_rfc3339());
    let note = clean_optional(input.note);
    let mut description = clean_optional(input.description);

    let sources = [
        input.planned_meal_id.is_some(),
        input.recipe_id.is_some(),
        input.food_id.is_some(),
        input.manual.is_some(),
    ]
    .iter()
    .filter(|s| **s)
    .count();
    if sources != 1 {
        return Err(AppError::validation(
            "diet.log.source",
            "exactly one of planned_meal_id / recipe_id / food_id / manual is required",
        ));
    }

    let mut servings = None;
    let mut qty_g = None;
    let macros: DietMacros;

    if let Some(planned_meal_id) = input.planned_meal_id.as_deref() {
        let ratio = input.ratio.unwrap_or(1.0);
        if !ratio.is_finite() || ratio <= 0.0 || ratio > 1.0 {
            return Err(AppError::validation(
                "diet.log.ratio",
                "ratio must be in (0, 1]",
            ));
        }
        let meal = super::plans::fetch_planned_meal(db, planned_meal_id).await?;
        if meal.items.is_empty() {
            return Err(AppError::validation(
                "diet.log.empty_meal",
                "planned meal has no items to record",
            ));
        }
        let item_macros: Vec<DietMacros> = meal
            .items
            .iter()
            .map(|i| DietMacros {
                kcal: i.kcal,
                protein_g: i.protein_g,
                fat_g: i.fat_g,
                carb_g: i.carb_g,
            })
            .collect();
        macros = diet::scale_macros(&diet::sum_macros(item_macros.iter()), ratio);
        if description.is_none() {
            let labels: Vec<&str> = meal.items.iter().map(|i| i.label.as_str()).collect();
            description = Some(labels.join(", "));
        }
    } else if let Some(recipe_id) = input.recipe_id.as_deref() {
        let s = input.servings.ok_or_else(|| {
            AppError::validation("diet.log.servings", "servings is required for a recipe log")
        })?;
        validate_positive(s, "diet.log.servings")?;
        let (name, per_serving) = recipe_per_serving(db, recipe_id).await?;
        macros = diet::scale_macros(&per_serving, s);
        servings = Some(s);
        description = description.or(Some(name));
    } else if let Some(food_id) = input.food_id.as_deref() {
        let q = input.qty_g.ok_or_else(|| {
            AppError::validation("diet.log.qty", "qty_g is required for a food log")
        })?;
        validate_positive(q, "diet.log.qty")?;
        let (name, per_100g) = food_per_100g(db, food_id).await?;
        macros = diet::macros_for_qty(&per_100g, q);
        qty_g = Some(q);
        description = description.or(Some(name));
    } else {
        // manual — sources 검증으로 이 분기에서 Some이 보장된다.
        let manual = input
            .manual
            .ok_or_else(|| AppError::unexpected("diet.log.manual", "manual macros missing"))?;
        validate_macros(&manual)?;
        if description.is_none() {
            return Err(AppError::validation(
                "diet.log.description",
                "description is required for a manual log",
            ));
        }
        macros = manual;
    }

    // "기록 + 계획 상태 전이"는 하나의 사실이므로 단일 tx(critic MAJOR-2) — INSERT가 실패하면
    // 계획이 로그 없는 eaten으로 남지 않는다.
    let mut tx = db.begin().await?;
    if let Some(planned_meal_id) = input.planned_meal_id.as_deref() {
        // 전량이면 eaten, 일부면 partial. eaten_at = 섭취 시각.
        let status = if input.ratio.unwrap_or(1.0) < 1.0 {
            "partial"
        } else {
            "eaten"
        };
        sqlx::query("UPDATE planned_meals SET status = ?2, eaten_at = ?3 WHERE id = ?1")
            .bind(planned_meal_id)
            .bind(status)
            .bind(&at)
            .execute(&mut *tx)
            .await?;
    }
    let log = sqlx::query_as::<_, MealLog>(&format!(
        "INSERT INTO meal_logs (id, date, at, planned_meal_id, recipe_id, food_id, description, \
           servings, qty_g, kcal, protein_g, fat_g, carb_g, satisfaction, fullness, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16) \
         RETURNING {LOG_COLS}"
    ))
    .bind(super::new_id())
    .bind(input.date.trim())
    .bind(&at)
    .bind(input.planned_meal_id.as_deref())
    .bind(input.recipe_id.as_deref())
    .bind(input.food_id.as_deref())
    .bind(description.as_deref())
    .bind(servings)
    .bind(qty_g)
    .bind(macros.kcal)
    .bind(macros.protein_g)
    .bind(macros.fat_g)
    .bind(macros.carb_g)
    .bind(satisfaction)
    .bind(fullness)
    .bind(note.as_deref())
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(log)
}

pub(crate) async fn list_meal_logs_inner(
    db: &Db,
    from: &str,
    to: &str,
) -> Result<Vec<MealLog>, AppError> {
    validate_date(from, "diet.log.from")?;
    validate_date(to, "diet.log.to")?;
    Ok(sqlx::query_as::<_, MealLog>(&format!(
        "SELECT {LOG_COLS} FROM meal_logs WHERE date BETWEEN ?1 AND ?2 ORDER BY date, at"
    ))
    .bind(from.trim())
    .bind(to.trim())
    .fetch_all(db)
    .await?)
}

/// 로그 삭제(철회). 계획 식사를 참조하던 **마지막** 로그가 사라지면 그 식사 상태를
/// planned로 복원한다(critic MAJOR — 로그 없는 eaten 잔존 방지). 같은 식사에 다른 로그가
/// 남아 있으면 상태는 유지(다중 로그가 한 식사를 떠받칠 수 있음).
pub(crate) async fn delete_meal_log_inner(db: &Db, id: &str) -> Result<(), AppError> {
    let mut tx = db.begin().await?;
    let planned_meal_id: Option<Option<String>> =
        sqlx::query_scalar("SELECT planned_meal_id FROM meal_logs WHERE id = ?1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    sqlx::query("DELETE FROM meal_logs WHERE id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if let Some(Some(meal_id)) = planned_meal_id {
        let remaining: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM meal_logs WHERE planned_meal_id = ?1")
                .bind(&meal_id)
                .fetch_one(&mut *tx)
                .await?;
        if remaining == 0 {
            sqlx::query(
                "UPDATE planned_meals SET status = 'planned', eaten_at = NULL WHERE id = ?1",
            )
            .bind(&meal_id)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn daily_diet_nutrition_inner(
    db: &Db,
    date: &str,
) -> Result<DailyNutrition, AppError> {
    validate_date(date, "diet.day.date")?;
    let date = date.trim();

    let (actual_kcal, actual_protein, actual_fat, actual_carb, logs_count): (
        f64,
        f64,
        f64,
        f64,
        i64,
    ) = sqlx::query_as(
        // 0.0 리터럴 필수 — 정수 0은 빈 집계에서 INTEGER로 돌아와 f64 디코드가 깨진다.
        "SELECT COALESCE(SUM(kcal),0.0), COALESCE(SUM(protein_g),0.0), \
                    COALESCE(SUM(fat_g),0.0), COALESCE(SUM(carb_g),0.0), COUNT(*) \
               FROM meal_logs WHERE date = ?1",
    )
    .bind(date)
    .fetch_one(db)
    .await?;

    // 계획 = 그 날짜의 draft/active 계획 항목 합(archived 계획 제외).
    let (planned_kcal, planned_protein, planned_fat, planned_carb): (f64, f64, f64, f64) =
        sqlx::query_as(
            "SELECT COALESCE(SUM(i.kcal),0.0), COALESCE(SUM(i.protein_g),0.0), \
                    COALESCE(SUM(i.fat_g),0.0), COALESCE(SUM(i.carb_g),0.0) \
               FROM planned_meal_items i \
               JOIN planned_meals m ON m.id = i.planned_meal_id \
               JOIN meal_plans p ON p.id = m.plan_id \
              WHERE m.date = ?1 AND p.status != 'archived'",
        )
        .bind(date)
        .fetch_one(db)
        .await?;

    let actual = DietMacros {
        kcal: actual_kcal,
        protein_g: actual_protein,
        fat_g: actual_fat,
        carb_g: actual_carb,
    };
    let goal = active_diet_goal_inner(db, date).await?.map(|g| {
        diet::check_goal(
            &actual,
            g.calorie_target,
            g.calorie_tolerance_pct,
            g.protein_min_g,
        )
    });

    Ok(DailyNutrition {
        date: date.to_string(),
        actual,
        planned: DietMacros {
            kcal: planned_kcal,
            protein_g: planned_protein,
            fat_g: planned_fat,
            carb_g: planned_carb,
        },
        logs_count: logs_count.clamp(0, i32::MAX as i64) as i32,
        goal,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn record_meal_log(
    db: State<'_, Db>,
    input: RecordMealLogInput,
) -> Result<MealLog, AppError> {
    record_meal_log_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_meal_logs(
    db: State<'_, Db>,
    from: String,
    to: String,
) -> Result<Vec<MealLog>, AppError> {
    list_meal_logs_inner(db.inner(), &from, &to).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_meal_log(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_meal_log_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn daily_diet_nutrition(
    db: State<'_, Db>,
    date: String,
) -> Result<DailyNutrition, AppError> {
    daily_diet_nutrition_inner(db.inner(), &date).await
}

#[cfg(test)]
mod tests {
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::diet::plans::test_support::{seed_meal, seed_plan};
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::{
        AddPlannedMealItemInput, DietMacros, MealType, PlannedMealStatus, RecordMealLogInput,
        SetDietGoalInput,
    };

    fn base_log(date: &str) -> RecordMealLogInput {
        RecordMealLogInput {
            date: date.into(),
            at: Some(format!("{date}T12:30:00+09:00")),
            planned_meal_id: None,
            ratio: None,
            recipe_id: None,
            servings: None,
            food_id: None,
            qty_g: None,
            manual: None,
            description: None,
            satisfaction: None,
            fullness: None,
            note: None,
        }
    }

    #[tokio::test]
    async fn planned_meal_log_copies_snapshot_and_flips_status() {
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
                qty_g: Some(200.0),
                note: None,
            },
        )
        .await
        .unwrap();

        // 절반만 먹음(ratio 0.5) → partial + 스냅샷 ×0.5.
        let mut input = base_log("2026-07-20");
        input.planned_meal_id = Some(meal.clone());
        input.ratio = Some(0.5);
        input.satisfaction = Some(4);
        let log = super::record_meal_log_inner(&db, input).await.unwrap();
        assert!((log.kcal - 120.0).abs() < 1e-9, "240×0.5");
        assert!((log.protein_g - 22.0).abs() < 1e-9);
        assert_eq!(log.description.as_deref(), Some("닭다리살"));

        let meal_after = crate::commands::diet::plans::fetch_planned_meal(&db, &meal)
            .await
            .unwrap();
        assert_eq!(meal_after.status, PlannedMealStatus::Partial);
        assert!(meal_after.eaten_at.is_some());
    }

    #[tokio::test]
    async fn manual_log_requires_description_and_daily_summary_checks_goal() {
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

        // 설명 없는 수동 기록 거부.
        let mut bad = base_log("2026-07-20");
        bad.manual = Some(DietMacros {
            kcal: 800.0,
            protein_g: 30.0,
            fat_g: 35.0,
            carb_g: 90.0,
        });
        assert!(super::record_meal_log_inner(&db, bad).await.is_err());

        let mut dinner = base_log("2026-07-20");
        dinner.manual = Some(DietMacros {
            kcal: 800.0,
            protein_g: 30.0,
            fat_g: 35.0,
            carb_g: 90.0,
        });
        dinner.description = Some("외식 — 부리토볼".into());
        super::record_meal_log_inner(&db, dinner).await.unwrap();

        let mut lunch = base_log("2026-07-20");
        lunch.manual = Some(DietMacros {
            kcal: 1350.0,
            protein_g: 115.0,
            fat_g: 40.0,
            carb_g: 150.0,
        });
        lunch.description = Some("샤브샤브".into());
        super::record_meal_log_inner(&db, lunch).await.unwrap();

        let day = super::daily_diet_nutrition_inner(&db, "2026-07-20")
            .await
            .unwrap();
        assert_eq!(day.logs_count, 2);
        assert!((day.actual.kcal - 2150.0).abs() < 1e-9);
        let goal = day.goal.expect("goal check");
        assert!(goal.kcal_ok, "2150은 2200±7% 안");
        assert_eq!(goal.protein_ok, Some(true), "145 >= 140");
    }

    #[tokio::test]
    async fn exactly_one_source_is_enforced() {
        let db = fresh_db().await;
        let food = seed_food(&db, "고구마", 86.0, 1.6).await;

        let mut none = base_log("2026-07-20");
        none.description = Some("?".into());
        assert!(super::record_meal_log_inner(&db, none).await.is_err());

        let mut two = base_log("2026-07-20");
        two.food_id = Some(food.clone());
        two.qty_g = Some(100.0);
        two.manual = Some(DietMacros::default());
        assert!(super::record_meal_log_inner(&db, two).await.is_err());

        // food 경로 정상 + 설명 자동 채움.
        let mut ok = base_log("2026-07-20");
        ok.food_id = Some(food);
        ok.qty_g = Some(200.0);
        let log = super::record_meal_log_inner(&db, ok).await.unwrap();
        assert!((log.kcal - 172.0).abs() < 1e-9);
        assert_eq!(log.description.as_deref(), Some("고구마"));

        let listed = super::list_meal_logs_inner(&db, "2026-07-20", "2026-07-20")
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        super::delete_meal_log_inner(&db, &listed[0].id)
            .await
            .unwrap();
        assert!(super::list_meal_logs_inner(&db, "2026-07-20", "2026-07-20")
            .await
            .unwrap()
            .is_empty());
    }

    /// 철회 계약: 계획 식사를 떠받치던 **마지막** 로그가 사라지면 상태가 planned로 복원되고,
    /// 다른 로그가 남아 있으면 유지된다(로그 없는 eaten 잔존 금지 — critic MAJOR).
    #[tokio::test]
    async fn retracting_the_sole_log_reverts_planned_meal_status() {
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
                qty_g: Some(200.0),
                note: None,
            },
        )
        .await
        .unwrap();

        // 반씩 두 번 기록 → 로그 2개가 같은 식사를 참조.
        for _ in 0..2 {
            let mut input = base_log("2026-07-20");
            input.planned_meal_id = Some(meal.clone());
            input.ratio = Some(0.5);
            super::record_meal_log_inner(&db, input).await.unwrap();
        }
        let logs = super::list_meal_logs_inner(&db, "2026-07-20", "2026-07-20")
            .await
            .unwrap();
        assert_eq!(logs.len(), 2);

        // 하나 철회 — 다른 로그가 남아 있으므로 상태 유지.
        super::delete_meal_log_inner(&db, &logs[0].id)
            .await
            .unwrap();
        let after_first = crate::commands::diet::plans::fetch_planned_meal(&db, &meal)
            .await
            .unwrap();
        assert_eq!(after_first.status, PlannedMealStatus::Partial);

        // 마지막 로그 철회 — planned 복원 + eaten_at 제거.
        super::delete_meal_log_inner(&db, &logs[1].id)
            .await
            .unwrap();
        let reverted = crate::commands::diet::plans::fetch_planned_meal(&db, &meal)
            .await
            .unwrap();
        assert_eq!(reverted.status, PlannedMealStatus::Planned);
        assert!(reverted.eaten_at.is_none());
    }
}
