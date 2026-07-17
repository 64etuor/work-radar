//! 영양 목표 — append-only 버전(effective_date). 활성 목표 = 기준일 이하 중 최신.
//! 과거 계획/기록은 자기 스냅샷을 들고 있어 목표 변경이 이력을 바꾸지 않는다.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, new_id, validate_date, validate_non_negative, validate_positive};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{DietGoal, SetDietGoalInput};

const GOAL_COLS: &str = "id, effective_date, calorie_target, calorie_tolerance_pct, \
     protein_min_g, fat_min_g, carb_target_g, fiber_min_g, note, created_at";

pub(crate) async fn set_diet_goal_inner(
    db: &Db,
    input: SetDietGoalInput,
) -> Result<DietGoal, AppError> {
    validate_date(&input.effective_date, "diet.goal.effective_date")?;
    validate_positive(input.calorie_target, "diet.goal.calorie_target")?;
    let tolerance = input.calorie_tolerance_pct.unwrap_or(10.0);
    validate_non_negative(tolerance, "diet.goal.tolerance")?;
    for (value, code) in [
        (input.protein_min_g, "diet.goal.protein_min"),
        (input.fat_min_g, "diet.goal.fat_min"),
        (input.carb_target_g, "diet.goal.carb_target"),
        (input.fiber_min_g, "diet.goal.fiber_min"),
    ] {
        if let Some(v) = value {
            validate_non_negative(v, code)?;
        }
    }
    let note = clean_optional(input.note);
    Ok(sqlx::query_as::<_, DietGoal>(&format!(
        "INSERT INTO diet_goals (id, effective_date, calorie_target, calorie_tolerance_pct, \
           protein_min_g, fat_min_g, carb_target_g, fiber_min_g, note) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         RETURNING {GOAL_COLS}"
    ))
    .bind(new_id())
    .bind(input.effective_date.trim())
    .bind(input.calorie_target)
    .bind(tolerance)
    .bind(input.protein_min_g)
    .bind(input.fat_min_g)
    .bind(input.carb_target_g)
    .bind(input.fiber_min_g)
    .bind(note.as_deref())
    .fetch_one(db)
    .await?)
}

pub(crate) async fn active_diet_goal_inner(
    db: &Db,
    date: &str,
) -> Result<Option<DietGoal>, AppError> {
    validate_date(date, "diet.goal.date")?;
    Ok(sqlx::query_as::<_, DietGoal>(&format!(
        "SELECT {GOAL_COLS} FROM diet_goals WHERE effective_date <= ?1 \
          ORDER BY effective_date DESC, created_at DESC, id DESC LIMIT 1"
    ))
    .bind(date.trim())
    .fetch_optional(db)
    .await?)
}

pub(crate) async fn list_diet_goals_inner(db: &Db) -> Result<Vec<DietGoal>, AppError> {
    Ok(sqlx::query_as::<_, DietGoal>(&format!(
        "SELECT {GOAL_COLS} FROM diet_goals ORDER BY effective_date DESC, created_at DESC"
    ))
    .fetch_all(db)
    .await?)
}

#[tauri::command]
#[specta::specta]
pub async fn set_diet_goal(
    db: State<'_, Db>,
    input: SetDietGoalInput,
) -> Result<DietGoal, AppError> {
    set_diet_goal_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn active_diet_goal(
    db: State<'_, Db>,
    date: String,
) -> Result<Option<DietGoal>, AppError> {
    active_diet_goal_inner(db.inner(), &date).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_diet_goals(db: State<'_, Db>) -> Result<Vec<DietGoal>, AppError> {
    list_diet_goals_inner(db.inner()).await
}

#[cfg(test)]
mod tests {
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::SetDietGoalInput;

    fn goal(effective: &str, kcal: f64) -> SetDietGoalInput {
        SetDietGoalInput {
            effective_date: effective.into(),
            calorie_target: kcal,
            calorie_tolerance_pct: None,
            protein_min_g: Some(140.0),
            fat_min_g: None,
            carb_target_g: None,
            fiber_min_g: None,
            note: None,
        }
    }

    #[tokio::test]
    async fn goals_are_append_only_versions_and_active_picks_latest_effective() {
        let db = fresh_db().await;
        super::set_diet_goal_inner(&db, goal("2026-07-01", 2400.0))
            .await
            .unwrap();
        super::set_diet_goal_inner(&db, goal("2026-07-15", 2200.0))
            .await
            .unwrap();
        // 미래 목표는 아직 비활성.
        super::set_diet_goal_inner(&db, goal("2026-08-01", 2000.0))
            .await
            .unwrap();

        let active = super::active_diet_goal_inner(&db, "2026-07-17")
            .await
            .unwrap()
            .expect("active goal");
        assert_eq!(active.calorie_target, 2200.0);
        assert_eq!(active.calorie_tolerance_pct, 10.0, "기본 허용편차 10%");

        let before_any = super::active_diet_goal_inner(&db, "2026-06-01")
            .await
            .unwrap();
        assert!(before_any.is_none());

        assert_eq!(super::list_diet_goals_inner(&db).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn goal_input_is_validated() {
        let db = fresh_db().await;
        assert!(super::set_diet_goal_inner(&db, goal("bad-date", 2200.0))
            .await
            .is_err());
        assert!(super::set_diet_goal_inner(&db, goal("2026-07-01", 0.0))
            .await
            .is_err());
    }
}
