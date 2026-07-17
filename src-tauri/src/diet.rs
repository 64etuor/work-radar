//! Diet 순수 계산 커널 (docs/plans/2026-07-17-diet-domain.md).
//!
//! PRD 핵심 철학의 기계화: **영양 계산·제약 검증·재고 차감은 결정론** — LLM/에이전트는 이
//! 함수들의 결과를 임의로 바꿀 수 없다. DB/keychain 의존 없음(도메인 층 — ipc-conventions
//! `X.rs` 경계). 같은 입력 → 같은 출력.

use crate::models::{DietGoalCheck, DietMacros};

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
}
