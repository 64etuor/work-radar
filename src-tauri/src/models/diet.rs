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
    /// 영양 계산 SSOT. qty/unit이 주어졌으면 커널 환산 결과가 여기에 확정돼 있다.
    pub qty_g: f64,
    /// 표기 수량(1.5) — 표시 전용. 계산은 항상 `qty_g`.
    pub qty: Option<f64>,
    /// 표기 단위('tbsp','clove' …). None이면 g로 표기.
    pub unit: Option<String>,
    /// "간 맞춰서" 표기 플래그. 영양 계산은 여전히 `qty_g`(명목값)를 쓴다 — 빼면 나트륨 과소계상.
    pub to_taste: bool,
    pub optional: bool,
    pub note: Option<String>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeIngredientInput {
    pub food_id: String,
    /// g 직접 지정. **있으면 이 값이 이긴다**(`qty`/`unit`은 표기로만 보존) — 되돌리기가
    /// 환산 테이블 변경에 흔들리지 않게 하는 계약. 없으면 `qty`+`unit`을 커널이 환산한다.
    /// 둘 다 없으면 검증 오류.
    pub qty_g: Option<f64>,
    /// 표기 수량. `unit`과 함께 준다.
    pub qty: Option<f64>,
    pub unit: Option<String>,
    #[serde(default)]
    pub to_taste: bool,
    pub optional: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeStep {
    pub id: String,
    pub recipe_id: String,
    /// 1-based 표시 번호 — **쿼리타임 파생**(ROW_NUMBER over sort_rank). 저장 컬럼이 아니다.
    pub step_no: i32,
    pub sort_rank: f64,
    pub body: String,
    pub duration_minutes: Option<i32>,
    /// 단계별 튜닝 메모("여기서 불 줄이면 안 눌러붙음").
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeStepInput {
    pub body: String,
    pub duration_minutes: Option<i32>,
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
    pub source_url: Option<String>,
    /// 완성 총량 — 1인분 g 파생·스케일링에 사용.
    pub yield_g: Option<f64>,
    /// 단계에 붙지 않는 상시 튜닝 메모(총평).
    pub notes: Option<String>,
    /// 현재 리비전 번호. patch 계열의 낙관적 동시성 토큰(`expectedRevNo`)으로도 쓴다.
    pub rev_no: i32,
    pub archived: bool,
    pub ingredients: Vec<RecipeIngredient>,
    pub steps: Vec<RecipeStep>,
    /// 전체(모든 재료 합) — 쿼리타임 커널 계산(저장 안 함).
    pub total: DietMacros,
    /// 1인분(total / servings).
    pub per_serving: DietMacros,
    pub created_at: String,
    pub updated_at: String,
}

// --- 리비전 ---------------------------------------------------------------
// 스냅샷은 **결과 상태** 전문이고, 파생값(food_name·영양)은 담지 않는다 — 담으면 되돌린 뒤
// food 수정 이력과 어긋난다. 되돌리기는 과거 스냅샷을 새 rev로 재적용(append-only).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum RecipeEditor {
    User,
    Agent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSnapshotIngredient {
    pub food_id: String,
    pub qty_g: f64,
    pub qty: Option<f64>,
    pub unit: Option<String>,
    pub to_taste: bool,
    pub optional: bool,
    pub note: Option<String>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSnapshotStep {
    pub sort_rank: f64,
    pub body: String,
    pub duration_minutes: Option<i32>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSnapshot {
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    pub ingredients: Vec<RecipeSnapshotIngredient>,
    pub steps: Vec<RecipeSnapshotStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRevision {
    pub id: String,
    pub recipe_id: String,
    pub rev_no: i32,
    pub change_summary: Option<String>,
    pub changed_by: RecipeEditor,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeRevisionDetail {
    pub revision: RecipeRevision,
    pub snapshot: RecipeSnapshot,
    /// 직전 리비전과의 차이 — **쿼리타임 계산**(저장하면 스냅샷과 어긋날 수 있다).
    pub diff_from_previous: Vec<RecipeDiffEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecipeDiffKind {
    MetaChanged,
    IngredientAdded,
    IngredientRemoved,
    IngredientChanged,
    StepAdded,
    StepRemoved,
    StepChanged,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeDiffEntry {
    pub kind: RecipeDiffKind,
    /// 무엇이 바뀌었나(필드명 / food_id / 단계 번호).
    pub label: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

// --- 맛 피드백 ------------------------------------------------------------
// 부호 규약: **+는 "그 방향이 과했다"**(salt +2 = 너무 짰다), −는 "부족했다".

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TasteAxis {
    Salt,
    Spice,
    Sweet,
    Sour,
    Richness,
    Doneness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TasteDirection {
    /// 과했다 → 줄여라.
    Reduce,
    /// 부족했다 → 늘려라.
    Increase,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TasteHint {
    pub axis: TasteAxis,
    pub direction: TasteDirection,
    /// 최근 가중 평균의 절대값(0..2).
    pub magnitude: f64,
    /// 이 축에 값을 남긴 피드백 수.
    pub samples: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeFeedback {
    pub id: String,
    pub recipe_id: String,
    pub rev_no: Option<i32>,
    pub meal_log_id: Option<String>,
    pub rating: Option<i32>,
    pub salt_delta: Option<i32>,
    pub spice_delta: Option<i32>,
    pub sweet_delta: Option<i32>,
    pub sour_delta: Option<i32>,
    pub richness_delta: Option<i32>,
    pub doneness_delta: Option<i32>,
    pub comment: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddRecipeFeedbackInput {
    pub recipe_id: String,
    /// 어느 리비전을 먹고 남긴 평가인지. None이면 커맨드가 현재 rev를 채운다.
    pub rev_no: Option<i32>,
    pub meal_log_id: Option<String>,
    pub rating: Option<i32>,
    pub salt_delta: Option<i32>,
    pub spice_delta: Option<i32>,
    pub sweet_delta: Option<i32>,
    pub sour_delta: Option<i32>,
    pub richness_delta: Option<i32>,
    pub doneness_delta: Option<i32>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeTasteSummary {
    pub sample_count: i32,
    pub avg_rating: Option<f64>,
    /// 축별 조정 **제안**. 자동 수정은 하지 않는다(사람/에이전트가 정한다).
    pub hints: Vec<TasteHint>,
    pub recent: Vec<RecipeFeedback>,
}

// --- 스케일링 / 추천 ------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScaledIngredient {
    pub food_id: String,
    pub food_name: String,
    pub qty_g: f64,
    /// 표기(예: "1.5 tbsp") — 원 재료가 단위 표기를 가진 경우만.
    pub display: Option<String>,
    pub available_g: f64,
    pub shortfall_g: f64,
    pub optional: bool,
    pub to_taste: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScaledRecipe {
    pub recipe_id: String,
    pub name: String,
    pub base_servings: f64,
    pub target_servings: f64,
    pub factor: f64,
    pub ingredients: Vec<ScaledIngredient>,
    pub total: DietMacros,
    pub per_serving: DietMacros,
    /// 재고 커버리지(0..100).
    pub coverage_pct: f64,
    pub missing_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecipeSuggestion {
    pub recipe_id: String,
    pub name: String,
    pub servings: f64,
    pub per_serving: DietMacros,
    pub coverage_pct: f64,
    /// 유통기한 임박 재료를 얼마나 소진하는가(0..100).
    pub expiry_pressure_pct: f64,
    pub earliest_expiry: Option<String>,
    /// 부족한 재료 이름(표시용).
    pub missing: Vec<String>,
    /// 결정론 종합 점수(0..100). 동점은 이름 → id 순으로 안정 정렬.
    pub score: f64,
}

/// 조리 = 재고 차감 + 섭취 기록을 한 번에. `consume_pantry=false`면 기록만(외식·남의 집).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CookRecipeInput {
    pub recipe_id: String,
    /// 만든 인분(생략 = 1인분). 레시피 기준 인분과 다르면 재료가 비례 스케일된다.
    pub servings: Option<f64>,
    /// 로컬 날짜(호출자 주입) 'YYYY-MM-DD'.
    pub date: String,
    /// 섭취 시각 RFC3339. None이면 서버가 now(로컬)로 채운다.
    pub at: Option<String>,
    /// 계획 식사와 연결하면 그 식사를 eaten으로 전이한다.
    pub planned_meal_id: Option<String>,
    /// 기본 true. false면 재고를 건드리지 않고 기록만 남긴다.
    pub consume_pantry: Option<bool>,
    pub satisfaction: Option<i32>,
    pub fullness: Option<i32>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CookRecipeResult {
    pub log: MealLog,
    /// 실제 차감된 총량 g.
    pub consumed_g: f64,
    pub lots_touched: i32,
    pub pantry_consumed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitConversion {
    pub id: String,
    pub unit: String,
    /// None = 전역 기본(폴백). Some = 그 식품 전용(전역을 이긴다).
    pub food_id: Option<String>,
    pub food_name: Option<String>,
    pub grams_per_unit: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertUnitConversionInput {
    pub unit: String,
    pub food_id: Option<String>,
    pub grams_per_unit: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRecipeInput {
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    pub ingredients: Vec<RecipeIngredientInput>,
    /// 조리 단계(순서대로). 빈 배열 허용 — 나중에 에이전트가 채울 수 있다.
    #[serde(default)]
    pub steps: Vec<RecipeStepInput>,
    /// rev 1의 작성자 귀속. 생략 시 `user`.
    #[serde(default)]
    pub changed_by: Option<RecipeEditor>,
}

/// 전체 교체(replace-all). UI 폼 저장·되돌리기 재적용 경로가 쓴다.
/// 에이전트의 반복 튜닝은 이걸 쓰지 말고 patch 계열(`PatchRecipeInput` 등)을 써야 한다 —
/// replace-all은 전문을 재전송하므로 동시 편집을 덮어쓴다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRecipeInput {
    pub id: String,
    /// 낙관적 동시성 토큰 — **필수**. 이 경로는 재료·단계를 전부 덮어쓰므로 stale 전문을
    /// 그냥 받으면 그 사이의 편집이 조용히 사라진다(patch 계열은 스코프가 한 행이라 optional).
    pub expected_rev_no: i32,
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    pub ingredients: Vec<RecipeIngredientInput>,
    #[serde(default)]
    pub steps: Vec<RecipeStepInput>,
    pub change_summary: Option<String>,
    #[serde(default)]
    pub changed_by: Option<RecipeEditor>,
}

/// 지울 수 있는 nullable 메타 필드. patch에서 "안 줬음"과 "지워라"를 구분하는 수단 —
/// `Option<Option<T>>`는 specta가 TS로 내리지 못하고(둘 다 `T | null`로 붕괴) 쓸 수 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RecipeClearableField {
    CookMinutes,
    SourceUrl,
    YieldG,
    Notes,
}

/// 부분 수정 — **준 필드만** 바뀐다. 재료/단계는 건드리지 않는다(전용 커맨드가 있다).
/// nullable 필드를 비우려면 `clear`에 그 필드를 넣는다(값과 clear를 동시에 주면 검증 오류).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchRecipeInput {
    pub id: String,
    pub expected_rev_no: Option<i32>,
    pub name: Option<String>,
    pub servings: Option<f64>,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Option<Vec<String>>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    #[serde(default)]
    pub clear: Vec<RecipeClearableField>,
    pub change_summary: Option<String>,
    #[serde(default)]
    pub changed_by: Option<RecipeEditor>,
}

/// 재료 1개 upsert. `id`가 있으면 그 행을 갱신, 없으면 추가.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRecipeIngredientInput {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// None = 추가. Some = 그 재료 행 갱신.
    pub id: Option<String>,
    pub ingredient: RecipeIngredientInput,
    /// None = 맨 끝. Some(0) = 맨 앞, Some(n) = n번째 재료 뒤.
    pub after_index: Option<i32>,
    pub change_summary: Option<String>,
    #[serde(default)]
    pub changed_by: Option<RecipeEditor>,
}

/// 단계 1개 upsert. `step_no`는 **1-based 파생 번호** — 커맨드가 내부 id로 해석한다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRecipeStepInput {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// Some = 그 번호의 단계를 교체. None = 삽입(`after_step_no` 위치).
    pub step_no: Option<i32>,
    /// 삽입 위치. None이면 맨 끝. Some(0) = 맨 앞.
    pub after_step_no: Option<i32>,
    pub step: RecipeStepInput,
    pub change_summary: Option<String>,
    #[serde(default)]
    pub changed_by: Option<RecipeEditor>,
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
