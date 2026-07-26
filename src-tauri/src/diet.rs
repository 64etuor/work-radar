//! Diet 순수 계산 커널 (docs/plans/2026-07-17-diet-domain.md).
//!
//! PRD 핵심 철학의 기계화: **영양 계산·제약 검증·재고 차감은 결정론** — LLM/에이전트는 이
//! 함수들의 결과를 임의로 바꿀 수 없다. DB/keychain 의존 없음(도메인 층 — ipc-conventions
//! `X.rs` 경계). 같은 입력 → 같은 출력.

use crate::models::{
    DietGoalCheck, DietMacros, Recipe, RecipeDiffEntry, RecipeDiffKind, RecipeIngredientInput,
    RecipeSnapshot, RecipeSnapshotIngredient, RecipeSnapshotStep, RecipeStepInput,
    RecipeSuggestion, TasteAxis, TasteDirection, TasteHint,
};

/// 100g당 매크로 × 중량(g) → 절대 매크로.
pub fn macros_for_qty(per_100g: &DietMacros, qty_g: f64) -> DietMacros {
    scale_macros(per_100g, qty_g / 100.0)
}

pub fn scale_macros(m: &DietMacros, factor: f64) -> DietMacros {
    DietMacros {
        kcal: m.kcal * factor,
        protein_g: m.protein_g * factor,
        fat_g: m.fat_g * factor,
        carb_g: m.carb_g * factor,
    }
}

pub fn add_macros(a: &DietMacros, b: &DietMacros) -> DietMacros {
    DietMacros {
        kcal: a.kcal + b.kcal,
        protein_g: a.protein_g + b.protein_g,
        fat_g: a.fat_g + b.fat_g,
        carb_g: a.carb_g + b.carb_g,
    }
}

pub fn sum_macros<'a>(items: impl IntoIterator<Item = &'a DietMacros>) -> DietMacros {
    items
        .into_iter()
        .fold(DietMacros::default(), |acc, m| add_macros(&acc, m))
}

/// 레시피 전체 영양 = Σ(재료 100g당 × 중량). 재료가 (per_100g, qty_g) 튜플로 들어온다.
pub fn recipe_totals<'a>(
    ingredients: impl IntoIterator<Item = (&'a DietMacros, f64)>,
) -> DietMacros {
    ingredients
        .into_iter()
        .fold(DietMacros::default(), |acc, (per, qty)| {
            add_macros(&acc, &macros_for_qty(per, qty))
        })
}

/// 인분당 영양. servings <= 0이면(스키마 CHECK로 불가능하지만 방어) 전체를 그대로 반환.
pub fn per_serving(total: &DietMacros, servings: f64) -> DietMacros {
    if servings <= 0.0 {
        return *total;
    }
    scale_macros(total, 1.0 / servings)
}

/// 일일 실적을 목표 대비 검증. kcal_ok = |actual − target| <= target × tolerance%,
/// protein_ok = actual >= min (min 미설정이면 None).
pub fn check_goal(
    actual: &DietMacros,
    calorie_target: f64,
    calorie_tolerance_pct: f64,
    protein_min_g: Option<f64>,
) -> DietGoalCheck {
    let kcal_delta = actual.kcal - calorie_target;
    let allowed = calorie_target * calorie_tolerance_pct / 100.0;
    DietGoalCheck {
        calorie_target,
        calorie_tolerance_pct,
        protein_min_g,
        kcal_delta,
        kcal_ok: kcal_delta.abs() <= allowed,
        protein_ok: protein_min_g.map(|min| actual.protein_g >= min),
    }
}

/// FEFO 할당 입력 로트. `expires_on`은 'YYYY-MM-DD'(사전순 == 시간순), None = 유통기한 없음.
#[derive(Debug, Clone)]
pub struct FefoLot {
    pub id: String,
    pub expires_on: Option<String>,
    pub remaining_qty_g: f64,
}

/// FEFO(First-Expired-First-Out) 차감 계획. 유통기한 빠른 로트부터 소진하고, 기한 없는 로트는
/// 마지막(동순위는 입력 순서 유지 — 호출자가 acquired_on 순으로 전달). 반환은 (로트별 차감량,
/// 부족량). **계획만 계산** — 실제 UPDATE/이벤트 기록은 커맨드 층이 수행.
pub fn fefo_allocate(lots: &[FefoLot], need_g: f64) -> (Vec<(String, f64)>, f64) {
    let mut order: Vec<&FefoLot> = lots.iter().filter(|l| l.remaining_qty_g > 0.0).collect();
    // sort_by는 stable — expires 동일/모두-None이면 입력 순서(입고 순) 유지.
    order.sort_by(|a, b| match (&a.expires_on, &b.expires_on) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let mut remaining_need = need_g.max(0.0);
    let mut takes = Vec::new();
    for lot in order {
        if remaining_need <= 0.0 {
            break;
        }
        let take = lot.remaining_qty_g.min(remaining_need);
        takes.push((lot.id.clone(), take));
        remaining_need -= take;
    }
    (takes, remaining_need)
}

/// 순구매 필요량 = max(0, 필요 − 재고 − 미입고 주문).
pub fn net_needed(required_g: f64, available_g: f64, pending_g: f64) -> f64 {
    (required_g - available_g - pending_g).max(0.0)
}

// ===========================================================================
// 레시피 저작 (docs/plans/2026-07-26-recipe-authoring-workout.md)
// ===========================================================================

/// 단위 환산 후보 한 줄. `food_id`가 None이면 전역 기본(폴백).
#[derive(Debug, Clone)]
pub struct UnitConversionEntry {
    pub unit: String,
    pub food_id: Option<String>,
    pub grams_per_unit: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnitResolveError {
    /// 수량이 0 이하이거나 유한하지 않다.
    NonPositiveQty,
    /// 이 단위 환산이 전역에도, 이 식품에도 없다.
    UnknownUnit(String),
}

/// `qty` + `unit` → g. lookup 순서는 **food 전용 → 전역 → 실패**.
///
/// 실패를 에러로 돌려주는 것이 계약이다 — 환산을 모를 때 0g이나 추정치를 조용히 채우면
/// 영양·재고 차감이 전부 틀어진다. 호출자(커맨드)가 검증 오류로 접어 사용자에게 노출한다.
pub fn resolve_qty_g(
    qty: f64,
    unit: &str,
    food_id: &str,
    conversions: &[UnitConversionEntry],
) -> Result<f64, UnitResolveError> {
    if !qty.is_finite() || qty <= 0.0 {
        return Err(UnitResolveError::NonPositiveQty);
    }
    let wanted = unit.trim().to_lowercase();
    let matches_unit = |c: &&UnitConversionEntry| c.unit.trim().to_lowercase() == wanted;
    let picked = conversions
        .iter()
        .find(|c| matches_unit(c) && c.food_id.as_deref() == Some(food_id))
        .or_else(|| {
            conversions
                .iter()
                .find(|c| matches_unit(c) && c.food_id.is_none())
        });
    match picked {
        Some(c) => Ok(qty * c.grams_per_unit),
        None => Err(UnitResolveError::UnknownUnit(wanted)),
    }
}

/// 스케일 배수. base/target이 비정상이면 1.0(원본 유지) — 나눗셈 폭주 방어.
pub fn scale_factor(base_servings: f64, target_servings: f64) -> f64 {
    if base_servings <= 0.0 || target_servings <= 0.0 || !target_servings.is_finite() {
        return 1.0;
    }
    target_servings / base_servings
}

/// 축별 피드백 한 줄. `None` = 그 축에 대해 평가하지 않음(0과 구분).
#[derive(Debug, Clone, Default)]
pub struct TasteFeedbackSample {
    pub salt: Option<i32>,
    pub spice: Option<i32>,
    pub sweet: Option<i32>,
    pub sour: Option<i32>,
    pub richness: Option<i32>,
    pub doneness: Option<i32>,
}

/// 힌트를 낼 최소 |가중평균|. 이보다 약한 신호는 노이즈로 보고 침묵한다.
pub const TASTE_HINT_THRESHOLD: f64 = 0.5;

/// 축별 조정 **제안**. `samples`는 **최신 우선**(`ORDER BY created_at DESC`)으로 들어온다 —
/// 가중치 1/(1+i)로 최근 피드백을 더 세게 반영한다.
///
/// 자동 수정은 하지 않는다: 결정레일상 에이전트는 사실(피드백)을 기록하고 파생 판단을
/// 제안까지만 할 수 있으며, 레시피를 바꾸는 것은 명시적 patch 호출이다.
pub fn taste_hints(samples: &[TasteFeedbackSample]) -> Vec<TasteHint> {
    /// 축 → 그 축의 값 추출기. 고정 배열로 두어 출력 순서를 결정론으로 만든다.
    type AxisPicker = (TasteAxis, fn(&TasteFeedbackSample) -> Option<i32>);
    let axes: [AxisPicker; 6] = [
        (TasteAxis::Salt, |s| s.salt),
        (TasteAxis::Spice, |s| s.spice),
        (TasteAxis::Sweet, |s| s.sweet),
        (TasteAxis::Sour, |s| s.sour),
        (TasteAxis::Richness, |s| s.richness),
        (TasteAxis::Doneness, |s| s.doneness),
    ];

    let mut hints = Vec::new();
    for (axis, pick) in axes {
        let mut weighted = 0.0;
        let mut weight_sum = 0.0;
        let mut count = 0i32;
        for (i, sample) in samples.iter().enumerate() {
            if let Some(v) = pick(sample) {
                let w = 1.0 / (1.0 + i as f64);
                weighted += f64::from(v) * w;
                weight_sum += w;
                count += 1;
            }
        }
        if count == 0 || weight_sum <= 0.0 {
            continue;
        }
        let avg = weighted / weight_sum;
        if avg.abs() < TASTE_HINT_THRESHOLD {
            continue;
        }
        hints.push(TasteHint {
            axis,
            // +는 "과했다" → 줄여라.
            direction: if avg > 0.0 {
                TasteDirection::Reduce
            } else {
                TasteDirection::Increase
            },
            magnitude: avg.abs(),
            samples: count,
        });
    }
    hints
}

/// 현재 레시피 상태 → 리비전 스냅샷. 파생값(food_name·영양)은 담지 않는다 —
/// 담으면 되돌린 뒤 food 수정 이력과 어긋난다.
pub fn recipe_snapshot(recipe: &Recipe) -> RecipeSnapshot {
    RecipeSnapshot {
        name: recipe.name.clone(),
        servings: recipe.servings,
        cook_minutes: recipe.cook_minutes,
        meal_tags: recipe.meal_tags.clone(),
        source_url: recipe.source_url.clone(),
        yield_g: recipe.yield_g,
        notes: recipe.notes.clone(),
        ingredients: recipe
            .ingredients
            .iter()
            .map(|i| RecipeSnapshotIngredient {
                food_id: i.food_id.clone(),
                qty_g: i.qty_g,
                qty: i.qty,
                unit: i.unit.clone(),
                to_taste: i.to_taste,
                optional: i.optional,
                note: i.note.clone(),
                sort_rank: i.sort_rank,
            })
            .collect(),
        steps: recipe
            .steps
            .iter()
            .map(|s| RecipeSnapshotStep {
                sort_rank: s.sort_rank,
                body: s.body.clone(),
                duration_minutes: s.duration_minutes,
                note: s.note.clone(),
            })
            .collect(),
    }
}

/// 스냅샷 → 재적용 입력. 순서는 배열 위치로 표현되므로 `sort_rank`는 커맨드가 다시 부여한다.
///
/// `qty_g`를 직접 실어 보낸다(단위 재환산 금지) — 환산 테이블이 그 사이 바뀌었더라도
/// 되돌린 레시피는 **그 리비전의 g 값 그대로**여야 한다.
pub fn snapshot_to_inputs(
    snapshot: &RecipeSnapshot,
) -> (Vec<RecipeIngredientInput>, Vec<RecipeStepInput>) {
    let ingredients = snapshot
        .ingredients
        .iter()
        .map(|i| RecipeIngredientInput {
            food_id: i.food_id.clone(),
            qty_g: Some(i.qty_g),
            qty: i.qty,
            unit: i.unit.clone(),
            to_taste: i.to_taste,
            optional: i.optional,
            note: i.note.clone(),
        })
        .collect();
    let steps = snapshot
        .steps
        .iter()
        .map(|s| RecipeStepInput {
            body: s.body.clone(),
            duration_minutes: s.duration_minutes,
            note: s.note.clone(),
        })
        .collect();
    (ingredients, steps)
}

/// 리비전 스냅샷 diff. 재료는 `food_id`로, 단계는 위치(1-based)로 대응시킨다.
/// **저장하지 않고 쿼리타임 계산** — 저장하면 스냅샷과 어긋날 수 있다.
pub fn revision_diff(before: &RecipeSnapshot, after: &RecipeSnapshot) -> Vec<RecipeDiffEntry> {
    let mut out = Vec::new();

    let mut meta = |label: &str, b: String, a: String| {
        if b != a {
            out.push(RecipeDiffEntry {
                kind: RecipeDiffKind::MetaChanged,
                label: label.to_string(),
                before: Some(b),
                after: Some(a),
            });
        }
    };
    meta("name", before.name.clone(), after.name.clone());
    meta(
        "servings",
        format_num(before.servings),
        format_num(after.servings),
    );
    meta(
        "cookMinutes",
        opt_str(before.cook_minutes.map(|v| v.to_string())),
        opt_str(after.cook_minutes.map(|v| v.to_string())),
    );
    meta(
        "mealTags",
        before.meal_tags.join(","),
        after.meal_tags.join(","),
    );
    meta(
        "sourceUrl",
        opt_str(before.source_url.clone()),
        opt_str(after.source_url.clone()),
    );
    meta(
        "yieldG",
        opt_str(before.yield_g.map(format_num)),
        opt_str(after.yield_g.map(format_num)),
    );
    meta(
        "notes",
        opt_str(before.notes.clone()),
        opt_str(after.notes.clone()),
    );

    for b in &before.ingredients {
        match after.ingredients.iter().find(|a| a.food_id == b.food_id) {
            None => out.push(RecipeDiffEntry {
                kind: RecipeDiffKind::IngredientRemoved,
                label: b.food_id.clone(),
                before: Some(describe_ingredient(b)),
                after: None,
            }),
            Some(a) => {
                let (bd, ad) = (describe_ingredient(b), describe_ingredient(a));
                if bd != ad {
                    out.push(RecipeDiffEntry {
                        kind: RecipeDiffKind::IngredientChanged,
                        label: b.food_id.clone(),
                        before: Some(bd),
                        after: Some(ad),
                    });
                }
            }
        }
    }
    for a in &after.ingredients {
        if !before.ingredients.iter().any(|b| b.food_id == a.food_id) {
            out.push(RecipeDiffEntry {
                kind: RecipeDiffKind::IngredientAdded,
                label: a.food_id.clone(),
                before: None,
                after: Some(describe_ingredient(a)),
            });
        }
    }

    // 단계는 안정 id가 스냅샷에 없으므로 위치 기준으로 비교한다(재정렬 = 내용 변경으로 나타남).
    let max_steps = before.steps.len().max(after.steps.len());
    for i in 0..max_steps {
        let label = format!("step {}", i + 1);
        match (before.steps.get(i), after.steps.get(i)) {
            (Some(b), Some(a)) => {
                let (bd, ad) = (describe_step(b), describe_step(a));
                if bd != ad {
                    out.push(RecipeDiffEntry {
                        kind: RecipeDiffKind::StepChanged,
                        label,
                        before: Some(bd),
                        after: Some(ad),
                    });
                }
            }
            (Some(b), None) => out.push(RecipeDiffEntry {
                kind: RecipeDiffKind::StepRemoved,
                label,
                before: Some(describe_step(b)),
                after: None,
            }),
            (None, Some(a)) => out.push(RecipeDiffEntry {
                kind: RecipeDiffKind::StepAdded,
                label,
                before: None,
                after: Some(describe_step(a)),
            }),
            (None, None) => {}
        }
    }
    out
}

/// 소수 꼬리 없는 표기(1.0 → "1", 1.5 → "1.5") — diff 문자열 비교가 부동소수 표기로
/// 흔들리지 않게 한다.
fn format_num(v: f64) -> String {
    if (v.fract()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.3}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

fn opt_str(v: Option<String>) -> String {
    v.unwrap_or_default()
}

fn describe_ingredient(i: &RecipeSnapshotIngredient) -> String {
    let mut s = format!("{}g", format_num(i.qty_g));
    if let (Some(qty), Some(unit)) = (i.qty, i.unit.as_deref()) {
        s = format!("{} {} ({}g)", format_num(qty), unit, format_num(i.qty_g));
    }
    if i.to_taste {
        s.push_str(" · 간 맞춰서");
    }
    if i.optional {
        s.push_str(" · optional");
    }
    if let Some(note) = i.note.as_deref().filter(|n| !n.is_empty()) {
        s.push_str(&format!(" · {note}"));
    }
    s
}

fn describe_step(s: &RecipeSnapshotStep) -> String {
    let mut out = s.body.clone();
    if let Some(m) = s.duration_minutes {
        out.push_str(&format!(" ({m}분)"));
    }
    if let Some(note) = s.note.as_deref().filter(|n| !n.is_empty()) {
        out.push_str(&format!(" · {note}"));
    }
    out
}

/// 재고 한 줄(식품별 집계). `earliest_expiry` = 'YYYY-MM-DD' 또는 None(기한 없음).
#[derive(Debug, Clone)]
pub struct StockEntry {
    pub food_id: String,
    pub available_g: f64,
    pub earliest_expiry: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SuggestionIngredient {
    pub food_id: String,
    pub food_name: String,
    pub qty_g: f64,
}

#[derive(Debug, Clone)]
pub struct SuggestionCandidate {
    pub recipe_id: String,
    pub name: String,
    pub servings: f64,
    pub per_serving: DietMacros,
    pub ingredients: Vec<SuggestionIngredient>,
}

/// 유통기한 압력을 계산하는 창(일). 이 안에 드는 재료만 "임박"으로 본다.
pub const EXPIRY_PRESSURE_WINDOW_DAYS: i64 = 7;

const W_COVERAGE: f64 = 0.5;
const W_EXPIRY: f64 = 0.3;
const W_GOAL: f64 = 0.2;

/// 재고 기반 레시피 추천 — **결정론**. LLM 아님.
///
/// 점수 = 0.5×재고커버리지 + 0.3×유통기한압력 + 0.2×목표적합도. 동점은 이름 → id 순으로
/// 안정 정렬(테스트/UI 결정론). `today`는 호출자가 주입한다(로컬 날짜는 프런트/커맨드 책임).
pub fn suggest_recipes(
    candidates: &[SuggestionCandidate],
    stock: &[StockEntry],
    today: &str,
    target_kcal_per_meal: Option<f64>,
    limit: usize,
) -> Vec<RecipeSuggestion> {
    let today_date = chrono::NaiveDate::parse_from_str(today, "%Y-%m-%d").ok();
    let mut out: Vec<RecipeSuggestion> = candidates
        .iter()
        .map(|c| {
            let mut need_total = 0.0;
            let mut covered_total = 0.0;
            let mut pressure_weighted = 0.0;
            let mut missing = Vec::new();
            let mut earliest: Option<String> = None;

            for ing in &c.ingredients {
                let need = ing.qty_g.max(0.0);
                need_total += need;
                let entry = stock.iter().find(|s| s.food_id == ing.food_id);
                let available = entry.map(|s| s.available_g.max(0.0)).unwrap_or(0.0);
                let covered = available.min(need);
                covered_total += covered;
                if covered + 1e-9 < need {
                    missing.push(ing.food_name.clone());
                }
                if let Some(expiry) = entry.and_then(|s| s.earliest_expiry.as_deref()) {
                    if covered > 0.0 {
                        // 'YYYY-MM-DD'는 사전순 == 시간순 — 문자열 비교로 최소값을 고른다.
                        earliest = match earliest {
                            Some(cur) if cur.as_str() <= expiry => Some(cur),
                            _ => Some(expiry.to_string()),
                        };
                        pressure_weighted += need * expiry_urgency(today_date, expiry);
                    }
                }
            }

            let coverage = if need_total <= 0.0 {
                1.0
            } else {
                covered_total / need_total
            };
            let expiry_pressure = if need_total <= 0.0 {
                0.0
            } else {
                (pressure_weighted / need_total).clamp(0.0, 1.0)
            };
            let goal_fit = match target_kcal_per_meal {
                Some(target) if target > 0.0 => {
                    (1.0 - (c.per_serving.kcal - target).abs() / target).clamp(0.0, 1.0)
                }
                // 목표 미설정 = 중립(0.5). 0으로 두면 목표 없는 사용자에게 전 후보가 감점된다.
                _ => 0.5,
            };
            let score =
                (W_COVERAGE * coverage + W_EXPIRY * expiry_pressure + W_GOAL * goal_fit) * 100.0;

            RecipeSuggestion {
                recipe_id: c.recipe_id.clone(),
                name: c.name.clone(),
                servings: c.servings,
                per_serving: c.per_serving,
                coverage_pct: coverage * 100.0,
                expiry_pressure_pct: expiry_pressure * 100.0,
                earliest_expiry: earliest,
                missing,
                score,
            }
        })
        .collect();

    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.recipe_id.cmp(&b.recipe_id))
    });
    out.truncate(limit);
    out
}

/// 유통기한 긴급도 0..1. 이미 지났으면 1.0(가장 급함), 창 밖이면 0.0.
/// 날짜 파싱 실패는 0.0 — 추정하지 않는다.
fn expiry_urgency(today: Option<chrono::NaiveDate>, expiry: &str) -> f64 {
    let (Some(today), Ok(exp)) = (today, chrono::NaiveDate::parse_from_str(expiry, "%Y-%m-%d"))
    else {
        return 0.0;
    };
    let days = (exp - today).num_days();
    if days <= 0 {
        return 1.0;
    }
    if days >= EXPIRY_PRESSURE_WINDOW_DAYS {
        return 0.0;
    }
    (EXPIRY_PRESSURE_WINDOW_DAYS - days) as f64 / EXPIRY_PRESSURE_WINDOW_DAYS as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(kcal: f64, protein: f64, fat: f64, carb: f64) -> DietMacros {
        DietMacros {
            kcal,
            protein_g: protein,
            fat_g: fat,
            carb_g: carb,
        }
    }

    #[test]
    fn macros_scale_by_quantity() {
        // 닭다리살(껍질 없음) 100g당 ~120kcal/22g — 150g이면 1.5배.
        let per = m(120.0, 22.0, 3.5, 0.0);
        let got = macros_for_qty(&per, 150.0);
        assert!((got.kcal - 180.0).abs() < 1e-9);
        assert!((got.protein_g - 33.0).abs() < 1e-9);
        assert!((got.fat_g - 5.25).abs() < 1e-9);
    }

    #[test]
    fn recipe_totals_and_per_serving_compose() {
        // 알리오 올리오: 마른 면 80g(371kcal/100g) + 오일 10g(884) + 새우 150g(85).
        let pasta = m(371.0, 13.0, 1.5, 74.7);
        let oil = m(884.0, 0.0, 100.0, 0.0);
        let shrimp = m(85.0, 20.0, 0.5, 0.2);
        let total = recipe_totals([(&pasta, 80.0), (&oil, 10.0), (&shrimp, 150.0)]);
        // 296.8 + 88.4 + 127.5 = 512.7 kcal
        assert!((total.kcal - 512.7).abs() < 1e-9);
        assert!((total.protein_g - (10.4 + 0.0 + 30.0)).abs() < 1e-9);

        let half = per_serving(&total, 2.0);
        assert!((half.kcal - 256.35).abs() < 1e-9);
        // 방어: servings 0이면 전체 반환(나눗셈 폭주 금지).
        assert_eq!(per_serving(&total, 0.0).kcal, total.kcal);
    }

    #[test]
    fn sum_macros_folds_all_items() {
        let items = [m(100.0, 10.0, 1.0, 2.0), m(50.0, 5.0, 0.5, 1.0)];
        let total = sum_macros(items.iter());
        assert!((total.kcal - 150.0).abs() < 1e-9);
        assert!((total.protein_g - 15.0).abs() < 1e-9);
    }

    #[test]
    fn goal_check_uses_tolerance_band_and_protein_floor() {
        // 목표 2200 ±7% (=±154).
        let ok = check_goal(&m(2185.0, 146.0, 60.0, 250.0), 2200.0, 7.0, Some(140.0));
        assert!(ok.kcal_ok);
        assert_eq!(ok.protein_ok, Some(true));
        assert!((ok.kcal_delta - -15.0).abs() < 1e-9);

        let over = check_goal(&m(2400.0, 130.0, 60.0, 250.0), 2200.0, 7.0, Some(140.0));
        assert!(!over.kcal_ok, "2400은 2200±154 밖");
        assert_eq!(over.protein_ok, Some(false));

        // 단백질 목표 미설정 → None (false 아님 — "검증 안 함"과 "미달"을 구분).
        let no_min = check_goal(&m(2200.0, 0.0, 0.0, 0.0), 2200.0, 7.0, None);
        assert_eq!(no_min.protein_ok, None);
    }

    fn lot(id: &str, expires: Option<&str>, remaining: f64) -> FefoLot {
        FefoLot {
            id: id.into(),
            expires_on: expires.map(str::to_string),
            remaining_qty_g: remaining,
        }
    }

    #[test]
    fn fefo_takes_earliest_expiry_first_and_reports_shortfall() {
        let lots = [
            lot("late", Some("2026-08-01"), 500.0),
            lot("early", Some("2026-07-20"), 300.0),
            lot("no-expiry", None, 400.0),
        ];
        let (takes, shortfall) = fefo_allocate(&lots, 600.0);
        assert_eq!(shortfall, 0.0);
        assert_eq!(
            takes,
            vec![("early".to_string(), 300.0), ("late".to_string(), 300.0)],
            "빠른 기한부터, 기한 없는 로트는 마지막"
        );

        let (takes, shortfall) = fefo_allocate(&lots, 1500.0);
        assert_eq!(takes.len(), 3);
        assert!((shortfall - 300.0).abs() < 1e-9, "1200 보유, 300 부족");
    }

    #[test]
    fn fefo_skips_empty_lots_and_handles_zero_need() {
        let lots = [lot("empty", Some("2026-07-18"), 0.0), lot("a", None, 100.0)];
        let (takes, shortfall) = fefo_allocate(&lots, 50.0);
        assert_eq!(takes, vec![("a".to_string(), 50.0)]);
        assert_eq!(shortfall, 0.0);

        let (takes, shortfall) = fefo_allocate(&lots, 0.0);
        assert!(takes.is_empty());
        assert_eq!(shortfall, 0.0);

        // 음수 need는 0으로 클램프(패닉/음수 차감 금지).
        let (takes, _) = fefo_allocate(&lots, -10.0);
        assert!(takes.is_empty());
    }

    #[test]
    fn fefo_same_expiry_preserves_input_order() {
        let lots = [
            lot("first-in", Some("2026-07-20"), 100.0),
            lot("second-in", Some("2026-07-20"), 100.0),
        ];
        let (takes, _) = fefo_allocate(&lots, 150.0);
        assert_eq!(
            takes,
            vec![
                ("first-in".to_string(), 100.0),
                ("second-in".to_string(), 50.0)
            ],
            "동일 기한은 입고 순(stable sort)"
        );
    }

    #[test]
    fn net_needed_subtracts_stock_and_pending_and_clamps() {
        // PRD §8.1: 필요 − 재고 − 미입고 + (여유분은 호출자가 required에 포함).
        assert_eq!(net_needed(1150.0, 300.0, 500.0), 350.0);
        assert_eq!(net_needed(1000.0, 800.0, 500.0), 0.0, "과잉이면 0 클램프");
        assert_eq!(net_needed(0.0, 100.0, 0.0), 0.0);
    }

    // --- 레시피 저작 -----------------------------------------------------

    fn conv(unit: &str, food: Option<&str>, grams: f64) -> UnitConversionEntry {
        UnitConversionEntry {
            unit: unit.into(),
            food_id: food.map(str::to_string),
            grams_per_unit: grams,
        }
    }

    #[test]
    fn unit_lookup_prefers_food_specific_over_global() {
        let convs = [
            conv("tsp", None, 5.0),
            conv("tsp", Some("salt"), 6.0),
            conv("clove", None, 5.0),
        ];
        // 소금 1작은술 = 6g(밀도), 물 1작은술 = 전역 5g.
        assert!((resolve_qty_g(1.0, "tsp", "salt", &convs).unwrap() - 6.0).abs() < 1e-9);
        assert!((resolve_qty_g(2.0, "tsp", "water", &convs).unwrap() - 10.0).abs() < 1e-9);
        // 대소문자/공백 정규화.
        assert!((resolve_qty_g(3.0, " Clove ", "garlic", &convs).unwrap() - 15.0).abs() < 1e-9);
    }

    #[test]
    fn unit_lookup_failure_is_an_error_not_a_silent_zero() {
        let convs = [conv("tsp", None, 5.0)];
        assert_eq!(
            resolve_qty_g(1.0, "handful", "x", &convs),
            Err(UnitResolveError::UnknownUnit("handful".into())),
            "모르는 단위에 0g/추정치를 채우면 영양·재고가 전부 틀어진다"
        );
        assert_eq!(
            resolve_qty_g(0.0, "tsp", "x", &convs),
            Err(UnitResolveError::NonPositiveQty)
        );
        assert_eq!(
            resolve_qty_g(f64::NAN, "tsp", "x", &convs),
            Err(UnitResolveError::NonPositiveQty)
        );
    }

    #[test]
    fn scale_factor_guards_degenerate_servings() {
        assert!((scale_factor(2.0, 3.0) - 1.5).abs() < 1e-9);
        assert_eq!(scale_factor(0.0, 3.0), 1.0, "base 0 → 원본 유지");
        assert_eq!(scale_factor(2.0, 0.0), 1.0);
        assert_eq!(scale_factor(2.0, f64::INFINITY), 1.0);
    }

    fn sample(salt: Option<i32>, spice: Option<i32>) -> TasteFeedbackSample {
        TasteFeedbackSample {
            salt,
            spice,
            ..Default::default()
        }
    }

    #[test]
    fn taste_hints_weight_recent_feedback_and_map_sign_to_direction() {
        // 최신 우선 순서: 가장 최근에 "너무 짰다(+2)".
        let hints = taste_hints(&[sample(Some(2), None), sample(Some(1), Some(-2))]);
        let salt = hints
            .iter()
            .find(|h| h.axis == TasteAxis::Salt)
            .expect("salt hint");
        assert_eq!(
            salt.direction,
            TasteDirection::Reduce,
            "+ = 과했다 → 줄여라"
        );
        assert_eq!(salt.samples, 2);
        // (2×1 + 1×0.5) / 1.5 = 1.666…
        assert!((salt.magnitude - 5.0 / 3.0).abs() < 1e-9);

        let spice = hints
            .iter()
            .find(|h| h.axis == TasteAxis::Spice)
            .expect("spice hint");
        assert_eq!(
            spice.direction,
            TasteDirection::Increase,
            "− = 부족했다 → 늘려라"
        );
        assert_eq!(spice.samples, 1);
    }

    #[test]
    fn taste_hints_stay_silent_on_weak_or_absent_signal() {
        // 평균 |0.33| < 0.5 임계 → 침묵.
        assert!(taste_hints(&[sample(Some(0), None), sample(Some(1), None)])
            .iter()
            .all(|h| h.axis != TasteAxis::Salt));
        // 축에 값이 없으면 힌트 없음(0으로 취급하지 않는다).
        assert!(taste_hints(&[sample(None, None)]).is_empty());
        assert!(taste_hints(&[]).is_empty());
    }

    fn snap_ing(food: &str, qty_g: f64) -> RecipeSnapshotIngredient {
        RecipeSnapshotIngredient {
            food_id: food.into(),
            qty_g,
            qty: None,
            unit: None,
            to_taste: false,
            optional: false,
            note: None,
            sort_rank: 0,
        }
    }

    fn snap_step(body: &str) -> RecipeSnapshotStep {
        RecipeSnapshotStep {
            sort_rank: 0.0,
            body: body.into(),
            duration_minutes: None,
            note: None,
        }
    }

    fn base_snapshot() -> RecipeSnapshot {
        RecipeSnapshot {
            name: "된장찌개".into(),
            servings: 2.0,
            cook_minutes: Some(20),
            meal_tags: vec!["dinner".into()],
            source_url: None,
            yield_g: None,
            notes: None,
            ingredients: vec![snap_ing("soybean-paste", 30.0), snap_ing("tofu", 150.0)],
            steps: vec![snap_step("육수를 끓인다"), snap_step("된장을 푼다")],
        }
    }

    #[test]
    fn revision_diff_classifies_meta_ingredient_and_step_changes() {
        let before = base_snapshot();
        let mut after = base_snapshot();
        after.name = "된장찌개 (짜지 않게)".into();
        after.ingredients[0].qty_g = 20.0; // 된장 줄임
        after.ingredients.remove(1); // 두부 뺌
        after.ingredients.push(snap_ing("zucchini", 80.0)); // 애호박 추가
        after.steps[1] = snap_step("된장을 2/3만 푼다");

        let diff = revision_diff(&before, &after);
        let kinds: Vec<_> = diff.iter().map(|d| (d.kind, d.label.as_str())).collect();
        assert!(kinds.contains(&(RecipeDiffKind::MetaChanged, "name")));
        assert!(kinds.contains(&(RecipeDiffKind::IngredientChanged, "soybean-paste")));
        assert!(kinds.contains(&(RecipeDiffKind::IngredientRemoved, "tofu")));
        assert!(kinds.contains(&(RecipeDiffKind::IngredientAdded, "zucchini")));
        assert!(kinds.contains(&(RecipeDiffKind::StepChanged, "step 2")));
        assert!(
            !kinds.contains(&(RecipeDiffKind::StepChanged, "step 1")),
            "안 바뀐 단계는 diff에 없다"
        );

        // 같은 스냅샷끼리는 차이 없음(부동소수 표기 흔들림 포함).
        assert!(revision_diff(&before, &base_snapshot()).is_empty());
    }

    #[test]
    fn revision_diff_reports_added_and_removed_steps_at_the_tail() {
        let before = base_snapshot();
        let mut longer = base_snapshot();
        longer.steps.push(snap_step("두부를 넣는다"));
        let added = revision_diff(&before, &longer);
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].kind, RecipeDiffKind::StepAdded);
        assert_eq!(added[0].label, "step 3");

        let removed = revision_diff(&longer, &before);
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].kind, RecipeDiffKind::StepRemoved);
    }

    fn candidate(id: &str, name: &str, kcal: f64, ings: &[(&str, f64)]) -> SuggestionCandidate {
        SuggestionCandidate {
            recipe_id: id.into(),
            name: name.into(),
            servings: 1.0,
            per_serving: m(kcal, 30.0, 10.0, 40.0),
            ingredients: ings
                .iter()
                .map(|(food, qty)| SuggestionIngredient {
                    food_id: (*food).into(),
                    food_name: format!("{food}-name"),
                    qty_g: *qty,
                })
                .collect(),
        }
    }

    fn stock(food: &str, available: f64, expiry: Option<&str>) -> StockEntry {
        StockEntry {
            food_id: food.into(),
            available_g: available,
            earliest_expiry: expiry.map(str::to_string),
        }
    }

    #[test]
    fn suggestions_rank_full_stock_over_missing_ingredients() {
        let candidates = [
            candidate("a", "재고있음", 600.0, &[("tofu", 100.0)]),
            candidate("b", "재고없음", 600.0, &[("beef", 100.0)]),
        ];
        let stock = [stock("tofu", 500.0, None)];
        let out = suggest_recipes(&candidates, &stock, "2026-07-26", None, 10);
        assert_eq!(out[0].recipe_id, "a");
        assert!((out[0].coverage_pct - 100.0).abs() < 1e-9);
        assert!(out[0].missing.is_empty());
        assert_eq!(out[1].coverage_pct, 0.0);
        assert_eq!(
            out[1].missing,
            vec!["beef-name"],
            "부족 재료를 이름으로 노출"
        );
    }

    #[test]
    fn suggestions_favor_recipes_that_burn_down_expiring_stock() {
        // 둘 다 재고 100%지만 a는 내일 만료되는 재료를 쓴다.
        let candidates = [
            candidate("a", "임박소진", 600.0, &[("milk", 100.0)]),
            candidate("b", "여유", 600.0, &[("rice", 100.0)]),
        ];
        let stock = [
            stock("milk", 200.0, Some("2026-07-27")),
            stock("rice", 200.0, Some("2027-01-01")),
        ];
        let out = suggest_recipes(&candidates, &stock, "2026-07-26", None, 10);
        assert_eq!(
            out[0].recipe_id, "a",
            "FEFO 압력이 동일 커버리지의 타이브레이커"
        );
        assert!(out[0].expiry_pressure_pct > out[1].expiry_pressure_pct);
        assert_eq!(out[0].earliest_expiry.as_deref(), Some("2026-07-27"));
        assert_eq!(out[1].expiry_pressure_pct, 0.0, "창(7일) 밖은 압력 0");
    }

    #[test]
    fn suggestions_apply_goal_fit_and_neutral_when_goal_absent() {
        let candidates = [
            candidate("near", "목표근접", 600.0, &[("tofu", 100.0)]),
            candidate("far", "목표초과", 1800.0, &[("tofu", 100.0)]),
        ];
        let stock = [stock("tofu", 1000.0, None)];
        let with_goal = suggest_recipes(&candidates, &stock, "2026-07-26", Some(600.0), 10);
        assert_eq!(with_goal[0].recipe_id, "near");

        // 목표 미설정이면 kcal은 순위에 개입하지 않는다 → 이름 순 안정 정렬.
        let no_goal = suggest_recipes(&candidates, &stock, "2026-07-26", None, 10);
        assert_eq!(no_goal[0].score, no_goal[1].score);
        assert_eq!(no_goal[0].name, "목표근접");
        assert_eq!(no_goal[1].name, "목표초과");
    }

    #[test]
    fn suggestions_are_deterministic_and_respect_limit() {
        // 완전 동점(이름만 다름) → 이름 순 고정.
        let candidates = [
            candidate("z", "b-이름", 600.0, &[("tofu", 10.0)]),
            candidate("y", "a-이름", 600.0, &[("tofu", 10.0)]),
        ];
        let stock = [stock("tofu", 100.0, None)];
        let first = suggest_recipes(&candidates, &stock, "2026-07-26", None, 10);
        let second = suggest_recipes(&candidates, &stock, "2026-07-26", None, 10);
        assert_eq!(first[0].recipe_id, "y");
        assert_eq!(
            first
                .iter()
                .map(|s| s.recipe_id.clone())
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|s| s.recipe_id.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            suggest_recipes(&candidates, &stock, "2026-07-26", None, 1).len(),
            1
        );
    }

    #[test]
    fn snapshot_json_round_trips_without_loss() {
        // 리비전은 snapshot_json으로 저장된다 — 왕복에서 값이 새면 되돌리기가 조용히 망가진다.
        let snap = base_snapshot();
        let json = serde_json::to_string(&snap).expect("serialize");
        let back: RecipeSnapshot = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(snap, back);
    }

    #[test]
    fn snapshot_to_inputs_preserves_grams_verbatim_for_revert() {
        let mut snap = base_snapshot();
        snap.ingredients[0].qty = Some(2.0);
        snap.ingredients[0].unit = Some("tbsp".into());
        snap.ingredients[0].qty_g = 36.0; // 그 당시 food 전용 환산(18g/tbsp)의 결과

        let (ings, steps) = snapshot_to_inputs(&snap);
        assert_eq!(ings.len(), 2);
        assert_eq!(
            ings[0].qty_g,
            Some(36.0),
            "환산 테이블이 그 사이 바뀌어도 되돌린 g은 그 리비전 값이어야 한다"
        );
        assert_eq!(ings[0].unit.as_deref(), Some("tbsp"), "표기도 함께 보존");
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].body, "육수를 끓인다");
    }

    #[test]
    fn expired_stock_is_maximum_urgency_and_unparsable_dates_are_ignored() {
        let candidates = [candidate("a", "만료", 600.0, &[("milk", 100.0)])];
        let expired = [stock("milk", 200.0, Some("2026-07-01"))];
        let out = suggest_recipes(&candidates, &expired, "2026-07-26", None, 10);
        assert!(
            (out[0].expiry_pressure_pct - 100.0).abs() < 1e-9,
            "이미 지난 기한 = 최대 긴급"
        );

        let garbage = [stock("milk", 200.0, Some("언젠가"))];
        let out = suggest_recipes(&candidates, &garbage, "2026-07-26", None, 10);
        assert_eq!(
            out[0].expiry_pressure_pct, 0.0,
            "파싱 실패는 추정하지 않는다"
        );
        // today가 파싱 불가여도 패닉/추정 없음.
        let out = suggest_recipes(&candidates, &expired, "not-a-date", None, 10);
        assert_eq!(out[0].expiry_pressure_pct, 0.0);
    }
}
