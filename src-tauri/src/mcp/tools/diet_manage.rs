//! Diet 관리 툴 — **사용자 결정(2026-07-17)으로 diet 도메인 전권을 에이전트에 위임**:
//! "헤르메스가 주도적으로 계획과 기록 수정 등 다 할 수 있게 폭 넓게 + 재고 입고도(주문 연동)".
//!
//! 이 모듈은 tools/diet.rs(read + record_meal)의 확장이다. 계획 생성/편집, 기록 정정,
//! 목표 버전 추가, 식품/레시피 라이브러리, 재고 입출고/보정/폐기, 주문 원장/입고를 연다.
//!
//! 결정레일 논증(2026-07-17 재정의): 이 도메인의 write는 전부 **사용자 대화를 통한 사실
//! 기록/집행 대행**이고 로컬 SQLite뿐이다(외부 mutate 0 — INVARIANT #2 비대상). 사람 게이트는
//! ADR-0012 원칙대로 **각 MCP 호스트의 승인 UI**(Hermes ACP permission card)다. 영양 수치는
//! 계획/기록 시점에 커널이 계산·스냅샷하므로 에이전트가 과거 이력을 재작성할 수 없고, 재고는
//! append-only `pantry_events`로 전 변경이 감사된다. 주문은 기록 원장 — 결제/체크아웃 능력이
//! 아니다(§7: 네트워크 0).

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::diet as diet_commands;
use crate::mcp::{enum_wire_string, mcp_tool_error, parse_iso_date, truncate_preview, WrServer};
use crate::models::{
    AddPantryLotInput, AddPlannedMealInput, AddPlannedMealItemInput, AddRecipeFeedbackInput,
    CookRecipeInput, CreateMealPlanInput, CreateRecipeInput, FoodType, GroceryOrderLineInput,
    GroceryOrderStatus, MealPlanStatus, MealType, PantryEventKind, PantryLocation,
    PatchRecipeInput, PlannedMealStatus, ReceiveOrderLineInput, RecipeClearableField, RecipeEditor,
    RecipeIngredientInput, RecipeStepInput, RecordGroceryOrderInput, SetDietGoalInput,
    SetRecipeIngredientInput, SetRecipeStepInput, UpdateRecipeInput, UpsertFoodInput,
    UpsertUnitConversionInput,
};

const NOTE_MAX_CHARS: usize = 500;
const NAME_MAX_CHARS: usize = 120;
const INSTRUCTIONS_MAX_CHARS: usize = 4000;
const MAX_TAGS: usize = 8;
const MAX_INGREDIENTS: usize = 50;
const MAX_STEPS: usize = 40;
const MAX_ORDER_LINES: usize = 50;
const TEXT_PREVIEW_CHARS: usize = 200;
const LIST_LIMIT: usize = 50;

#[allow(clippy::result_large_err)]
fn cap_chars(value: Option<&str>, max: usize, label: &str) -> Result<(), rmcp::ErrorData> {
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

/// "HH:MM" 검증(§2 — 자유 문자열을 좁힌다).
#[allow(clippy::result_large_err)]
fn validate_hhmm(raw: &str) -> Result<(), rmcp::ErrorData> {
    let bytes = raw.as_bytes();
    let ok = bytes.len() == 5
        && bytes[2] == b':'
        && raw[..2].bytes().all(|b| b.is_ascii_digit())
        && raw[3..].bytes().all(|b| b.is_ascii_digit())
        && &raw[..2] < "24"
        && &raw[3..] < "60";
    if !ok {
        return Err(rmcp::ErrorData::invalid_params(
            format!("scheduled_time must be HH:MM (got: {raw})"),
            None,
        ));
    }
    Ok(())
}

// ── 파라미터 enum들(닫힌 집합 — 모델 enum으로 매핑) ─────────────────

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum MealTypeParam {
    Breakfast,
    Lunch,
    Dinner,
    Snack,
    PreWorkout,
    PostWorkout,
    Free,
}

impl From<MealTypeParam> for MealType {
    fn from(v: MealTypeParam) -> Self {
        match v {
            MealTypeParam::Breakfast => MealType::Breakfast,
            MealTypeParam::Lunch => MealType::Lunch,
            MealTypeParam::Dinner => MealType::Dinner,
            MealTypeParam::Snack => MealType::Snack,
            MealTypeParam::PreWorkout => MealType::PreWorkout,
            MealTypeParam::PostWorkout => MealType::PostWorkout,
            MealTypeParam::Free => MealType::Free,
        }
    }
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum MealPlanStatusParam {
    Draft,
    Active,
    Archived,
}

impl From<MealPlanStatusParam> for MealPlanStatus {
    fn from(v: MealPlanStatusParam) -> Self {
        match v {
            MealPlanStatusParam::Draft => MealPlanStatus::Draft,
            MealPlanStatusParam::Active => MealPlanStatus::Active,
            MealPlanStatusParam::Archived => MealPlanStatus::Archived,
        }
    }
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum MealStatusParam {
    Planned,
    Eaten,
    Partial,
    Skipped,
}

impl From<MealStatusParam> for PlannedMealStatus {
    fn from(v: MealStatusParam) -> Self {
        match v {
            MealStatusParam::Planned => PlannedMealStatus::Planned,
            MealStatusParam::Eaten => PlannedMealStatus::Eaten,
            MealStatusParam::Partial => PlannedMealStatus::Partial,
            MealStatusParam::Skipped => PlannedMealStatus::Skipped,
        }
    }
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum FoodTypeParam {
    Ingredient,
    Product,
    Dish,
}

impl From<FoodTypeParam> for FoodType {
    fn from(v: FoodTypeParam) -> Self {
        match v {
            FoodTypeParam::Ingredient => FoodType::Ingredient,
            FoodTypeParam::Product => FoodType::Product,
            FoodTypeParam::Dish => FoodType::Dish,
        }
    }
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum PantryLocationParam {
    Fridge,
    Freezer,
    Pantry,
    Other,
}

impl From<PantryLocationParam> for PantryLocation {
    fn from(v: PantryLocationParam) -> Self {
        match v {
            PantryLocationParam::Fridge => PantryLocation::Fridge,
            PantryLocationParam::Freezer => PantryLocation::Freezer,
            PantryLocationParam::Pantry => PantryLocation::Pantry,
            PantryLocationParam::Other => PantryLocation::Other,
        }
    }
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum WasteKindParam {
    Wasted,
    Expired,
}

impl From<WasteKindParam> for PantryEventKind {
    fn from(v: WasteKindParam) -> Self {
        match v {
            WasteKindParam::Wasted => PantryEventKind::Wasted,
            WasteKindParam::Expired => PantryEventKind::Expired,
        }
    }
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatusParam {
    Ordered,
    Delivered,
    Cancelled,
}

impl From<OrderStatusParam> for GroceryOrderStatus {
    fn from(v: OrderStatusParam) -> Self {
        match v {
            OrderStatusParam::Ordered => GroceryOrderStatus::Ordered,
            OrderStatusParam::Delivered => GroceryOrderStatus::Delivered,
            OrderStatusParam::Cancelled => GroceryOrderStatus::Cancelled,
        }
    }
}

// ── 파라미터 구조체 ───────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietSetGoalParams {
    /// 적용 시작일 YYYY-MM-DD. 목표는 append-only 버전 — 과거 이력은 불변.
    pub effective_date: String,
    /// 일일 목표 열량 kcal.
    pub calorie_target: f64,
    /// 허용 편차 %(생략 시 10).
    pub calorie_tolerance_pct: Option<f64>,
    /// 최소 단백질 g(선택).
    pub protein_min_g: Option<f64>,
    /// 짧은 메모(≤500자, 선택).
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietCreatePlanParams {
    /// 시작일 YYYY-MM-DD.
    pub start_date: String,
    /// 종료일 YYYY-MM-DD(시작일 이상).
    pub end_date: String,
    /// 짧은 메모(≤500자, 선택). 생성 상태는 draft — 활성화는 set_meal_plan_status.
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietPlanStatusParams {
    pub plan_id: String,
    pub status: MealPlanStatusParam,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietPlanIdParams {
    pub plan_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietAddMealParams {
    pub plan_id: String,
    /// 계획 창 안의 날짜 YYYY-MM-DD.
    pub date: String,
    pub meal_type: MealTypeParam,
    /// 예정 시각 HH:MM(선택).
    pub scheduled_time: Option<String>,
    /// 짧은 메모(≤500자, 선택).
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietMealIdParams {
    pub meal_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietMealStatusParams {
    pub meal_id: String,
    /// 가역 상태 전이 — eaten/partial은 섭취 로그를 만들지 않는다(로그는 record_meal).
    pub status: MealStatusParam,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietAddMealItemParams {
    pub meal_id: String,
    /// recipe_id XOR food_id 중 정확히 하나.
    pub recipe_id: Option<String>,
    pub food_id: Option<String>,
    /// recipe 경로 전용 — 인분 수.
    pub servings: Option<f64>,
    /// food 경로 전용 — 중량 g.
    pub qty_g: Option<f64>,
    /// 짧은 메모(≤500자, 선택). 영양은 커널이 추가 시점 스냅샷으로 계산한다.
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietMealItemIdParams {
    pub item_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRetractMealLogParams {
    /// 철회할 섭취 로그 id(`wr_diet_meal_logs`로 조회). 정정 = 철회 후 record_meal 재기록.
    pub log_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietUpsertFoodParams {
    /// 생략 = 새 식품, 지정 = 해당 식품 갱신(검색으로 id 확인 후).
    pub id: Option<String>,
    /// 표준 이름(≤120자).
    pub name: String,
    pub food_type: FoodTypeParam,
    pub kcal_per_100g: f64,
    /// 생략 시 0.
    pub protein_g_per_100g: Option<f64>,
    pub fat_g_per_100g: Option<f64>,
    pub carb_g_per_100g: Option<f64>,
    /// 기본 1회분 g(선택).
    pub default_serving_g: Option<f64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietIngredientParam {
    pub food_id: String,
    /// g 직접 지정. 있으면 이 값이 이긴다. 없으면 `qty`+`unit`을 g으로 환산한다.
    pub qty_g: Option<f64>,
    /// 표기 수량(예: 1.5). `unit`과 반드시 함께.
    pub qty: Option<f64>,
    /// 표기 단위('tbsp','tsp','clove','pinch','ea' …). 환산이 등록돼 있어야 한다 —
    /// 없으면 오류이며 `wr_diet_upsert_unit_conversion`으로 먼저 등록한다.
    pub unit: Option<String>,
    /// "간 맞춰서" 표기 플래그(생략 시 false). 영양 계산은 여전히 g 값을 쓴다.
    pub to_taste: Option<bool>,
    /// 선택 재료 여부(생략 시 false).
    pub optional: Option<bool>,
    /// 짧은 메모(≤500자, 선택).
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietStepParam {
    /// 단계 본문(≤4000자).
    pub body: String,
    /// 이 단계에 걸리는 시간 분(선택, > 0).
    pub duration_minutes: Option<u32>,
    /// 단계별 튜닝 메모(≤500자, 선택).
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietCreateRecipeParams {
    /// 이름(≤120자).
    pub name: String,
    /// 기준 인분(> 0).
    pub servings: f64,
    /// 조리 시간 분(선택).
    pub cook_minutes: Option<u32>,
    /// 태그(최대 8개).
    pub meal_tags: Option<Vec<String>>,
    /// 출처 URL(선택).
    pub source_url: Option<String>,
    /// 완성 총량 g(선택).
    pub yield_g: Option<f64>,
    /// 단계에 붙지 않는 총평 메모(≤4000자, 선택).
    pub notes: Option<String>,
    /// 재료 목록(최대 50개).
    pub ingredients: Vec<DietIngredientParam>,
    /// 조리 단계(순서대로, 최대 40개). 생략 가능 — 나중에 단계별로 채울 수 있다.
    pub steps: Option<Vec<DietStepParam>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietUpdateRecipeParams {
    pub id: String,
    /// 낙관적 동시성 토큰 — **필수**. `wr_diet_get_recipe`로 읽은 `revNo`를 그대로 넘겨라.
    /// 이 툴은 재료·단계를 전부 덮어쓰므로, 그 사이 누군가(앱 UI 포함) 고쳤으면 거부된다.
    pub expected_rev_no: i32,
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<u32>,
    pub meal_tags: Option<Vec<String>>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    /// 전체 교체(replace-all) — 과거 계획/기록은 스냅샷이라 불변.
    pub ingredients: Vec<DietIngredientParam>,
    pub steps: Option<Vec<DietStepParam>>,
    /// 무엇을 왜 바꿨는지(≤500자). 리비전 이력에 남는다.
    pub change_summary: Option<String>,
}

// ── patch 계열 파라미터 ──────────────────────────────────────────
// 반복 튜닝은 전체 교체가 아니라 아래 patch 툴로 한다 — replace-all은 전문을 재전송하므로
// 그 사이의 앱 UI 편집을 덮어쓴다.

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietPatchRecipeParams {
    pub id: String,
    pub expected_rev_no: Option<i32>,
    /// 준 필드만 바뀐다. 재료·단계는 건드리지 않는다(전용 툴 사용).
    pub name: Option<String>,
    pub servings: Option<f64>,
    pub cook_minutes: Option<u32>,
    pub meal_tags: Option<Vec<String>>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    /// 비울 필드 목록('cook_minutes','source_url','yield_g','notes'). 같은 필드를 값과
    /// clear로 동시에 주면 오류.
    pub clear: Option<Vec<DietClearableFieldParam>>,
    pub change_summary: Option<String>,
}

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum DietClearableFieldParam {
    CookMinutes,
    SourceUrl,
    YieldG,
    Notes,
}

impl From<DietClearableFieldParam> for RecipeClearableField {
    fn from(v: DietClearableFieldParam) -> Self {
        match v {
            DietClearableFieldParam::CookMinutes => RecipeClearableField::CookMinutes,
            DietClearableFieldParam::SourceUrl => RecipeClearableField::SourceUrl,
            DietClearableFieldParam::YieldG => RecipeClearableField::YieldG,
            DietClearableFieldParam::Notes => RecipeClearableField::Notes,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietSetRecipeIngredientParams {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// 기존 재료 행 id(= `wr_diet_get_recipe`의 `ingredients[].id`). 생략하면 추가.
    pub id: Option<String>,
    pub ingredient: DietIngredientParam,
    /// 추가 위치: 생략=맨 끝, 0=맨 앞, n=n번째 재료 뒤.
    pub after_index: Option<i32>,
    pub change_summary: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRemoveRecipeIngredientParams {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    pub ingredient_id: String,
    pub change_summary: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietSetRecipeStepParams {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// 1-based 단계 번호를 주면 **그 단계를 교체**한다. 생략하면 삽입.
    pub step_no: Option<i32>,
    /// 삽입 위치: 생략=맨 끝, 0=맨 앞, n=n번째 단계 뒤.
    pub after_step_no: Option<i32>,
    pub step: DietStepParam,
    pub change_summary: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRemoveRecipeStepParams {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// 1-based 단계 번호.
    pub step_no: i32,
    pub change_summary: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietReorderRecipeStepsParams {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// 현재 1-based 단계 번호의 **완전 순열**(모든 단계를 정확히 한 번). 부분 목록은 오류.
    pub order: Vec<i32>,
    pub change_summary: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRecipeIdParams {
    pub recipe_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRevertRecipeParams {
    pub recipe_id: String,
    pub expected_rev_no: Option<i32>,
    /// 되돌릴 대상 리비전 번호. 이력을 재작성하지 않고 **새 리비전으로 재적용**된다.
    pub rev_no: i32,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRecipeRevisionParams {
    pub recipe_id: String,
    pub rev_no: i32,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietScaleRecipeParams {
    pub recipe_id: String,
    /// 목표 인분(생략 = 레시피 기준 인분).
    pub target_servings: Option<f64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRecipeFeedbackParams {
    pub recipe_id: String,
    /// 어느 리비전을 먹은 평가인지(생략 = 현재 리비전).
    pub rev_no: Option<i32>,
    /// 연결할 섭취 기록 id(선택).
    pub meal_log_id: Option<String>,
    /// 전체 만족도 1..5(선택).
    pub rating: Option<i32>,
    /// 축별 −2..+2. **부호 규약: +는 "그 방향이 과했다"**(salt=+2는 너무 짰다),
    /// −는 "부족했다". 다음 튜닝의 근거로 집계된다.
    pub salt_delta: Option<i32>,
    pub spice_delta: Option<i32>,
    pub sweet_delta: Option<i32>,
    pub sour_delta: Option<i32>,
    pub richness_delta: Option<i32>,
    pub doneness_delta: Option<i32>,
    /// 자유 코멘트(≤500자).
    pub comment: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietSuggestionParams {
    /// 오늘 날짜 YYYY-MM-DD(호출자 주입 — 유통기한 긴급도의 기준).
    pub today: String,
    /// 최대 개수(기본 10, 상한 50).
    pub limit: Option<i32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietCookRecipeParams {
    pub recipe_id: String,
    /// 만든 인분(생략 = 1). 레시피 기준 인분과 다르면 재료가 비례 스케일된다.
    pub servings: Option<f64>,
    /// 로컬 날짜 YYYY-MM-DD.
    pub date: String,
    /// 섭취 시각 RFC3339(생략 = 지금).
    pub at: Option<String>,
    /// 계획 식사 id — 주면 그 식사를 eaten으로 전이한다.
    pub planned_meal_id: Option<String>,
    /// 기본 true. false면 재고를 건드리지 않고 기록만.
    pub consume_pantry: Option<bool>,
    pub satisfaction: Option<i32>,
    pub fullness: Option<i32>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietUpsertUnitConversionParams {
    /// 단위 이름('tbsp','clove' …). 소문자로 정규화된다.
    pub unit: String,
    /// 이 식품에만 적용할 환산(생략 = 전역 기본). 식품 전용이 전역을 이긴다.
    pub food_id: Option<String>,
    /// 1단위 = 몇 g인가(> 0).
    pub grams_per_unit: f64,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRecipeSearchParams {
    /// 이름 부분 일치(생략 = 전체, 최대 50개 반환).
    pub query: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietAddPantryLotParams {
    pub food_id: String,
    pub location: PantryLocationParam,
    /// 입고일 YYYY-MM-DD.
    pub acquired_on: String,
    /// 유통기한 YYYY-MM-DD(선택).
    pub expires_on: Option<String>,
    /// 수량 g(> 0).
    pub qty_g: f64,
    /// 짧은 메모(≤500자, 선택).
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietConsumePantryParams {
    pub food_id: String,
    /// 차감량 g(> 0) — 유통기한 빠른 로트부터(FEFO). 부족해도 있는 만큼 차감 + shortfall 보고.
    pub qty_g: f64,
    /// 짧은 사유(≤500자, 선택).
    pub reason: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietAdjustLotParams {
    pub lot_id: String,
    /// 실측 잔량 g(≥ 0) — 차이는 adjusted 이벤트로 감사된다.
    pub new_remaining_g: f64,
    pub reason: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietWasteLotParams {
    pub lot_id: String,
    /// 폐기량 g(생략 = 잔량 전부).
    pub qty_g: Option<f64>,
    pub kind: WasteKindParam,
    pub reason: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietOrderLineParam {
    /// 상품명(≤120자).
    pub product_name: String,
    /// 연결 식품 id(선택 — 나중에 set_order_line_food로 연결 가능).
    pub food_id: Option<String>,
    /// 총 중량 g(선택).
    pub total_g: Option<f64>,
    /// 라인 금액 KRW(선택).
    pub line_total_krw: Option<i32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietRecordOrderParams {
    /// 판매처(coupang/kurly/offline 등 자유, ≤120자).
    pub merchant: String,
    /// 주문 시각(YYYY-MM-DD 또는 RFC3339).
    pub ordered_at: String,
    /// 외부 주문번호(선택, ≤120자).
    pub external_order_no: Option<String>,
    /// 총액 KRW(선택).
    pub total_krw: Option<i32>,
    /// 배송비 KRW(선택).
    pub shipping_krw: Option<i32>,
    /// 라인 목록(1..50).
    pub lines: Vec<DietOrderLineParam>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietOrderStatusParams {
    pub order_id: String,
    pub status: OrderStatusParam,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietLinkOrderLineParams {
    pub line_id: String,
    /// 연결할 식품 id(입고 전 필수).
    pub food_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DietReceiveOrderLineParams {
    pub line_id: String,
    pub location: PantryLocationParam,
    /// 입고일 YYYY-MM-DD.
    pub acquired_on: String,
    /// 유통기한 YYYY-MM-DD(선택).
    pub expires_on: Option<String>,
    /// 라인에 중량이 없거나 실측이 다를 때 override g.
    pub total_g_override: Option<f64>,
}

// ── 결과 DTO(§6 — 짧은 구조화 출력) ──────────────────────────────────

#[derive(Serialize, JsonSchema)]
pub struct DietIdResultDto {
    pub id: String,
}

#[derive(Serialize, JsonSchema)]
pub struct DietOkResultDto {
    pub ok: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPlanDto {
    pub id: String,
    pub start_date: String,
    pub end_date: String,
    /// "draft" | "active" | "archived".
    pub status: String,
    pub calorie_target: Option<f64>,
    pub protein_min_g: Option<f64>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPlanListDto {
    pub plans: Vec<DietPlanDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPlanItemDto {
    pub id: String,
    pub label: String,
    pub recipe_id: Option<String>,
    pub food_id: Option<String>,
    pub servings: Option<f64>,
    pub qty_g: Option<f64>,
    pub kcal: f64,
    pub protein_g: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPlanMealDto {
    pub id: String,
    pub date: String,
    pub meal_type: String,
    pub scheduled_time: Option<String>,
    pub status: String,
    pub items: Vec<DietPlanItemDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietPlanDetailDto {
    pub plan: DietPlanDto,
    pub meals: Vec<DietPlanMealDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietMealLogDto {
    pub id: String,
    pub at: String,
    pub description_preview: Option<String>,
    pub kcal: f64,
    pub protein_g: f64,
    pub planned_meal_id: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietMealLogListDto {
    pub date: String,
    pub logs: Vec<DietMealLogDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeSummaryDto {
    pub id: String,
    pub name: String,
    pub servings: f64,
    pub per_serving_kcal: f64,
    pub per_serving_protein_g: f64,
    pub ingredient_count: u32,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeListDto {
    pub recipes: Vec<DietRecipeSummaryDto>,
    pub truncated: bool,
}

// ── 레시피 저작 read DTO ─────────────────────────────────────────

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeIngredientDto {
    /// patch 툴의 `id`로 그대로 넘길 수 있는 재료 행 id.
    pub id: String,
    pub food_id: String,
    pub food_name: String,
    pub qty_g: f64,
    /// 표기(예: "1.5 tbsp") — 단위 표기가 있는 재료만.
    pub display: Option<String>,
    pub to_taste: bool,
    pub optional: bool,
    pub note: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeStepDto {
    /// 1-based 번호. patch 툴의 `step_no`로 그대로 넘긴다.
    pub step_no: i32,
    pub body: String,
    pub duration_minutes: Option<i32>,
    pub note: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietTasteHintDto {
    /// 'salt' | 'spice' | 'sweet' | 'sour' | 'richness' | 'doneness'
    pub axis: String,
    /// 'reduce'(과했다) | 'increase'(부족했다)
    pub direction: String,
    pub magnitude: f64,
    pub samples: i32,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeDetailDto {
    pub id: String,
    /// **patch 툴에 `expected_rev_no`로 그대로 넘겨라** — 동시 편집 덮어쓰기를 막는다.
    pub rev_no: i32,
    pub name: String,
    pub servings: f64,
    pub cook_minutes: Option<i32>,
    pub meal_tags: Vec<String>,
    pub source_url: Option<String>,
    pub yield_g: Option<f64>,
    pub notes: Option<String>,
    pub archived: bool,
    pub ingredients: Vec<DietRecipeIngredientDto>,
    pub steps: Vec<DietRecipeStepDto>,
    pub total_kcal: f64,
    pub per_serving_kcal: f64,
    pub per_serving_protein_g: f64,
    /// 최근 피드백 수.
    pub feedback_count: i32,
    pub avg_rating: Option<f64>,
    /// 다음 튜닝 제안(자동 적용되지 않는다 — 바꾸려면 patch 툴을 호출해야 한다).
    pub taste_hints: Vec<DietTasteHintDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeRevisionDto {
    pub rev_no: i32,
    pub change_summary: Option<String>,
    /// 'user' | 'agent'
    pub changed_by: String,
    pub created_at: String,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeRevisionListDto {
    pub recipe_id: String,
    pub current_rev_no: i32,
    pub revisions: Vec<DietRecipeRevisionDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeDiffEntryDto {
    /// 'meta_changed' | 'ingredient_added' | 'ingredient_removed' | 'ingredient_changed'
    /// | 'step_added' | 'step_removed' | 'step_changed'
    pub kind: String,
    pub label: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietRecipeRevisionDetailDto {
    pub revision: DietRecipeRevisionDto,
    /// 직전 리비전과의 차이(최초 리비전이면 빈 목록).
    pub diff_from_previous: Vec<DietRecipeDiffEntryDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietScaledIngredientDto {
    pub food_id: String,
    pub food_name: String,
    pub qty_g: f64,
    pub display: Option<String>,
    pub available_g: f64,
    /// 부족분 g(0 = 재고 충분).
    pub shortfall_g: f64,
    pub optional: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct DietScaledRecipeDto {
    pub recipe_id: String,
    pub name: String,
    pub base_servings: f64,
    pub target_servings: f64,
    pub factor: f64,
    pub ingredients: Vec<DietScaledIngredientDto>,
    pub total_kcal: f64,
    pub per_serving_kcal: f64,
    /// 재고 커버리지 0..100.
    pub coverage_pct: f64,
    pub missing_count: i32,
}

#[derive(Serialize, JsonSchema)]
pub struct DietTasteSummaryDto {
    pub recipe_id: String,
    pub sample_count: i32,
    pub avg_rating: Option<f64>,
    pub taste_hints: Vec<DietTasteHintDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietUnitConversionDto {
    pub unit: String,
    /// None = 전역 기본(폴백). 값이 있으면 그 식품 전용(전역을 이긴다).
    pub food_id: Option<String>,
    pub food_name: Option<String>,
    pub grams_per_unit: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietUnitConversionListDto {
    pub conversions: Vec<DietUnitConversionDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietSuggestionDto {
    pub recipe_id: String,
    pub name: String,
    pub servings: f64,
    pub per_serving_kcal: f64,
    /// 재고 커버리지 0..100.
    pub coverage_pct: f64,
    /// 유통기한 임박 재고를 얼마나 소진하는가 0..100.
    pub expiry_pressure_pct: f64,
    pub earliest_expiry: Option<String>,
    pub missing: Vec<String>,
    /// 결정론 종합 점수 0..100(커버리지 0.5 + 임박 0.3 + 목표적합 0.2).
    pub score: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietSuggestionListDto {
    pub suggestions: Vec<DietSuggestionDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietCookResultDto {
    pub meal_log_id: String,
    pub kcal: f64,
    pub protein_g: f64,
    /// 실제 차감된 총량 g.
    pub consumed_g: f64,
    pub lots_touched: i32,
    pub pantry_consumed: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct DietConsumeResultDto {
    /// 재고 부족으로 못 차감한 양(0 = 완전 충족).
    pub shortfall_g: f64,
    pub lots_touched: u32,
}

#[derive(Serialize, JsonSchema)]
pub struct DietLotResultDto {
    pub lot_id: String,
    pub remaining_g: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct DietOrderLineDto {
    pub id: String,
    pub product_name: String,
    pub food_id: Option<String>,
    pub total_g: Option<f64>,
    pub received: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct DietOrderDto {
    pub id: String,
    pub merchant: String,
    pub ordered_at: String,
    /// "ordered" | "delivered" | "cancelled".
    pub status: String,
    pub total_krw: Option<i32>,
    pub lines: Vec<DietOrderLineDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct DietOrderListDto {
    pub orders: Vec<DietOrderDto>,
}

fn plan_dto(p: &crate::models::MealPlan) -> DietPlanDto {
    DietPlanDto {
        id: p.id.clone(),
        start_date: p.start_date.clone(),
        end_date: p.end_date.clone(),
        status: enum_wire_string(&p.status),
        calorie_target: p.calorie_target,
        protein_min_g: p.protein_min_g,
    }
}

fn order_dto(o: crate::models::GroceryOrder) -> DietOrderDto {
    DietOrderDto {
        id: o.id,
        merchant: truncate_preview(&o.merchant, NAME_MAX_CHARS),
        ordered_at: o.ordered_at,
        status: enum_wire_string(&o.status),
        total_krw: o.total_krw,
        lines: o
            .lines
            .into_iter()
            .map(|l| DietOrderLineDto {
                id: l.id,
                product_name: truncate_preview(&l.product_name, NAME_MAX_CHARS),
                food_id: l.food_id,
                total_g: l.total_g,
                received: l.received,
            })
            .collect(),
    }
}

#[tool_router(router = tool_router_diet_manage, vis = "pub(crate)")]
impl WrServer {
    // ── 읽기(편집에 필요한 id 표면) ──────────────────────────────

    #[tool(
        name = "wr_diet_list_meal_plans",
        description = "List meal plans (id, window, status, goal snapshot). Read-only."
    )]
    pub async fn diet_list_meal_plans(&self) -> Result<Json<DietPlanListDto>, rmcp::ErrorData> {
        let plans = diet_commands::list_meal_plans_inner(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_list_meal_plans", &e))?;
        Ok(Json(DietPlanListDto {
            plans: plans.iter().take(LIST_LIMIT).map(plan_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_diet_get_meal_plan",
        description = "Full detail of one meal plan: meals per date with item ids and nutrition snapshots. Read-only."
    )]
    pub async fn diet_get_meal_plan(
        &self,
        Parameters(p): Parameters<DietPlanIdParams>,
    ) -> Result<Json<DietPlanDetailDto>, rmcp::ErrorData> {
        self.diet_get_meal_plan_inner(p).await
    }

    pub(crate) async fn diet_get_meal_plan_inner(
        &self,
        p: DietPlanIdParams,
    ) -> Result<Json<DietPlanDetailDto>, rmcp::ErrorData> {
        let detail = diet_commands::get_meal_plan_inner(&self.db, &p.plan_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_get_meal_plan", &e))?;
        Ok(Json(DietPlanDetailDto {
            plan: plan_dto(&detail.plan),
            meals: detail
                .meals
                .into_iter()
                .map(|m| DietPlanMealDto {
                    id: m.id,
                    date: m.date,
                    meal_type: enum_wire_string(&m.meal_type),
                    scheduled_time: m.scheduled_time,
                    status: enum_wire_string(&m.status),
                    items: m
                        .items
                        .into_iter()
                        .map(|i| DietPlanItemDto {
                            id: i.id,
                            label: truncate_preview(&i.label, TEXT_PREVIEW_CHARS),
                            recipe_id: i.recipe_id,
                            food_id: i.food_id,
                            servings: i.servings,
                            qty_g: i.qty_g,
                            kcal: i.kcal,
                            protein_g: i.protein_g,
                        })
                        .collect(),
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_meal_logs",
        description = "Intake log rows for a date with ids (needed to retract a wrong entry). Read-only."
    )]
    pub async fn diet_meal_logs(
        &self,
        Parameters(p): Parameters<super::diet::DietDateParams>,
    ) -> Result<Json<DietMealLogListDto>, rmcp::ErrorData> {
        self.diet_meal_logs_inner(p).await
    }

    pub(crate) async fn diet_meal_logs_inner(
        &self,
        p: super::diet::DietDateParams,
    ) -> Result<Json<DietMealLogListDto>, rmcp::ErrorData> {
        parse_iso_date(&p.date)?;
        let logs = diet_commands::list_meal_logs_inner(&self.db, &p.date, &p.date)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_meal_logs", &e))?;
        Ok(Json(DietMealLogListDto {
            date: p.date.trim().to_string(),
            logs: logs
                .into_iter()
                .map(|l| DietMealLogDto {
                    id: l.id,
                    at: l.at,
                    description_preview: l
                        .description
                        .as_deref()
                        .map(|d| truncate_preview(d, TEXT_PREVIEW_CHARS)),
                    kcal: l.kcal,
                    protein_g: l.protein_g,
                    planned_meal_id: l.planned_meal_id,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_list_recipes",
        description = "List recipes (id, base servings, per-serving nutrition) for building meal plans. Read-only."
    )]
    pub async fn diet_list_recipes(
        &self,
        Parameters(p): Parameters<DietRecipeSearchParams>,
    ) -> Result<Json<DietRecipeListDto>, rmcp::ErrorData> {
        self.diet_list_recipes_inner(p).await
    }

    pub(crate) async fn diet_list_recipes_inner(
        &self,
        p: DietRecipeSearchParams,
    ) -> Result<Json<DietRecipeListDto>, rmcp::ErrorData> {
        cap_chars(p.query.as_deref(), 80, "query")?;
        let recipes = diet_commands::list_recipes_inner(&self.db, p.query, false)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_list_recipes", &e))?;
        let truncated = recipes.len() > LIST_LIMIT;
        Ok(Json(DietRecipeListDto {
            recipes: recipes
                .into_iter()
                .take(LIST_LIMIT)
                .map(|r| DietRecipeSummaryDto {
                    id: r.id,
                    name: truncate_preview(&r.name, NAME_MAX_CHARS),
                    servings: r.servings,
                    per_serving_kcal: r.per_serving.kcal,
                    per_serving_protein_g: r.per_serving.protein_g,
                    ingredient_count: r.ingredients.len().min(u32::MAX as usize) as u32,
                })
                .collect(),
            truncated,
        }))
    }

    #[tool(
        name = "wr_diet_list_orders",
        description = "Recent grocery orders with line ids and received flags (record-keeping ledger; no checkout ability). Read-only."
    )]
    pub async fn diet_list_orders(&self) -> Result<Json<DietOrderListDto>, rmcp::ErrorData> {
        let orders = diet_commands::list_grocery_orders_inner(&self.db, 20)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_list_orders", &e))?;
        Ok(Json(DietOrderListDto {
            orders: orders.into_iter().map(order_dto).collect(),
        }))
    }

    // ── 목표/계획/기록 write ─────────────────────────────────────

    #[tool(
        name = "wr_diet_set_goal",
        description = "Append a new nutrition goal version (effective from a date). History is append-only; past plans/logs keep their snapshots."
    )]
    pub async fn diet_set_goal(
        &self,
        Parameters(p): Parameters<DietSetGoalParams>,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        self.diet_set_goal_inner(p).await
    }

    pub(crate) async fn diet_set_goal_inner(
        &self,
        p: DietSetGoalParams,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let goal = diet_commands::set_diet_goal_inner(
            &self.db,
            SetDietGoalInput {
                effective_date: p.effective_date,
                calorie_target: p.calorie_target,
                calorie_tolerance_pct: p.calorie_tolerance_pct,
                protein_min_g: p.protein_min_g,
                fat_min_g: None,
                carb_target_g: None,
                fiber_min_g: None,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_set_goal", &e))?;
        Ok(Json(DietIdResultDto { id: goal.id }))
    }

    #[tool(
        name = "wr_diet_create_meal_plan",
        description = "Create a meal plan (draft) for a date window, snapshotting the active goal. Activate it with wr_diet_set_meal_plan_status."
    )]
    pub async fn diet_create_meal_plan(
        &self,
        Parameters(p): Parameters<DietCreatePlanParams>,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        self.diet_create_meal_plan_inner(p).await
    }

    pub(crate) async fn diet_create_meal_plan_inner(
        &self,
        p: DietCreatePlanParams,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let plan = diet_commands::create_meal_plan_inner(
            &self.db,
            CreateMealPlanInput {
                start_date: p.start_date,
                end_date: p.end_date,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_create_meal_plan", &e))?;
        Ok(Json(DietIdResultDto { id: plan.id }))
    }

    #[tool(
        name = "wr_diet_set_meal_plan_status",
        description = "Transition a meal plan between draft/active/archived (reversible)."
    )]
    pub async fn diet_set_meal_plan_status(
        &self,
        Parameters(p): Parameters<DietPlanStatusParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::set_meal_plan_status_inner(&self.db, &p.plan_id, p.status.into())
            .await
            .map_err(|e| mcp_tool_error("wr_diet_set_meal_plan_status", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_add_meal",
        description = "Add a planned meal slot (date + meal type) to a plan; date must be inside the plan window."
    )]
    pub async fn diet_add_meal(
        &self,
        Parameters(p): Parameters<DietAddMealParams>,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        self.diet_add_meal_inner(p).await
    }

    pub(crate) async fn diet_add_meal_inner(
        &self,
        p: DietAddMealParams,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        if let Some(t) = p.scheduled_time.as_deref() {
            validate_hhmm(t)?;
        }
        let meal = diet_commands::add_planned_meal_inner(
            &self.db,
            AddPlannedMealInput {
                plan_id: p.plan_id,
                date: p.date,
                meal_type: p.meal_type.into(),
                scheduled_time: p.scheduled_time,
                note: p.note,
                sort_rank: 0,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_add_meal", &e))?;
        Ok(Json(DietIdResultDto { id: meal.id }))
    }

    #[tool(
        name = "wr_diet_remove_meal",
        description = "Remove a planned meal slot (and its items) from a plan."
    )]
    pub async fn diet_remove_meal(
        &self,
        Parameters(p): Parameters<DietMealIdParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::remove_planned_meal_inner(&self.db, &p.meal_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_remove_meal", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_set_meal_status",
        description = "Set a planned meal's status (planned/eaten/partial/skipped). Reversible; does not create an intake log — use wr_diet_record_meal to log intake."
    )]
    pub async fn diet_set_meal_status(
        &self,
        Parameters(p): Parameters<DietMealStatusParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::set_planned_meal_status_inner(&self.db, &p.meal_id, p.status.into())
            .await
            .map_err(|e| mcp_tool_error("wr_diet_set_meal_status", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_add_meal_item",
        description = "Add an item (recipe by servings, or food by grams) to a planned meal; nutrition is computed and snapshotted by the deterministic kernel."
    )]
    pub async fn diet_add_meal_item(
        &self,
        Parameters(p): Parameters<DietAddMealItemParams>,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        self.diet_add_meal_item_inner(p).await
    }

    pub(crate) async fn diet_add_meal_item_inner(
        &self,
        p: DietAddMealItemParams,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let item = diet_commands::add_planned_meal_item_inner(
            &self.db,
            AddPlannedMealItemInput {
                planned_meal_id: p.meal_id,
                recipe_id: p.recipe_id,
                food_id: p.food_id,
                servings: p.servings,
                qty_g: p.qty_g,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_add_meal_item", &e))?;
        Ok(Json(DietIdResultDto { id: item.id }))
    }

    #[tool(
        name = "wr_diet_remove_meal_item",
        description = "Remove one item from a planned meal."
    )]
    pub async fn diet_remove_meal_item(
        &self,
        Parameters(p): Parameters<DietMealItemIdParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::remove_planned_meal_item_inner(&self.db, &p.item_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_remove_meal_item", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_retract_meal_log",
        description = "Retract a wrong intake log row from the local ledger (correction = retract, then re-record with wr_diet_record_meal). If this was the only log backing a planned meal, that meal's status reverts to planned automatically."
    )]
    pub async fn diet_retract_meal_log(
        &self,
        Parameters(p): Parameters<DietRetractMealLogParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::delete_meal_log_inner(&self.db, &p.log_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_retract_meal_log", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    // ── 라이브러리 write ─────────────────────────────────────────

    #[tool(
        name = "wr_diet_upsert_food",
        description = "Create a food (per-100g nutrition) or update one by id. Past plan/log snapshots are immutable; only future calculations change."
    )]
    pub async fn diet_upsert_food(
        &self,
        Parameters(p): Parameters<DietUpsertFoodParams>,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        self.diet_upsert_food_inner(p).await
    }

    pub(crate) async fn diet_upsert_food_inner(
        &self,
        p: DietUpsertFoodParams,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        cap_chars(Some(&p.name), NAME_MAX_CHARS, "name")?;
        let is_update = p.id.is_some();
        let food = diet_commands::upsert_food_inner(
            &self.db,
            UpsertFoodInput {
                id: p.id,
                name: p.name,
                food_type: p.food_type.into(),
                preparation: None,
                default_serving_g: p.default_serving_g,
                kcal_per_100g: p.kcal_per_100g,
                protein_g_per_100g: p.protein_g_per_100g.unwrap_or(0.0),
                fat_g_per_100g: p.fat_g_per_100g.unwrap_or(0.0),
                carb_g_per_100g: p.carb_g_per_100g.unwrap_or(0.0),
                fiber_g_per_100g: None,
                sodium_mg_per_100g: None,
                // provenance: 생성만 'agent' — 갱신은 None → COALESCE로 기존 소유 표기 보존.
                source: if is_update {
                    None
                } else {
                    Some("agent".to_string())
                },
                source_ref: None,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_upsert_food", &e))?;
        Ok(Json(DietIdResultDto { id: food.id }))
    }

    #[tool(
        name = "wr_diet_create_recipe",
        description = "Create a recipe from ingredient grams; nutrition is derived from foods at query time (plans/logs snapshot on use)."
    )]
    pub async fn diet_create_recipe(
        &self,
        Parameters(p): Parameters<DietCreateRecipeParams>,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        self.diet_create_recipe_inner(p).await
    }

    pub(crate) async fn diet_create_recipe_inner(
        &self,
        p: DietCreateRecipeParams,
    ) -> Result<Json<DietIdResultDto>, rmcp::ErrorData> {
        validate_tags(p.meal_tags.as_ref())?;
        cap_chars(Some(&p.name), NAME_MAX_CHARS, "name")?;
        cap_chars(p.notes.as_deref(), INSTRUCTIONS_MAX_CHARS, "notes")?;
        cap_chars(p.source_url.as_deref(), 500, "source_url")?;
        let input = CreateRecipeInput {
            name: p.name.clone(),
            servings: p.servings,
            cook_minutes: p.cook_minutes.map(|v| v.min(i32::MAX as u32) as i32),
            meal_tags: p.meal_tags.unwrap_or_default(),
            source_url: p.source_url,
            yield_g: p.yield_g,
            notes: p.notes,
            ingredients: validated_ingredients(&p.ingredients)?,
            steps: validated_steps(p.steps.as_deref())?,
            changed_by: Some(RecipeEditor::Agent),
        };
        let recipe = diet_commands::create_recipe_inner(&self.db, input)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_create_recipe", &e))?;
        Ok(Json(DietIdResultDto { id: recipe.id }))
    }

    #[tool(
        name = "wr_diet_update_recipe",
        description = "Replace a recipe wholesale (ingredients and steps replace-all). Prefer wr_diet_patch_recipe / wr_diet_set_recipe_step / wr_diet_set_recipe_ingredient for iterative taste tuning — replace-all overwrites concurrent edits. Pass expected_rev_no from wr_diet_get_recipe. Past plan/log snapshots stay immutable."
    )]
    pub async fn diet_update_recipe(
        &self,
        Parameters(p): Parameters<DietUpdateRecipeParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_update_recipe_inner(p).await
    }

    pub(crate) async fn diet_update_recipe_inner(
        &self,
        p: DietUpdateRecipeParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        validate_tags(p.meal_tags.as_ref())?;
        cap_chars(Some(&p.name), NAME_MAX_CHARS, "name")?;
        cap_chars(p.notes.as_deref(), INSTRUCTIONS_MAX_CHARS, "notes")?;
        cap_chars(p.source_url.as_deref(), 500, "source_url")?;
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        let input = UpdateRecipeInput {
            id: p.id,
            expected_rev_no: p.expected_rev_no,
            name: p.name.clone(),
            servings: p.servings,
            cook_minutes: p.cook_minutes.map(|v| v.min(i32::MAX as u32) as i32),
            meal_tags: p.meal_tags.unwrap_or_default(),
            source_url: p.source_url,
            yield_g: p.yield_g,
            notes: p.notes,
            ingredients: validated_ingredients(&p.ingredients)?,
            steps: validated_steps(p.steps.as_deref())?,
            change_summary: p.change_summary,
            changed_by: Some(RecipeEditor::Agent),
        };
        diet_commands::update_recipe_inner(&self.db, input)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_update_recipe", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    // ── 레시피 반복 튜닝(patch 계열) ─────────────────────────────
    // 전체 교체 대신 재료 1개·단계 1개 단위로 고친다. 모든 mutate는 리비전을 append하므로
    // 되돌릴 수 있고 무엇이 왜 바뀌었는지 남는다.

    #[tool(
        name = "wr_diet_get_recipe",
        description = "Full recipe for editing: ingredient row ids, 1-based step numbers, current revNo (pass it back as expected_rev_no), and aggregated taste feedback with tuning hints. Read-only."
    )]
    pub async fn diet_get_recipe(
        &self,
        Parameters(p): Parameters<DietRecipeIdParams>,
    ) -> Result<Json<DietRecipeDetailDto>, rmcp::ErrorData> {
        self.diet_get_recipe_inner(p).await
    }

    pub(crate) async fn diet_get_recipe_inner(
        &self,
        p: DietRecipeIdParams,
    ) -> Result<Json<DietRecipeDetailDto>, rmcp::ErrorData> {
        let recipe = diet_commands::fetch_recipe(&self.db, &p.recipe_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_get_recipe", &e))?;
        let taste = diet_commands::recipe_taste_summary_inner(&self.db, &p.recipe_id, None)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_get_recipe", &e))?;
        Ok(Json(DietRecipeDetailDto {
            id: recipe.id,
            rev_no: recipe.rev_no,
            name: truncate_preview(&recipe.name, NAME_MAX_CHARS),
            servings: recipe.servings,
            cook_minutes: recipe.cook_minutes,
            meal_tags: recipe.meal_tags,
            source_url: recipe.source_url,
            yield_g: recipe.yield_g,
            notes: recipe
                .notes
                .map(|n| truncate_preview(&n, INSTRUCTIONS_MAX_CHARS)),
            archived: recipe.archived,
            ingredients: recipe
                .ingredients
                .iter()
                .map(|i| DietRecipeIngredientDto {
                    id: i.id.clone(),
                    food_id: i.food_id.clone(),
                    food_name: truncate_preview(&i.food_name, NAME_MAX_CHARS),
                    qty_g: i.qty_g,
                    display: unit_display(i.qty, i.unit.as_deref()),
                    to_taste: i.to_taste,
                    optional: i.optional,
                    note: i.note.clone(),
                })
                .collect(),
            steps: recipe
                .steps
                .iter()
                .map(|s| DietRecipeStepDto {
                    step_no: s.step_no,
                    body: truncate_preview(&s.body, INSTRUCTIONS_MAX_CHARS),
                    duration_minutes: s.duration_minutes,
                    note: s.note.clone(),
                })
                .collect(),
            total_kcal: recipe.total.kcal,
            per_serving_kcal: recipe.per_serving.kcal,
            per_serving_protein_g: recipe.per_serving.protein_g,
            feedback_count: taste.sample_count,
            avg_rating: taste.avg_rating,
            taste_hints: taste.hints.iter().map(taste_hint_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_diet_patch_recipe",
        description = "Change only the recipe metadata fields you pass (name, servings, cookMinutes, mealTags, sourceUrl, yieldG, notes). Ingredients and steps are untouched. Pass expected_rev_no from wr_diet_get_recipe; use `clear` to null a nullable field."
    )]
    pub async fn diet_patch_recipe(
        &self,
        Parameters(p): Parameters<DietPatchRecipeParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_patch_recipe_inner(p).await
    }

    pub(crate) async fn diet_patch_recipe_inner(
        &self,
        p: DietPatchRecipeParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        validate_tags(p.meal_tags.as_ref())?;
        cap_chars(p.name.as_deref(), NAME_MAX_CHARS, "name")?;
        cap_chars(p.notes.as_deref(), INSTRUCTIONS_MAX_CHARS, "notes")?;
        cap_chars(p.source_url.as_deref(), 500, "source_url")?;
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        diet_commands::patch_recipe_inner(
            &self.db,
            PatchRecipeInput {
                id: p.id,
                expected_rev_no: p.expected_rev_no,
                name: p.name,
                servings: p.servings,
                cook_minutes: p.cook_minutes.map(|v| v.min(i32::MAX as u32) as i32),
                meal_tags: p.meal_tags,
                source_url: p.source_url,
                yield_g: p.yield_g,
                notes: p.notes,
                clear: p
                    .clear
                    .unwrap_or_default()
                    .into_iter()
                    .map(RecipeClearableField::from)
                    .collect(),
                change_summary: p.change_summary,
                changed_by: Some(RecipeEditor::Agent),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_patch_recipe", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_set_recipe_ingredient",
        description = "Add or replace ONE ingredient. Give `id` (from wr_diet_get_recipe) to replace that row, omit it to add. Quantity is grams via qty_g, or qty+unit which is converted deterministically (register unknown units with wr_diet_upsert_unit_conversion first)."
    )]
    pub async fn diet_set_recipe_ingredient(
        &self,
        Parameters(p): Parameters<DietSetRecipeIngredientParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_set_recipe_ingredient_inner(p).await
    }

    pub(crate) async fn diet_set_recipe_ingredient_inner(
        &self,
        p: DietSetRecipeIngredientParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        let ingredient = validated_ingredient(&p.ingredient)?;
        diet_commands::set_recipe_ingredient_inner(
            &self.db,
            SetRecipeIngredientInput {
                recipe_id: p.recipe_id,
                expected_rev_no: p.expected_rev_no,
                id: p.id,
                ingredient,
                after_index: p.after_index,
                change_summary: p.change_summary,
                changed_by: Some(RecipeEditor::Agent),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_set_recipe_ingredient", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_remove_recipe_ingredient",
        description = "Remove ONE ingredient by its row id (from wr_diet_get_recipe). Recorded as a new revision, so it can be reverted."
    )]
    pub async fn diet_remove_recipe_ingredient(
        &self,
        Parameters(p): Parameters<DietRemoveRecipeIngredientParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_remove_recipe_ingredient_inner(p).await
    }

    pub(crate) async fn diet_remove_recipe_ingredient_inner(
        &self,
        p: DietRemoveRecipeIngredientParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        diet_commands::remove_recipe_ingredient_inner(
            &self.db,
            &p.recipe_id,
            &p.ingredient_id,
            p.expected_rev_no,
            p.change_summary,
            Some(RecipeEditor::Agent),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_remove_recipe_ingredient", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_set_recipe_step",
        description = "Rewrite ONE cooking step (pass step_no to replace it) or insert a new one (omit step_no, use after_step_no for position). Step numbers are the 1-based numbers from wr_diet_get_recipe."
    )]
    pub async fn diet_set_recipe_step(
        &self,
        Parameters(p): Parameters<DietSetRecipeStepParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_set_recipe_step_inner(p).await
    }

    pub(crate) async fn diet_set_recipe_step_inner(
        &self,
        p: DietSetRecipeStepParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        let step = validated_step(&p.step)?;
        diet_commands::set_recipe_step_inner(
            &self.db,
            SetRecipeStepInput {
                recipe_id: p.recipe_id,
                expected_rev_no: p.expected_rev_no,
                step_no: p.step_no,
                after_step_no: p.after_step_no,
                step,
                change_summary: p.change_summary,
                changed_by: Some(RecipeEditor::Agent),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_set_recipe_step", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_remove_recipe_step",
        description = "Remove ONE cooking step by its 1-based number. Remaining steps renumber automatically."
    )]
    pub async fn diet_remove_recipe_step(
        &self,
        Parameters(p): Parameters<DietRemoveRecipeStepParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_remove_recipe_step_inner(p).await
    }

    pub(crate) async fn diet_remove_recipe_step_inner(
        &self,
        p: DietRemoveRecipeStepParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        diet_commands::remove_recipe_step_inner(
            &self.db,
            &p.recipe_id,
            p.step_no,
            p.expected_rev_no,
            p.change_summary,
            Some(RecipeEditor::Agent),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_remove_recipe_step", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_reorder_recipe_steps",
        description = "Reorder cooking steps. `order` must be a complete permutation of the current 1-based step numbers — a partial list is rejected rather than silently dropping steps."
    )]
    pub async fn diet_reorder_recipe_steps(
        &self,
        Parameters(p): Parameters<DietReorderRecipeStepsParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_reorder_recipe_steps_inner(p).await
    }

    pub(crate) async fn diet_reorder_recipe_steps_inner(
        &self,
        p: DietReorderRecipeStepsParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        if p.order.len() > MAX_STEPS {
            return Err(rmcp::ErrorData::invalid_params(
                format!("order must be <= {MAX_STEPS}"),
                None,
            ));
        }
        cap_chars(
            p.change_summary.as_deref(),
            NOTE_MAX_CHARS,
            "change_summary",
        )?;
        diet_commands::reorder_recipe_steps_inner(
            &self.db,
            &p.recipe_id,
            &p.order,
            p.expected_rev_no,
            p.change_summary,
            Some(RecipeEditor::Agent),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_reorder_recipe_steps", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_recipe_revisions",
        description = "Revision history of a recipe (newest first) with who changed it and why. Read-only."
    )]
    pub async fn diet_recipe_revisions(
        &self,
        Parameters(p): Parameters<DietRecipeIdParams>,
    ) -> Result<Json<DietRecipeRevisionListDto>, rmcp::ErrorData> {
        self.diet_recipe_revisions_inner(p).await
    }

    pub(crate) async fn diet_recipe_revisions_inner(
        &self,
        p: DietRecipeIdParams,
    ) -> Result<Json<DietRecipeRevisionListDto>, rmcp::ErrorData> {
        let recipe = diet_commands::fetch_recipe(&self.db, &p.recipe_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_recipe_revisions", &e))?;
        let revisions = diet_commands::list_recipe_revisions_inner(&self.db, &p.recipe_id)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_recipe_revisions", &e))?;
        Ok(Json(DietRecipeRevisionListDto {
            recipe_id: p.recipe_id,
            current_rev_no: recipe.rev_no,
            revisions: revisions.iter().map(revision_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_diet_recipe_revision_diff",
        description = "What changed in one revision compared with the previous one (metadata, ingredients, steps). Read-only."
    )]
    pub async fn diet_recipe_revision_diff(
        &self,
        Parameters(p): Parameters<DietRecipeRevisionParams>,
    ) -> Result<Json<DietRecipeRevisionDetailDto>, rmcp::ErrorData> {
        self.diet_recipe_revision_diff_inner(p).await
    }

    pub(crate) async fn diet_recipe_revision_diff_inner(
        &self,
        p: DietRecipeRevisionParams,
    ) -> Result<Json<DietRecipeRevisionDetailDto>, rmcp::ErrorData> {
        let detail = diet_commands::get_recipe_revision_inner(&self.db, &p.recipe_id, p.rev_no)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_recipe_revision_diff", &e))?;
        Ok(Json(DietRecipeRevisionDetailDto {
            revision: revision_dto(&detail.revision),
            diff_from_previous: detail
                .diff_from_previous
                .iter()
                .map(|d| DietRecipeDiffEntryDto {
                    kind: enum_token(&d.kind),
                    label: truncate_preview(&d.label, NAME_MAX_CHARS),
                    before: d
                        .before
                        .as_deref()
                        .map(|v| truncate_preview(v, NOTE_MAX_CHARS)),
                    after: d
                        .after
                        .as_deref()
                        .map(|v| truncate_preview(v, NOTE_MAX_CHARS)),
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_revert_recipe",
        description = "Restore a past revision. History is never rewritten — the old state is re-applied as a NEW revision, so the revert itself can be reverted."
    )]
    pub async fn diet_revert_recipe(
        &self,
        Parameters(p): Parameters<DietRevertRecipeParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        self.diet_revert_recipe_inner(p).await
    }

    pub(crate) async fn diet_revert_recipe_inner(
        &self,
        p: DietRevertRecipeParams,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::revert_recipe_inner(
            &self.db,
            &p.recipe_id,
            p.rev_no,
            p.expected_rev_no,
            Some(RecipeEditor::Agent),
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_revert_recipe", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_add_recipe_feedback",
        description = "Record how a cooked recipe actually tasted: rating 1-5 and per-axis deltas from -2 to +2 where POSITIVE means 'too much of it' (salt_delta=+2 means it was too salty) and negative means 'not enough'. Returns the aggregated tuning hints. This records a fact; it does not change the recipe."
    )]
    pub async fn diet_add_recipe_feedback(
        &self,
        Parameters(p): Parameters<DietRecipeFeedbackParams>,
    ) -> Result<Json<DietTasteSummaryDto>, rmcp::ErrorData> {
        self.diet_add_recipe_feedback_inner(p).await
    }

    pub(crate) async fn diet_add_recipe_feedback_inner(
        &self,
        p: DietRecipeFeedbackParams,
    ) -> Result<Json<DietTasteSummaryDto>, rmcp::ErrorData> {
        cap_chars(p.comment.as_deref(), NOTE_MAX_CHARS, "comment")?;
        let recipe_id = p.recipe_id.clone();
        let summary = diet_commands::add_recipe_feedback_inner(
            &self.db,
            AddRecipeFeedbackInput {
                recipe_id: p.recipe_id,
                rev_no: p.rev_no,
                meal_log_id: p.meal_log_id,
                rating: p.rating,
                salt_delta: p.salt_delta,
                spice_delta: p.spice_delta,
                sweet_delta: p.sweet_delta,
                sour_delta: p.sour_delta,
                richness_delta: p.richness_delta,
                doneness_delta: p.doneness_delta,
                comment: p.comment,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_add_recipe_feedback", &e))?;
        Ok(Json(DietTasteSummaryDto {
            recipe_id,
            sample_count: summary.sample_count,
            avg_rating: summary.avg_rating,
            taste_hints: summary.hints.iter().map(taste_hint_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_diet_recipe_scaled",
        description = "Scale a recipe to a target number of servings and report per-ingredient grams, what is in stock, and the shortfall. Read-only."
    )]
    pub async fn diet_recipe_scaled(
        &self,
        Parameters(p): Parameters<DietScaleRecipeParams>,
    ) -> Result<Json<DietScaledRecipeDto>, rmcp::ErrorData> {
        self.diet_recipe_scaled_inner(p).await
    }

    pub(crate) async fn diet_recipe_scaled_inner(
        &self,
        p: DietScaleRecipeParams,
    ) -> Result<Json<DietScaledRecipeDto>, rmcp::ErrorData> {
        let scaled = diet_commands::scaled_recipe_inner(&self.db, &p.recipe_id, p.target_servings)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_recipe_scaled", &e))?;
        Ok(Json(DietScaledRecipeDto {
            recipe_id: scaled.recipe_id,
            name: truncate_preview(&scaled.name, NAME_MAX_CHARS),
            base_servings: scaled.base_servings,
            target_servings: scaled.target_servings,
            factor: scaled.factor,
            ingredients: scaled
                .ingredients
                .iter()
                .map(|i| DietScaledIngredientDto {
                    food_id: i.food_id.clone(),
                    food_name: truncate_preview(&i.food_name, NAME_MAX_CHARS),
                    qty_g: i.qty_g,
                    display: i.display.clone(),
                    available_g: i.available_g,
                    shortfall_g: i.shortfall_g,
                    optional: i.optional,
                })
                .collect(),
            total_kcal: scaled.total.kcal,
            per_serving_kcal: scaled.per_serving.kcal,
            coverage_pct: scaled.coverage_pct,
            missing_count: scaled.missing_count,
        }))
    }

    #[tool(
        name = "wr_diet_recipe_suggestions",
        description = "What to cook now, ranked deterministically (not by guesswork): stock coverage, how much expiring stock it burns down, and fit to the active calorie goal. Read-only."
    )]
    pub async fn diet_recipe_suggestions(
        &self,
        Parameters(p): Parameters<DietSuggestionParams>,
    ) -> Result<Json<DietSuggestionListDto>, rmcp::ErrorData> {
        self.diet_recipe_suggestions_inner(p).await
    }

    pub(crate) async fn diet_recipe_suggestions_inner(
        &self,
        p: DietSuggestionParams,
    ) -> Result<Json<DietSuggestionListDto>, rmcp::ErrorData> {
        let today = parse_iso_date(&p.today)?.to_string();
        let suggestions = diet_commands::recipe_suggestions_inner(&self.db, &today, p.limit)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_recipe_suggestions", &e))?;
        Ok(Json(DietSuggestionListDto {
            suggestions: suggestions
                .into_iter()
                .map(|s| DietSuggestionDto {
                    recipe_id: s.recipe_id,
                    name: truncate_preview(&s.name, NAME_MAX_CHARS),
                    servings: s.servings,
                    per_serving_kcal: s.per_serving.kcal,
                    coverage_pct: s.coverage_pct,
                    expiry_pressure_pct: s.expiry_pressure_pct,
                    earliest_expiry: s.earliest_expiry,
                    missing: s
                        .missing
                        .iter()
                        .map(|m| truncate_preview(m, NAME_MAX_CHARS))
                        .collect(),
                    score: s.score,
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_diet_cook_recipe",
        description = "Record that a recipe was actually cooked and eaten: deducts every ingredient from pantry stock (earliest expiry first), writes the meal log with a nutrition snapshot, links the stock events to that log, and marks a linked planned meal eaten — all in ONE transaction. If any required ingredient is short, NOTHING is consumed or logged. Pass consume_pantry=false to log without touching stock. Ingredients marked to_taste or optional never block cooking."
    )]
    pub async fn diet_cook_recipe(
        &self,
        Parameters(p): Parameters<DietCookRecipeParams>,
    ) -> Result<Json<DietCookResultDto>, rmcp::ErrorData> {
        self.diet_cook_recipe_inner(p).await
    }

    pub(crate) async fn diet_cook_recipe_inner(
        &self,
        p: DietCookRecipeParams,
    ) -> Result<Json<DietCookResultDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let date = parse_iso_date(&p.date)?.to_string();
        let result = diet_commands::cook_recipe_inner(
            &self.db,
            CookRecipeInput {
                recipe_id: p.recipe_id,
                servings: p.servings,
                date,
                at: p.at,
                planned_meal_id: p.planned_meal_id,
                consume_pantry: p.consume_pantry,
                satisfaction: p.satisfaction,
                fullness: p.fullness,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_cook_recipe", &e))?;
        Ok(Json(DietCookResultDto {
            meal_log_id: result.log.id,
            kcal: result.log.kcal,
            protein_g: result.log.protein_g,
            consumed_g: result.consumed_g,
            lots_touched: result.lots_touched,
            pantry_consumed: result.pantry_consumed,
        }))
    }

    #[tool(
        name = "wr_diet_list_unit_conversions",
        description = "Registered gram conversions for recipe units. Food-specific rows win over the global fallback. Read-only."
    )]
    pub async fn diet_list_unit_conversions(
        &self,
    ) -> Result<Json<DietUnitConversionListDto>, rmcp::ErrorData> {
        let conversions = diet_commands::list_unit_conversions_inner(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_diet_list_unit_conversions", &e))?;
        Ok(Json(DietUnitConversionListDto {
            conversions: conversions.into_iter().map(unit_conversion_dto).collect(),
        }))
    }

    #[tool(
        name = "wr_diet_upsert_unit_conversion",
        description = "Register or correct how many grams one unit is, either globally or for a specific food (food-specific wins). Needed before qty+unit ingredients can be converted."
    )]
    pub async fn diet_upsert_unit_conversion(
        &self,
        Parameters(p): Parameters<DietUpsertUnitConversionParams>,
    ) -> Result<Json<DietUnitConversionListDto>, rmcp::ErrorData> {
        self.diet_upsert_unit_conversion_inner(p).await
    }

    pub(crate) async fn diet_upsert_unit_conversion_inner(
        &self,
        p: DietUpsertUnitConversionParams,
    ) -> Result<Json<DietUnitConversionListDto>, rmcp::ErrorData> {
        cap_chars(Some(&p.unit), 40, "unit")?;
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let conversions = diet_commands::upsert_unit_conversion_inner(
            &self.db,
            UpsertUnitConversionInput {
                unit: p.unit,
                food_id: p.food_id,
                grams_per_unit: p.grams_per_unit,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_upsert_unit_conversion", &e))?;
        Ok(Json(DietUnitConversionListDto {
            conversions: conversions.into_iter().map(unit_conversion_dto).collect(),
        }))
    }

    // ── 재고/주문 write ──────────────────────────────────────────

    #[tool(
        name = "wr_diet_add_pantry_lot",
        description = "Stock in a pantry lot directly (grams, storage location, optional expiry). Every change lands in the append-only pantry event trail."
    )]
    pub async fn diet_add_pantry_lot(
        &self,
        Parameters(p): Parameters<DietAddPantryLotParams>,
    ) -> Result<Json<DietLotResultDto>, rmcp::ErrorData> {
        self.diet_add_pantry_lot_inner(p).await
    }

    pub(crate) async fn diet_add_pantry_lot_inner(
        &self,
        p: DietAddPantryLotParams,
    ) -> Result<Json<DietLotResultDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let lot = diet_commands::add_pantry_lot_inner(
            &self.db,
            AddPantryLotInput {
                food_id: p.food_id,
                location: p.location.into(),
                acquired_on: p.acquired_on,
                expires_on: p.expires_on,
                initial_qty_g: p.qty_g,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_add_pantry_lot", &e))?;
        Ok(Json(DietLotResultDto {
            lot_id: lot.id,
            remaining_g: lot.remaining_qty_g,
        }))
    }

    #[tool(
        name = "wr_diet_consume_pantry",
        description = "Deduct grams of a food from pantry stock, earliest expiry first (FEFO). If stock is short it deducts what exists and reports the shortfall."
    )]
    pub async fn diet_consume_pantry(
        &self,
        Parameters(p): Parameters<DietConsumePantryParams>,
    ) -> Result<Json<DietConsumeResultDto>, rmcp::ErrorData> {
        self.diet_consume_pantry_inner(p).await
    }

    pub(crate) async fn diet_consume_pantry_inner(
        &self,
        p: DietConsumePantryParams,
    ) -> Result<Json<DietConsumeResultDto>, rmcp::ErrorData> {
        cap_chars(p.reason.as_deref(), NOTE_MAX_CHARS, "reason")?;
        let result =
            diet_commands::consume_pantry_inner(&self.db, &p.food_id, p.qty_g, None, p.reason)
                .await
                .map_err(|e| mcp_tool_error("wr_diet_consume_pantry", &e))?;
        Ok(Json(DietConsumeResultDto {
            shortfall_g: result.shortfall_g,
            lots_touched: result.taken.len().min(u32::MAX as usize) as u32,
        }))
    }

    #[tool(
        name = "wr_diet_adjust_pantry_lot",
        description = "Set a lot's remaining grams to a measured value (stocktake); the delta is audited as an adjusted event."
    )]
    pub async fn diet_adjust_pantry_lot(
        &self,
        Parameters(p): Parameters<DietAdjustLotParams>,
    ) -> Result<Json<DietLotResultDto>, rmcp::ErrorData> {
        cap_chars(p.reason.as_deref(), NOTE_MAX_CHARS, "reason")?;
        let lot = diet_commands::adjust_pantry_lot_inner(
            &self.db,
            &p.lot_id,
            p.new_remaining_g,
            p.reason,
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_adjust_pantry_lot", &e))?;
        Ok(Json(DietLotResultDto {
            lot_id: lot.id,
            remaining_g: lot.remaining_qty_g,
        }))
    }

    #[tool(
        name = "wr_diet_waste_pantry_lot",
        description = "Record waste or expiry disposal for a lot (grams, or the whole remainder when omitted)."
    )]
    pub async fn diet_waste_pantry_lot(
        &self,
        Parameters(p): Parameters<DietWasteLotParams>,
    ) -> Result<Json<DietLotResultDto>, rmcp::ErrorData> {
        cap_chars(p.reason.as_deref(), NOTE_MAX_CHARS, "reason")?;
        let lot = diet_commands::waste_pantry_lot_inner(
            &self.db,
            &p.lot_id,
            p.qty_g,
            p.kind.into(),
            p.reason,
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_waste_pantry_lot", &e))?;
        Ok(Json(DietLotResultDto {
            lot_id: lot.id,
            remaining_g: lot.remaining_qty_g,
        }))
    }

    #[tool(
        name = "wr_diet_record_order",
        description = "Record a grocery order into the local ledger (merchant, lines, amounts). Record-keeping only — this tool cannot place, pay for, or cancel real orders."
    )]
    pub async fn diet_record_order(
        &self,
        Parameters(p): Parameters<DietRecordOrderParams>,
    ) -> Result<Json<DietOrderDto>, rmcp::ErrorData> {
        self.diet_record_order_inner(p).await
    }

    pub(crate) async fn diet_record_order_inner(
        &self,
        p: DietRecordOrderParams,
    ) -> Result<Json<DietOrderDto>, rmcp::ErrorData> {
        cap_chars(Some(&p.merchant), NAME_MAX_CHARS, "merchant")?;
        cap_chars(
            p.external_order_no.as_deref(),
            NAME_MAX_CHARS,
            "external_order_no",
        )?;
        if p.lines.is_empty() || p.lines.len() > MAX_ORDER_LINES {
            return Err(rmcp::ErrorData::invalid_params(
                format!("lines must be 1..={MAX_ORDER_LINES}"),
                None,
            ));
        }
        for line in &p.lines {
            cap_chars(Some(&line.product_name), NAME_MAX_CHARS, "product_name")?;
        }
        let order = diet_commands::record_grocery_order_inner(
            &self.db,
            RecordGroceryOrderInput {
                merchant: p.merchant,
                ordered_at: p.ordered_at,
                external_order_no: p.external_order_no,
                total_krw: p.total_krw,
                shipping_krw: p.shipping_krw,
                note: None,
                lines: p
                    .lines
                    .into_iter()
                    .map(|l| GroceryOrderLineInput {
                        product_name: l.product_name,
                        food_id: l.food_id,
                        quantity: 1.0,
                        total_g: l.total_g,
                        unit_price_krw: None,
                        line_total_krw: l.line_total_krw,
                        note: None,
                    })
                    .collect(),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_record_order", &e))?;
        Ok(Json(order_dto(order)))
    }

    #[tool(
        name = "wr_diet_set_order_status",
        description = "Mark a recorded order as ordered/delivered/cancelled in the local ledger."
    )]
    pub async fn diet_set_order_status(
        &self,
        Parameters(p): Parameters<DietOrderStatusParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::set_grocery_order_status_inner(&self.db, &p.order_id, p.status.into())
            .await
            .map_err(|e| mcp_tool_error("wr_diet_set_order_status", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_link_order_line",
        description = "Link an order line to a food (required before receiving it into pantry)."
    )]
    pub async fn diet_link_order_line(
        &self,
        Parameters(p): Parameters<DietLinkOrderLineParams>,
    ) -> Result<Json<DietOkResultDto>, rmcp::ErrorData> {
        diet_commands::set_order_line_food_inner(&self.db, &p.line_id, Some(p.food_id))
            .await
            .map_err(|e| mcp_tool_error("wr_diet_link_order_line", &e))?;
        Ok(Json(DietOkResultDto { ok: true }))
    }

    #[tool(
        name = "wr_diet_receive_order_line",
        description = "Receive an order line into pantry stock exactly once (creates a lot atomically; a second receive is rejected)."
    )]
    pub async fn diet_receive_order_line(
        &self,
        Parameters(p): Parameters<DietReceiveOrderLineParams>,
    ) -> Result<Json<DietLotResultDto>, rmcp::ErrorData> {
        self.diet_receive_order_line_inner(p).await
    }

    pub(crate) async fn diet_receive_order_line_inner(
        &self,
        p: DietReceiveOrderLineParams,
    ) -> Result<Json<DietLotResultDto>, rmcp::ErrorData> {
        let lot = diet_commands::receive_order_line_inner(
            &self.db,
            ReceiveOrderLineInput {
                line_id: p.line_id,
                location: p.location.into(),
                acquired_on: p.acquired_on,
                expires_on: p.expires_on,
                total_g_override: p.total_g_override,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_diet_receive_order_line", &e))?;
        Ok(Json(DietLotResultDto {
            lot_id: lot.id,
            remaining_g: lot.remaining_qty_g,
        }))
    }
}

/// 레시피 태그 개수 상한(§2 — 컬렉션 폭주 방지).
#[allow(clippy::result_large_err)]
fn validate_tags(tags: Option<&Vec<String>>) -> Result<(), rmcp::ErrorData> {
    if tags.is_some_and(|t| t.len() > MAX_TAGS) {
        return Err(rmcp::ErrorData::invalid_params(
            format!("meal_tags must be <= {MAX_TAGS}"),
            None,
        ));
    }
    Ok(())
}

/// 레시피 재료 검증 공용(개수 상한 + 이름/조리법 길이 상한).
#[allow(clippy::result_large_err)]
fn validated_ingredient(i: &DietIngredientParam) -> Result<RecipeIngredientInput, rmcp::ErrorData> {
    cap_chars(i.note.as_deref(), NOTE_MAX_CHARS, "ingredient note")?;
    cap_chars(i.unit.as_deref(), 40, "unit")?;
    Ok(RecipeIngredientInput {
        food_id: i.food_id.clone(),
        qty_g: i.qty_g,
        qty: i.qty,
        unit: i.unit.clone(),
        to_taste: i.to_taste.unwrap_or(false),
        optional: i.optional.unwrap_or(false),
        note: i.note.clone(),
    })
}

fn validated_ingredients(
    ingredients: &[DietIngredientParam],
) -> Result<Vec<RecipeIngredientInput>, rmcp::ErrorData> {
    if ingredients.len() > MAX_INGREDIENTS {
        return Err(rmcp::ErrorData::invalid_params(
            format!("ingredients must be <= {MAX_INGREDIENTS}"),
            None,
        ));
    }
    ingredients.iter().map(validated_ingredient).collect()
}

fn validated_step(s: &DietStepParam) -> Result<RecipeStepInput, rmcp::ErrorData> {
    cap_chars(Some(&s.body), INSTRUCTIONS_MAX_CHARS, "step body")?;
    cap_chars(s.note.as_deref(), NOTE_MAX_CHARS, "step note")?;
    Ok(RecipeStepInput {
        body: s.body.clone(),
        duration_minutes: s.duration_minutes.map(|v| v.min(i32::MAX as u32) as i32),
        note: s.note.clone(),
    })
}

fn validated_steps(
    steps: Option<&[DietStepParam]>,
) -> Result<Vec<RecipeStepInput>, rmcp::ErrorData> {
    let Some(steps) = steps else {
        return Ok(Vec::new());
    };
    if steps.len() > MAX_STEPS {
        return Err(rmcp::ErrorData::invalid_params(
            format!("steps must be <= {MAX_STEPS}"),
            None,
        ));
    }
    steps.iter().map(validated_step).collect()
}

fn unit_display(qty: Option<f64>, unit: Option<&str>) -> Option<String> {
    let (qty, unit) = (qty?, unit?);
    let rendered = if (qty.fract()).abs() < 1e-9 {
        format!("{}", qty.round() as i64)
    } else {
        format!("{qty:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    };
    Some(format!("{rendered} {unit}"))
}

/// serde의 snake_case 표현을 그대로 문자열 토큰으로 — DTO가 enum 이름을 손으로 베끼지 않게 한다.
fn enum_token<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn taste_hint_dto(h: &crate::models::TasteHint) -> DietTasteHintDto {
    DietTasteHintDto {
        axis: enum_token(&h.axis),
        direction: enum_token(&h.direction),
        magnitude: h.magnitude,
        samples: h.samples,
    }
}

fn revision_dto(r: &crate::models::RecipeRevision) -> DietRecipeRevisionDto {
    DietRecipeRevisionDto {
        rev_no: r.rev_no,
        change_summary: r
            .change_summary
            .as_deref()
            .map(|v| truncate_preview(v, NOTE_MAX_CHARS)),
        changed_by: enum_token(&r.changed_by),
        created_at: r.created_at.clone(),
    }
}

fn unit_conversion_dto(c: crate::models::UnitConversion) -> DietUnitConversionDto {
    DietUnitConversionDto {
        unit: c.unit,
        food_id: c.food_id,
        food_name: c
            .food_name
            .as_deref()
            .map(|v| truncate_preview(v, NAME_MAX_CHARS)),
        grams_per_unit: c.grams_per_unit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;
    use crate::mcp::tools::diet::DietDateParams;
    use crate::mcp::tools::schema_test_support::{expect, prop_names, required_fields};
    use crate::mcp::WrServer;

    async fn seed_food(server: &WrServer, name: &str, kcal: f64, protein: f64) -> String {
        server
            .diet_upsert_food_inner(DietUpsertFoodParams {
                id: None,
                name: name.into(),
                food_type: FoodTypeParam::Ingredient,
                kcal_per_100g: kcal,
                protein_g_per_100g: Some(protein),
                fat_g_per_100g: None,
                carb_g_per_100g: None,
                default_serving_g: None,
            })
            .await
            .expect("seed food")
            .0
            .id
    }

    /// 에이전트 풀사이클: 목표 → 계획 생성/활성화 → 식사+항목 → 상세 조회 → 기록 철회.
    #[tokio::test]
    async fn agent_can_drive_plan_lifecycle_end_to_end() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };

        server
            .diet_set_goal_inner(DietSetGoalParams {
                effective_date: "2026-07-01".into(),
                calorie_target: 2200.0,
                calorie_tolerance_pct: Some(7.0),
                protein_min_g: Some(140.0),
                note: None,
            })
            .await
            .expect("goal");

        let chicken = seed_food(&server, "닭다리살", 120.0, 22.0).await;
        let plan_id = server
            .diet_create_meal_plan_inner(DietCreatePlanParams {
                start_date: "2026-07-20".into(),
                end_date: "2026-07-26".into(),
                note: Some("Hermes 주간 계획".into()),
            })
            .await
            .expect("plan")
            .0
            .id;
        server
            .diet_set_meal_plan_status(Parameters(DietPlanStatusParams {
                plan_id: plan_id.clone(),
                status: MealPlanStatusParam::Active,
            }))
            .await
            .expect("activate");

        let meal_id = server
            .diet_add_meal_inner(DietAddMealParams {
                plan_id: plan_id.clone(),
                date: "2026-07-20".into(),
                meal_type: MealTypeParam::Lunch,
                scheduled_time: Some("12:30".into()),
                note: None,
            })
            .await
            .expect("meal")
            .0
            .id;
        server
            .diet_add_meal_item_inner(DietAddMealItemParams {
                meal_id: meal_id.clone(),
                recipe_id: None,
                food_id: Some(chicken.clone()),
                servings: None,
                qty_g: Some(200.0),
                note: None,
            })
            .await
            .expect("item");

        let detail = server
            .diet_get_meal_plan_inner(DietPlanIdParams {
                plan_id: plan_id.clone(),
            })
            .await
            .expect("detail")
            .0;
        assert_eq!(detail.plan.status, "active");
        assert_eq!(detail.plan.calorie_target, Some(2200.0), "활성 목표 스냅샷");
        assert_eq!(detail.meals.len(), 1);
        assert!(
            (detail.meals[0].items[0].kcal - 240.0).abs() < 1e-9,
            "커널 스냅샷"
        );

        // 잘못된 창 밖 날짜/시각 형식은 거부.
        assert!(server
            .diet_add_meal_inner(DietAddMealParams {
                plan_id: plan_id.clone(),
                date: "2026-08-01".into(),
                meal_type: MealTypeParam::Dinner,
                scheduled_time: None,
                note: None,
            })
            .await
            .is_err());
        assert!(server
            .diet_add_meal_inner(DietAddMealParams {
                plan_id,
                date: "2026-07-21".into(),
                meal_type: MealTypeParam::Dinner,
                scheduled_time: Some("25:99".into()),
                note: None,
            })
            .await
            .is_err());

        // 기록 → 조회 → 철회 정정 루프.
        server
            .diet_record_meal_inner(crate::mcp::tools::diet::DietRecordMealParams {
                date: Some("2026-07-20".into()),
                planned_meal_id: Some(meal_id),
                ratio: None,
                food_id: None,
                qty_g: None,
                kcal: None,
                protein_g: None,
                fat_g: None,
                carb_g: None,
                description: None,
                satisfaction: Some(4),
                fullness: None,
                note: None,
            })
            .await
            .expect("record");
        let logs = server
            .diet_meal_logs_inner(DietDateParams {
                date: "2026-07-20".into(),
            })
            .await
            .expect("logs")
            .0;
        assert_eq!(logs.logs.len(), 1);
        server
            .diet_retract_meal_log(Parameters(DietRetractMealLogParams {
                log_id: logs.logs[0].id.clone(),
            }))
            .await
            .expect("retract");
        let after = server
            .diet_meal_logs_inner(DietDateParams {
                date: "2026-07-20".into(),
            })
            .await
            .expect("logs after")
            .0;
        assert!(after.logs.is_empty(), "철회 후 원장 비움");
    }

    /// 주문 연동 시나리오: 주문 기록 → 라인 food 연결 → 입고 1회 → 재입고 거부.
    #[tokio::test]
    async fn agent_can_record_order_and_receive_into_pantry_once() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let shrimp = seed_food(&server, "새우", 85.0, 20.0).await;

        let order = server
            .diet_record_order_inner(DietRecordOrderParams {
                merchant: "coupang".into(),
                ordered_at: "2026-07-18".into(),
                external_order_no: Some("240718-0001".into()),
                total_krw: Some(15900),
                shipping_krw: Some(0),
                lines: vec![DietOrderLineParam {
                    product_name: "생새우 600g".into(),
                    food_id: None,
                    total_g: Some(600.0),
                    line_total_krw: Some(15900),
                }],
            })
            .await
            .expect("order")
            .0;
        assert_eq!(order.status, "ordered");
        let line_id = order.lines[0].id.clone();

        server
            .diet_link_order_line(Parameters(DietLinkOrderLineParams {
                line_id: line_id.clone(),
                food_id: shrimp.clone(),
            }))
            .await
            .expect("link");
        let lot = server
            .diet_receive_order_line_inner(DietReceiveOrderLineParams {
                line_id: line_id.clone(),
                location: PantryLocationParam::Freezer,
                acquired_on: "2026-07-19".into(),
                expires_on: Some("2026-10-19".into()),
                total_g_override: None,
            })
            .await
            .expect("receive")
            .0;
        assert_eq!(lot.remaining_g, 600.0);

        // 중복 입고 거부(원자 게이트).
        assert!(server
            .diet_receive_order_line_inner(DietReceiveOrderLineParams {
                line_id,
                location: PantryLocationParam::Freezer,
                acquired_on: "2026-07-19".into(),
                expires_on: None,
                total_g_override: None,
            })
            .await
            .is_err());

        // FEFO 소비 + shortfall 보고.
        let consumed = server
            .diet_consume_pantry_inner(DietConsumePantryParams {
                food_id: shrimp,
                qty_g: 700.0,
                reason: Some("저녁".into()),
            })
            .await
            .expect("consume")
            .0;
        assert_eq!(consumed.shortfall_g, 100.0);
        assert_eq!(consumed.lots_touched, 1);
    }

    /// 사용자(manual) 등록 식품을 에이전트가 id 지정으로 갱신해도 provenance가 'agent'로
    /// 뒤집히지 않는다(critic MINOR — UPDATE는 COALESCE 보존, 생성만 'agent' 표기).
    #[tokio::test]
    async fn updating_a_user_food_preserves_its_provenance() {
        let db = fresh_db().await;
        let server = WrServer { db: db.clone() };
        let user_food =
            crate::commands::diet::foods::test_support::seed_food(&db, "우유", 61.0, 3.2).await;

        server
            .diet_upsert_food_inner(DietUpsertFoodParams {
                id: Some(user_food.clone()),
                name: "우유(저지방)".into(),
                food_type: FoodTypeParam::Product,
                kcal_per_100g: 42.0,
                protein_g_per_100g: Some(3.4),
                fat_g_per_100g: None,
                carb_g_per_100g: None,
                default_serving_g: None,
            })
            .await
            .expect("agent update");
        let (name, source): (String, String) =
            sqlx::query_as("SELECT name, source FROM foods WHERE id = ?1")
                .bind(&user_food)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(name, "우유(저지방)", "내용 갱신은 반영");
        assert_eq!(source, "manual", "provenance는 보존");

        let agent_food = seed_food(&server, "에이전트 등록", 100.0, 10.0).await;
        let (src,): (String,) = sqlx::query_as("SELECT source FROM foods WHERE id = ?1")
            .bind(&agent_food)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(src, "agent", "신규 생성만 agent 표기");
    }

    #[test]
    fn manage_params_schemas_are_closed() {
        for schema in [
            serde_json::to_value(schemars::schema_for!(DietSetGoalParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietCreatePlanParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietAddMealParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietAddMealItemParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietUpsertFoodParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietCreateRecipeParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietRecordOrderParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(DietReceiveOrderLineParams)).unwrap(),
        ] {
            assert_eq!(schema["additionalProperties"], serde_json::json!(false));
        }
        // 위험 필드 부재(§2) — 주문 기록은 원장 기록일 뿐 결제 표면이 아니다.
        let order = serde_json::to_value(schemars::schema_for!(DietRecordOrderParams)).unwrap();
        for forbidden in ["url", "payment", "card", "checkout", "password"] {
            assert!(
                !prop_names(&order).contains(forbidden),
                "order params must not accept `{forbidden}`"
            );
        }
        assert_eq!(
            required_fields(&order),
            expect(&["merchant", "ordered_at", "lines"])
        );
    }
}
