//! Diet 도메인 타입 (docs/plans/2026-07-17-diet-domain.md).
//!
//! 원칙: 계획/기록에 들어간 영양값은 **그 시점 스냅샷**(커널 계산) — food/recipe를 나중에
//! 고쳐도 과거 planned_meal_items / meal_logs 수치는 변하지 않는다. 재고 변화는 append-only
//! `pantry_events`로만 남고, 금액은 KRW 정수(i32 — specta i64 금지).

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum FoodType {
    Ingredient,
    Product,
    Dish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum MealType {
    Breakfast,
    Lunch,
    Dinner,
    Snack,
    PreWorkout,
    PostWorkout,
    Free,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum MealPlanStatus {
    Draft,
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum PlannedMealStatus {
    Planned,
    Eaten,
    Partial,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum PantryLocation {
    Fridge,
    Freezer,
    Pantry,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum PantryEventKind {
    Purchased,
    Consumed,
    Adjusted,
    Wasted,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum GroceryOrderStatus {
    Ordered,
    Delivered,
    Cancelled,
}

/// 매크로 영양 묶음. 문맥에 따라 "100g당" 또는 "절대량"을 담는다(커널 함수 시그니처가 구분).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DietMacros {
    pub kcal: f64,
    pub protein_g: f64,
    pub fat_g: f64,
    pub carb_g: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Food {
    pub id: String,
    pub name: String,
    pub food_type: FoodType,
    pub preparation: Option<String>,
    pub default_serving_g: Option<f64>,
    pub kcal_per_100g: f64,
    pub protein_g_per_100g: f64,
    pub fat_g_per_100g: f64,
    pub carb_g_per_100g: f64,
    pub fiber_g_per_100g: Option<f64>,
    pub sodium_mg_per_100g: Option<f64>,
    pub source: String,
    pub source_ref: Option<String>,
    pub archived: bool,
    pub aliases: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertFoodInput {
    /// None = 새 식품 생성, Some = 해당 식품 갱신.
    pub id: Option<String>,
    pub name: String,
    pub food_type: FoodType,
    pub preparation: Option<String>,
    pub default_serving_g: Option<f64>,
    pub kcal_per_100g: f64,
    pub protein_g_per_100g: f64,
    pub fat_g_per_100g: f64,
    pub carb_g_per_100g: f64,
    pub fiber_g_per_100g: Option<f64>,
    pub sodium_mg_per_100g: Option<f64>,
    pub source: Option<String>,
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct DietGoal {
    pub id: String,
    pub effective_date: String,
    pub calorie_target: f64,
    pub calorie_tolerance_pct: f64,
    pub protein_min_g: Option<f64>,
    pub fat_min_g: Option<f64>,
    pub carb_target_g: Option<f64>,
    pub fiber_min_g: Option<f64>,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetDietGoalInput {
    pub effective_date: String,
    pub calorie_target: f64,
    pub calorie_tolerance_pct: Option<f64>,
    pub protein_min_g: Option<f64>,
    pub fat_min_g: Option<f64>,
    pub carb_target_g: Option<f64>,
    pub fiber_min_g: Option<f64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeIngredient {
    pub id: String,
    pub recipe_id: String,
    pub food_id: String,
    pub food_name: String,
    pub qty_g: f64,
    pub optional: bool,
    pub note: Option<String>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeIngredientInput {
    pub food_id: String,
    pub qty_g: f64,
    pub optional: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Recipe {
    pub id: String,
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub instructions: Option<String>,
    pub archived: bool,
    pub ingredients: Vec<RecipeIngredient>,
    /// 전체(모든 재료 합) — 쿼리타임 커널 계산(저장 안 함).
    pub total: DietMacros,
    /// 1인분(total / servings).
    pub per_serving: DietMacros,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRecipeInput {
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub instructions: Option<String>,
    pub ingredients: Vec<RecipeIngredientInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRecipeInput {
    pub id: String,
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub instructions: Option<String>,
    /// 전체 교체(replace-all) — 부분 patch 아님.
    pub ingredients: Vec<RecipeIngredientInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MealPlan {
    pub id: String,
    pub start_date: String,
    pub end_date: String,
    pub status: MealPlanStatus,
    /// 생성 시점 활성 목표 스냅샷(이후 목표 변경 무영향).
    pub calorie_target: Option<f64>,
    pub protein_min_g: Option<f64>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedMealItem {
    pub id: String,
    pub planned_meal_id: String,
    pub recipe_id: Option<String>,
    pub food_id: Option<String>,
    /// 조회 시점의 recipe/food 이름(표시용).
    pub label: String,
    pub servings: Option<f64>,
    pub qty_g: Option<f64>,
    pub kcal: f64,
    pub protein_g: f64,
    pub fat_g: f64,
    pub carb_g: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlannedMeal {
    pub id: String,
    pub plan_id: String,
    pub date: String,
    pub meal_type: MealType,
    pub scheduled_time: Option<String>,
    pub status: PlannedMealStatus,
    pub eaten_at: Option<String>,
    pub note: Option<String>,
    pub sort_rank: i32,
    pub items: Vec<PlannedMealItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MealPlanDetail {
    pub plan: MealPlan,
    pub meals: Vec<PlannedMeal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMealPlanInput {
    pub start_date: String,
    pub end_date: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddPlannedMealInput {
    pub plan_id: String,
    pub date: String,
    pub meal_type: MealType,
    pub scheduled_time: Option<String>,
    pub note: Option<String>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddPlannedMealItemInput {
    pub planned_meal_id: String,
    /// recipe_id XOR food_id. recipe면 servings, food면 qty_g가 필수.
    pub recipe_id: Option<String>,
    pub food_id: Option<String>,
    pub servings: Option<f64>,
    pub qty_g: Option<f64>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MealLog {
    pub id: String,
    pub date: String,
    pub at: String,
    pub planned_meal_id: Option<String>,
    pub recipe_id: Option<String>,
    pub food_id: Option<String>,
    pub description: Option<String>,
    pub servings: Option<f64>,
    pub qty_g: Option<f64>,
    pub kcal: f64,
    pub protein_g: f64,
    pub fat_g: f64,
    pub carb_g: f64,
    pub satisfaction: Option<i32>,
    pub fullness: Option<i32>,
    pub note: Option<String>,
    pub created_at: String,
}

/// 섭취 기록 입력. 영양 출처는 다음 중 정확히 하나:
/// 1) `planned_meal_id` — 계획 항목 스냅샷 합 × `ratio`(기본 1.0), 계획 상태도 eaten/partial로 전이.
/// 2) `recipe_id` + `servings` — 레시피 현재 재료로 커널 계산.
/// 3) `food_id` + `qty_g` — 식품 100g당 값으로 커널 계산.
/// 4) `manual` — 자유 기록(외식 등): 매크로 직접 입력 + `description` 필수.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordMealLogInput {
    pub date: String,
    /// RFC3339 또는 'YYYY-MM-DDTHH:MM'. None이면 서버가 now로 채운다.
    pub at: Option<String>,
    pub planned_meal_id: Option<String>,
    /// planned 경로에서만 의미(0<ratio<=1). 1 미만이면 계획 상태 partial.
    pub ratio: Option<f64>,
    pub recipe_id: Option<String>,
    pub servings: Option<f64>,
    pub food_id: Option<String>,
    pub qty_g: Option<f64>,
    pub manual: Option<DietMacros>,
    pub description: Option<String>,
    pub satisfaction: Option<i32>,
    pub fullness: Option<i32>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DietGoalCheck {
    pub calorie_target: f64,
    pub calorie_tolerance_pct: f64,
    pub protein_min_g: Option<f64>,
    /// actual − target (음수 = 부족).
    pub kcal_delta: f64,
    pub kcal_ok: bool,
    /// protein_min_g 미설정이면 None.
    pub protein_ok: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DailyNutrition {
    pub date: String,
    /// meal_logs 합산(실제 섭취).
    pub actual: DietMacros,
    /// 그 날짜의 active/draft 계획 항목 합(있으면).
    pub planned: DietMacros,
    pub logs_count: i32,
    /// 그 날짜 기준 활성 목표 대비 검증(목표 없으면 None).
    pub goal: Option<DietGoalCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PantryLot {
    pub id: String,
    pub food_id: String,
    pub food_name: String,
    pub location: PantryLocation,
    pub acquired_on: String,
    pub expires_on: Option<String>,
    pub opened_on: Option<String>,
    pub initial_qty_g: f64,
    pub remaining_qty_g: f64,
    pub order_line_id: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddPantryLotInput {
    pub food_id: String,
    pub location: PantryLocation,
    pub acquired_on: String,
    pub expires_on: Option<String>,
    pub initial_qty_g: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PantryFoodSummary {
    pub food_id: String,
    pub food_name: String,
    pub total_remaining_g: f64,
    pub nearest_expiry: Option<String>,
    pub lots: Vec<PantryLot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PantryTake {
    pub lot_id: String,
    pub qty_g: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsumePantryResult {
    pub taken: Vec<PantryTake>,
    /// 재고 부족으로 차감 못 한 양(0이면 완전 충족).
    pub shortfall_g: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GroceryOrderLine {
    pub id: String,
    pub order_id: String,
    pub product_name: String,
    pub food_id: Option<String>,
    pub quantity: f64,
    pub total_g: Option<f64>,
    pub unit_price_krw: Option<i32>,
    pub line_total_krw: Option<i32>,
    pub received: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GroceryOrder {
    pub id: String,
    pub merchant: String,
    pub ordered_at: String,
    pub external_order_no: Option<String>,
    pub total_krw: Option<i32>,
    pub shipping_krw: Option<i32>,
    pub status: GroceryOrderStatus,
    pub note: Option<String>,
    pub lines: Vec<GroceryOrderLine>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroceryOrderLineInput {
    pub product_name: String,
    pub food_id: Option<String>,
    pub quantity: f64,
    pub total_g: Option<f64>,
    pub unit_price_krw: Option<i32>,
    pub line_total_krw: Option<i32>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordGroceryOrderInput {
    pub merchant: String,
    pub ordered_at: String,
    pub external_order_no: Option<String>,
    pub total_krw: Option<i32>,
    pub shipping_krw: Option<i32>,
    pub note: Option<String>,
    pub lines: Vec<GroceryOrderLineInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiveOrderLineInput {
    pub line_id: String,
    pub location: PantryLocation,
    /// 입고일(로컬 날짜, 호출자 주입).
    pub acquired_on: String,
    pub expires_on: Option<String>,
    /// 라인의 total_g가 없거나 실측과 다를 때 로트 수량 override.
    pub total_g_override: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingListEntry {
    pub food_id: String,
    pub food_name: String,
    /// 계획 필요량(레시피 전개 포함).
    pub required_g: f64,
    /// 현재 재고 잔량 합.
    pub available_g: f64,
    /// 주문했지만 미입고인 라인의 중량 합.
    pub pending_g: f64,
    /// max(0, required − available − pending).
    pub net_needed_g: f64,
}
