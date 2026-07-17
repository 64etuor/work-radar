//! Diet 조회/요약 툴 + 사실기록 write(`wr_diet_record_meal`).
//!
//! 계획/기록 편집·라이브러리·재고/주문 관리 툴은 `tools/diet_manage.rs`에 있다 —
//! 2026-07-17 사용자 결정으로 diet 도메인 전권이 에이전트에 위임됐다(레일 논증은 그쪽
//! 모듈 doc이 정본). 이 모듈은 일상 조회 표면(오늘 영양·식사·재고 요약·장보기·식품 검색)을
//! 소유한다.
//!
//! `wr_diet_record_meal`이 planned meal 상태를 eaten/partial로 움직이는 것과 영양 수치가
//! 커널 계산 스냅샷(임의 kcal 주입은 자유기록 경로에서만, description 필수)이라는 계약은 유지.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::diet as diet_commands;
use crate::mcp::{enum_wire_string, mcp_tool_error, parse_iso_date, truncate_preview, WrServer};
use crate::models::{DietMacros, RecordMealLogInput};

/// 설명/노트 미리보기 상한(§6 — 장문 echo 금지).
const TEXT_PREVIEW_CHARS: usize = 200;
/// 자유 텍스트 입력 상한(§2).
const DESCRIPTION_MAX_CHARS: usize = 200;
const NOTE_MAX_CHARS: usize = 500;
/// 검색 결과 상한 — read 툴은 최소권한(§7), 목록 폭주 금지.
const SEARCH_LIMIT: usize = 25;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietDateParams {
    /// 로컬 날짜 YYYY-MM-DD.
    pub date: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietExpiringParams {
    /// 오늘부터 며칠 안에 만료되는 로트를 볼지(0 = 오늘까지, 이미 지난 것 포함). 최대 60.
    pub within_days: u32,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietShoppingParams {
    /// 대상 식단 계획 id. 생략하면 가장 최근 active 계획.
    pub plan_id: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietFoodSearchParams {
    /// 식품 이름/별칭 부분 일치 검색어.
    pub query: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRecordMealParams {
    /// 로컬 날짜 YYYY-MM-DD. 생략하면 오늘.
    pub date: Option<String>,
    /// 계획된 식사를 먹었다고 기록(스냅샷 복사 + 상태 eaten/partial). 아래 식별자 중 하나만.
    pub planned_meal_id: Option<String>,
    /// planned 경로 전용 — 섭취 비율(0 초과 1 이하, 기본 1).
    pub ratio: Option<f64>,
    /// 등록된 식품을 중량으로 기록. `wr_diet_search_foods`로 id를 찾는다.
    pub food_id: Option<String>,
    /// food 경로 전용 — 섭취 중량 g.
    pub qty_g: Option<f64>,
    /// 자유 기록(외식 등) 열량 kcal — 이때 `description`이 필수.
    pub kcal: Option<f64>,
    /// 자유 기록 단백질 g(생략 시 0).
    pub protein_g: Option<f64>,
    /// 자유 기록 지방 g(생략 시 0).
    pub fat_g: Option<f64>,
    /// 자유 기록 탄수화물 g(생략 시 0).
    pub carb_g: Option<f64>,
    /// 무엇을 먹었는지(≤200자). 자유 기록에서 필수.
    pub description: Option<String>,
    /// 맛 만족도 1..5 (선택).
    pub satisfaction: Option<i32>,
    /// 포만감 1..5 (선택).
    pub fullness: Option<i32>,
    /// 짧은 메모(≤500자, 선택).
    pub note: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietMacrosDto {
    pub kcal: f64,
    pub protein_g: f64,
    pub fat_g: f64,
    pub carb_g: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietGoalCheckDto {
    pub calorie_target: f64,
    /// actual − target (음수 = 부족).
    pub kcal_delta: f64,
    pub kcal_ok: bool,
    pub protein_ok: Option<bool>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietDailyNutritionDto {
    pub date: String,
    pub actual: DietMacrosDto,
    pub planned: DietMacrosDto,
    pub logs_count: i32,
    pub goal: Option<DietGoalCheckDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietMealItemDto {
    pub label: String,
    pub kcal: f64,
    pub protein_g: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietMealDto {
    pub id: String,
    pub date: String,
    /// "breakfast" | "lunch" | "dinner" | "snack" | "pre_workout" | "post_workout" | "free".
    pub meal_type: String,
    pub scheduled_time: Option<String>,
    /// "planned" | "eaten" | "partial" | "skipped".
    pub status: String,
    pub items: Vec<DietMealItemDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietMealListDto {
    pub meals: Vec<DietMealDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPantryFoodDto {
    pub food_id: String,
    pub food_name: String,
    pub total_remaining_g: f64,
    pub nearest_expiry: Option<String>,
    pub lots: i32,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPantrySummaryDto {
    pub foods: Vec<DietPantryFoodDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietExpiringLotDto {
    pub food_name: String,
    pub expires_on: String,
    pub remaining_qty_g: f64,
    /// "fridge" | "freezer" | "pantry" | "other".
    pub location: String,
}

#[derive(Serialize, JsonSchema)]
pub struct DietExpiringListDto {
    pub lots: Vec<DietExpiringLotDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietShoppingEntryDto {
    pub food_id: String,
    pub food_name: String,
    pub required_g: f64,
    pub available_g: f64,
    pub pending_g: f64,
    pub net_needed_g: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietShoppingListDto {
    pub plan_id: String,
    pub entries: Vec<DietShoppingEntryDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietFoodDto {
    pub id: String,
    pub name: String,
    pub kcal_per_100g: f64,
    pub protein_g_per_100g: f64,
    pub default_serving_g: Option<f64>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietFoodListDto {
    pub foods: Vec<DietFoodDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecordMealResultDto {
    pub id: String,
    pub date: String,
    pub kcal: f64,
    pub protein_g: f64,
    pub description_preview: Option<String>,
}

fn macros_dto(m: &DietMacros) -> DietMacrosDto {
    DietMacrosDto {
        kcal: m.kcal,
        protein_g: m.protein_g,
        fat_g: m.fat_g,
        carb_g: m.carb_g,
    }
}

#[allow(clippy::result_large_err)]
fn enforce_max_chars(value: Option<&str>, max: usize, label: &str) -> Result<(), rmcp::ErrorData> {
    if let Some(v) = value {
        if v.chars().count() > max {
            return Err(rmcp::ErrorData::invalid_params(
                format!("{label} exceeds {max} characters"),
                None,
            ));
        }
    }
    Ok(())
}

#[tool_router(router = tool_router_diet, vis = "pub(crate)")]
impl WrServer {
    #[tool(
        name = "wr_diet_daily_nutrition",
        description = "Daily nutrition summary for a date: actual intake from meal logs, planned totals, and the goal check (calorie band / protein floor). Read-only."
    )]
    pub async fn diet_daily_nutrition(
        &self,
        Parameters(p): Parameters<DietDateParams>,
    ) -> Result<Json<DietDailyNutritionDto>, rmcp::ErrorData> {
        self.diet_daily_nutrition_inner(p).await
    }

    pub(crate) async fn diet_daily_nutrition_inner(
        &self,
        p: DietDateParams,
    ) -> Result<Json<DietDailyNutritionDto>, rmcp::ErrorData> {
        parse_iso_date(&p.date)?;
        let day = diet_commands::daily_diet_nutrition_inner(&self.db, &p.date)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_daily_nutrition", &e))?;
        Ok(Json(DietDailyNutritionDto {
            date: day.date,
            actual: macros_dto(&day.actual),
            planned: macros_dto(&day.planned),
            logs_count: day.logs_count,
            goal: day.goal.map(|g| DietGoalCheckDto {
                calorie_target: g.calorie_target,
                kcal_delta: g.kcal_delta,
                kcal_ok: g.kcal_ok,
                protein_ok: g.protein_ok,
            }),
        }))
    }

    #[tool(
        name = "wr_diet_meals_for_date",
        description = "Planned meals for a date (across non-archived meal plans) with per-item calorie/protein snapshots and eaten status. Read-only."
    )]
    pub async fn diet_meals_for_date(
        &self,
        Parameters(p): Parameters<DietDateParams>,
    ) -> Result<Json<DietMealListDto>, rmcp::ErrorData> {
        self.diet_meals_for_date_inner(p).await
    }

    pub(crate) async fn diet_meals_for_date_inner(
        &self,
        p: DietDateParams,
    ) -> Result<Json<DietMealListDto>, rmcp::ErrorData> {
        parse_iso_date(&p.date)?;
        let meals = diet_commands::plans::list_planned_meals_for_date(&self.db, &p.date)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_meals_for_date", &e))?;
        Ok(Json(DietMealListDto {
            meals: meals
                .into_iter()
                .map(|m| DietMealDto {
                    id: m.id,
                    date: m.date,
                    meal_type: enum_wire_string(&m.meal_type),
                    scheduled_time: m.scheduled_time,
                    status: enum_wire_string(&m.status),
                    items: m
                        .items
                        .into_iter()
                        .map(|i| DietMealItemDto {
                            label: truncate_preview(&i.label, TEXT_PREVIEW_CHARS),
                            kcal: i.kcal,
                            protein_g: i.protein_g,
                        })
                        .collect(),
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_pantry_summary",
        description = "Current pantry stock grouped by food: total remaining grams, nearest expiry date, and lot count. Read-only."
    )]
    pub async fn diet_pantry_summary(&self) -> Result<Json<DietPantrySummaryDto>, rmcp::ErrorData> {
        let foods = diet_commands::list_pantry_inner(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_pantry_summary", &e))?;
        Ok(Json(DietPantrySummaryDto {
            foods: foods
                .into_iter()
                .map(|f| DietPantryFoodDto {
                    food_id: f.food_id,
                    food_name: f.food_name,
                    total_remaining_g: f.total_remaining_g,
                    nearest_expiry: f.nearest_expiry,
                    lots: f.lots.len().min(i32::MAX as usize) as i32,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_expiring_pantry",
        description = "Pantry lots expiring within N days from today (already-expired lots included). Read-only."
    )]
    pub async fn diet_expiring_pantry(
        &self,
        Parameters(p): Parameters<DietExpiringParams>,
    ) -> Result<Json<DietExpiringListDto>, rmcp::ErrorData> {
        self.diet_expiring_pantry_inner(p).await
    }

    pub(crate) async fn diet_expiring_pantry_inner(
        &self,
        p: DietExpiringParams,
    ) -> Result<Json<DietExpiringListDto>, rmcp::ErrorData> {
        if p.within_days > 60 {
            return Err(rmcp::ErrorData::invalid_params(
                "within_days must be <= 60",
                None,
            ));
        }
        let today = crate::timezone::local_today_string();
        let lots = diet_commands::expiring_pantry_inner(&self.db, &today, p.within_days as i32)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_expiring_pantry", &e))?;
        Ok(Json(DietExpiringListDto {
            lots: lots
                .into_iter()
                .filter_map(|l| {
                    l.expires_on.map(|expires_on| DietExpiringLotDto {
                        food_name: l.food_name,
                        expires_on,
                        remaining_qty_g: l.remaining_qty_g,
                        location: enum_wire_string(&l.location),
                    })
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_shopping_list",
        description = "Computed grocery needs for a meal plan: required grams (recipes expanded) minus pantry stock minus pending (undelivered) order lines. Defaults to the most recent active plan. Read-only — this proposes nothing and orders nothing."
    )]
    pub async fn diet_shopping_list(
        &self,
        Parameters(p): Parameters<DietShoppingParams>,
    ) -> Result<Json<DietShoppingListDto>, rmcp::ErrorData> {
        self.diet_shopping_list_inner(p).await
    }

    pub(crate) async fn diet_shopping_list_inner(
        &self,
        p: DietShoppingParams,
    ) -> Result<Json<DietShoppingListDto>, rmcp::ErrorData> {
        let plan_id = match p.plan_id {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => sqlx::query_scalar::<_, String>(
                "SELECT id FROM meal_plans WHERE status = 'active' \
                  ORDER BY start_date DESC, created_at DESC LIMIT 1",
            )
            .fetch_optional(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_shopping_list", &crate::error::AppError::from(e)))?
            .ok_or_else(|| {
                rmcp::ErrorData::invalid_params("no active meal plan — pass plan_id", None)
            })?,
        };
        let entries = diet_commands::diet_shopping_list_inner(&self.db, &plan_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_shopping_list", &e))?;
        Ok(Json(DietShoppingListDto {
            plan_id,
            entries: entries
                .into_iter()
                .map(|e| DietShoppingEntryDto {
                    food_id: e.food_id,
                    food_name: e.food_name,
                    required_g: e.required_g,
                    available_g: e.available_g,
                    pending_g: e.pending_g,
                    net_needed_g: e.net_needed_g,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_search_foods",
        description = "Search registered foods by name or alias; returns id plus per-100g calories/protein for meal logging. Read-only."
    )]
    pub async fn diet_search_foods(
        &self,
        Parameters(p): Parameters<DietFoodSearchParams>,
    ) -> Result<Json<DietFoodListDto>, rmcp::ErrorData> {
        self.diet_search_foods_inner(p).await
    }

    pub(crate) async fn diet_search_foods_inner(
        &self,
        p: DietFoodSearchParams,
    ) -> Result<Json<DietFoodListDto>, rmcp::ErrorData> {
        let query = p.query.trim();
        if query.is_empty() {
            return Err(rmcp::ErrorData::invalid_params("query is required", None));
        }
        enforce_max_chars(Some(query), 80, "query")?;
        let foods = diet_commands::list_foods_inner(&self.db, Some(query.to_string()), false)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_search_foods", &e))?;
        Ok(Json(DietFoodListDto {
            foods: foods
                .into_iter()
                .take(SEARCH_LIMIT)
                .map(|f| DietFoodDto {
                    id: f.id,
                    name: f.name,
                    kcal_per_100g: f.kcal_per_100g,
                    protein_g_per_100g: f.protein_g_per_100g,
                    default_serving_g: f.default_serving_g,
                })
                .collect(),
        }))
    }

    /// 사실 기록 레인(§1.1): "먹었다"만 적는다. 목표/계획/재고 판단값은 이 표면에서 못 바꾼다.
    #[tool(
        name = "wr_diet_record_meal",
        description = "Record that a meal was eaten: either a planned meal (by id, optional ratio), a registered food (by id + grams), or a free-form entry (calories + description, e.g. eating out). Nutrition for planned/food entries is computed deterministically from stored snapshots. Optional satisfaction/fullness 1-5 feedback."
    )]
    pub async fn diet_record_meal(
        &self,
        Parameters(p): Parameters<DietRecordMealParams>,
    ) -> Result<Json<DietRecordMealResultDto>, rmcp::ErrorData> {
        self.diet_record_meal_inner(p).await
    }

    pub(crate) async fn diet_record_meal_inner(
        &self,
        p: DietRecordMealParams,
    ) -> Result<Json<DietRecordMealResultDto>, rmcp::ErrorData> {
        enforce_max_chars(
            p.description.as_deref(),
            DESCRIPTION_MAX_CHARS,
            "description",
        )?;
        enforce_max_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let date = match p.date {
            Some(d) => {
                parse_iso_date(&d)?;
                d.trim().to_string()
            }
            None => crate::timezone::local_today_string(),
        };
        // 자유 기록: kcal이 오면 manual 매크로로 조립(나머지는 0 기본).
        let manual = p.kcal.map(|kcal| DietMacros {
            kcal,
            protein_g: p.protein_g.unwrap_or(0.0),
            fat_g: p.fat_g.unwrap_or(0.0),
            carb_g: p.carb_g.unwrap_or(0.0),
        });
        if manual.is_none() && (p.protein_g.is_some() || p.fat_g.is_some() || p.carb_g.is_some()) {
            return Err(rmcp::ErrorData::invalid_params(
                "macro fields require kcal (free-form entry)",
                None,
            ));
        }
        let log = diet_commands::record_meal_log_inner(
            &self.db,
            RecordMealLogInput {
                date,
                at: None,
                planned_meal_id: p.planned_meal_id,
                ratio: p.ratio,
                recipe_id: None,
                servings: None,
                food_id: p.food_id,
                qty_g: p.qty_g,
                manual,
                description: p.description,
                satisfaction: p.satisfaction,
                fullness: p.fullness,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_record_meal", &e))?;
        Ok(Json(DietRecordMealResultDto {
            id: log.id,
            date: log.date,
            kcal: log.kcal,
            protein_g: log.protein_g,
            description_preview: log
                .description
                .as_deref()
                .map(|d| truncate_preview(d, TEXT_PREVIEW_CHARS)),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{DietDateParams, DietFoodSearchParams, DietRecordMealParams, DietShoppingParams};
    use crate::commands::diet::foods::test_support::seed_food;
    use crate::commands::diet::pantry::test_support::seed_lot;
    use crate::commands::diet::plans::test_support::{seed_meal, seed_plan};
    use crate::commands::shared::test_support::fresh_db;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;
    use crate::models::{AddPlannedMealItemInput, MealPlanStatus, MealType};

    fn record_params(date: &str) -> DietRecordMealParams {
        DietRecordMealParams {
            date: Some(date.into()),
            planned_meal_id: None,
            ratio: None,
            food_id: None,
            qty_g: None,
            kcal: None,
            protein_g: None,
            fat_g: None,
            carb_g: None,
            description: None,
            satisfaction: None,
            fullness: None,
            note: None,
        }
    }

    #[tokio::test]
    async fn record_meal_by_food_flows_into_daily_nutrition() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let server = WrServer { db };

        let mut p = record_params("2026-07-17");
        p.food_id = Some(chicken);
        p.qty_g = Some(150.0);
        p.satisfaction = Some(4);
        let out = server.diet_record_meal_inner(p).await.expect("record").0;
        assert!((out.kcal - 180.0).abs() < 1e-9);
        assert_eq!(out.description_preview.as_deref(), Some("닭다리살"));

        let day = server
            .diet_daily_nutrition_inner(DietDateParams {
                date: "2026-07-17".into(),
            })
            .await
            .expect("daily")
            .0;
        assert_eq!(day.logs_count, 1);
        assert!((day.actual.kcal - 180.0).abs() < 1e-9);
        assert!(day.goal.is_none(), "목표 미설정이면 null");
    }

    #[tokio::test]
    async fn record_meal_planned_path_marks_meal_and_free_form_needs_description() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        let plan = seed_plan(&db, "2026-07-17", "2026-07-23").await;
        let meal = seed_meal(&db, &plan, "2026-07-17", MealType::Lunch).await;
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
        let server = WrServer { db };

        let mut p = record_params("2026-07-17");
        p.planned_meal_id = Some(meal);
        server.diet_record_meal_inner(p).await.expect("planned");

        let meals = server
            .diet_meals_for_date_inner(DietDateParams {
                date: "2026-07-17".into(),
            })
            .await
            .expect("meals")
            .0;
        assert_eq!(meals.meals.len(), 1);
        assert_eq!(meals.meals[0].status, "eaten");
        assert_eq!(meals.meals[0].items.len(), 1);

        // 자유 기록은 description 필수 — kcal만 주면 거부.
        let mut free = record_params("2026-07-17");
        free.kcal = Some(800.0);
        assert!(server.diet_record_meal_inner(free).await.is_err());

        // kcal 없이 macro만 주는 것도 거부(조립 불가).
        let mut orphan = record_params("2026-07-17");
        orphan.protein_g = Some(30.0);
        assert!(server.diet_record_meal_inner(orphan).await.is_err());
    }

    #[tokio::test]
    async fn shopping_list_defaults_to_active_plan_and_search_finds_alias() {
        let db = fresh_db().await;
        let chicken = seed_food(&db, "닭다리살", 120.0, 22.0).await;
        crate::commands::diet::foods::add_food_alias_inner(&db, &chicken, "닭 정육")
            .await
            .unwrap();
        seed_lot(&db, &chicken, 300.0, "2026-07-10", Some("2026-07-25")).await;
        let plan = seed_plan(&db, "2026-07-17", "2026-07-23").await;
        let meal = seed_meal(&db, &plan, "2026-07-18", MealType::Dinner).await;
        crate::commands::diet::plans::add_planned_meal_item_inner(
            &db,
            AddPlannedMealItemInput {
                planned_meal_id: meal,
                recipe_id: None,
                food_id: Some(chicken.clone()),
                servings: None,
                qty_g: Some(1000.0),
                note: None,
            },
        )
        .await
        .unwrap();
        let server = WrServer { db: db.clone() };

        // active 계획이 없으면 명시적 에러(조용한 빈 목록 금지).
        let none = server
            .diet_shopping_list_inner(DietShoppingParams { plan_id: None })
            .await;
        assert!(none.is_err());

        crate::commands::diet::plans::set_meal_plan_status_inner(
            &db,
            &plan,
            MealPlanStatus::Active,
        )
        .await
        .unwrap();
        let list = server
            .diet_shopping_list_inner(DietShoppingParams { plan_id: None })
            .await
            .expect("shopping")
            .0;
        assert_eq!(list.plan_id, plan);
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].net_needed_g, 700.0, "1000 − 재고300");

        let found = server
            .diet_search_foods_inner(DietFoodSearchParams {
                query: "정육".into(),
            })
            .await
            .expect("search")
            .0;
        assert_eq!(found.foods.len(), 1);
        assert_eq!(found.foods[0].id, chicken);
    }

    #[test]
    fn diet_params_schemas_are_closed_and_stable() {
        let record = serde_json::to_value(schemars::schema_for!(DietRecordMealParams)).unwrap();
        assert_eq!(record["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            prop_names(&record),
            expect(&[
                "date",
                "planned_meal_id",
                "ratio",
                "food_id",
                "qty_g",
                "kcal",
                "protein_g",
                "fat_g",
                "carb_g",
                "description",
                "satisfaction",
                "fullness",
                "note",
            ])
        );
        assert!(
            required_fields(&record).is_empty(),
            "전 필드 optional(경로 검증은 핸들러)"
        );
        // 결정 레일/위험 필드가 스키마에 존재하지 않는다.
        for forbidden in ["recipe_id", "raw_sql", "url", "plan_status", "goal"] {
            assert!(
                !prop_names(&record).contains(forbidden),
                "record_meal must not accept `{forbidden}`"
            );
        }

        let shopping = serde_json::to_value(schemars::schema_for!(DietShoppingParams)).unwrap();
        assert_eq!(shopping["additionalProperties"], serde_json::json!(false));
        assert_eq!(prop_names(&shopping), expect(&["plan_id"]));
    }
}
