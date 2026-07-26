//! Workout 순수 계산 커널 (docs/plans/2026-07-26-recipe-authoring-workout.md §8.1).
//!
//! diet.rs와 같은 층: DB/keychain 의존 없음, 같은 입력 → 같은 출력. 볼륨·1RM·소모 kcal·BMR은
//! 전부 결정론이고, 에이전트는 이 결과를 임의로 바꿀 수 없다.
//!
//! **추정하지 않는 것이 계약이다.** 프로필(생년/키/성별)이나 체중이 없으면 BMR을 `None`으로
//! 돌려준다 — 그럴듯한 기본값을 조용히 채우면 에너지 밸런스가 근거 없는 숫자가 된다.

use crate::models::{BodyProfile, EnergyBalance, WorkoutVolume};

/// 볼륨 계산 입력 세트 한 줄. 값이 없는 축은 `None`(0과 구분).
#[derive(Debug, Clone, Default)]
pub struct VolumeSet {
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
}

/// 세션 볼륨. 톤수 = Σ(reps × weight) — 무게 없는 맨몸 세트는 톤수에 0으로 기여하지만
/// 세트/렙 수에는 포함된다(운동을 했다는 사실은 남아야 한다).
pub fn session_volume(sets: &[VolumeSet]) -> WorkoutVolume {
    let mut volume_kg = 0.0;
    let mut total_reps = 0;
    let mut duration_sec = 0;
    let mut distance_m = 0.0;
    for set in sets {
        let reps = set.reps.unwrap_or(0).max(0);
        total_reps += reps;
        if let Some(weight) = set.weight_kg {
            if weight > 0.0 {
                volume_kg += weight * f64::from(reps);
            }
        }
        duration_sec += set.duration_sec.unwrap_or(0).max(0);
        distance_m += set.distance_m.unwrap_or(0.0).max(0.0);
    }
    WorkoutVolume {
        set_count: sets.len() as i32,
        total_reps,
        volume_kg,
        duration_sec,
        distance_m,
    }
}

/// 추정 1RM. **reps=1이면 그 무게 그대로**(추정이 아니라 실측이다 — Epley를 1회에 적용하면
/// 모든 싱글이 3.3% 부풀고 그 값이 최고기록 선택까지 오염된다). reps>1은 Epley
/// `w × (1 + reps/30)`. 값이 불충분하면 `None` — 추정치를 꾸미지 않는다.
pub fn estimated_1rm(reps: Option<i32>, weight_kg: Option<f64>) -> Option<f64> {
    let (reps, weight) = (reps?, weight_kg?);
    if reps <= 0 || weight <= 0.0 || !weight.is_finite() {
        return None;
    }
    if reps == 1 {
        return Some(weight);
    }
    Some(weight * (1.0 + f64::from(reps) / 30.0))
}

/// MET 기반 소모 kcal = MET × 체중kg × 시간h. MET이나 체중/시간이 없으면 0(추정 금지).
pub fn energy_burned_kcal(met: Option<f64>, weight_kg: Option<f64>, duration_sec: i32) -> f64 {
    let (Some(met), Some(weight)) = (met, weight_kg) else {
        return 0.0;
    };
    if met <= 0.0 || weight <= 0.0 || duration_sec <= 0 {
        return 0.0;
    }
    met * weight * (f64::from(duration_sec) / 3600.0)
}

/// Mifflin-St Jeor 기초대사량.
///   남성: 10×kg + 6.25×cm − 5×age + 5
///   여성: 10×kg + 6.25×cm − 5×age − 161
///
/// 프로필 필드(생년·키·**성별**)나 체중이 하나라도 없으면 `None`. 나이는 `on_year − birth_year`.
///
/// **"모르는 것"과 "식에 분기가 없는 것"을 구분한다:** 성별이 `None`이면 입력이 없는 것이므로
/// `None`을 돌려준다(두 식의 평균을 조용히 쓰면 근거 없는 숫자가 된다). 사용자가 명시적으로
/// `other`를 골랐다면 Mifflin에 그 분기가 없으므로 두 식의 중간값(−78)을 쓴다 — 이건 알려준
/// 정보에 대한 문서화된 선택이고, 침묵하는 추정이 아니다.
pub fn bmr_kcal(profile: &BodyProfile, weight_kg: Option<f64>, on_year: i32) -> Option<f64> {
    let weight = weight_kg?;
    let height = profile.height_cm?;
    let birth_year = profile.birth_year?;
    if weight <= 0.0 || height <= 0.0 {
        return None;
    }
    let age = on_year - birth_year;
    if age <= 0 || age > 130 {
        return None;
    }
    let offset = match profile.sex.as_deref() {
        Some("male") => 5.0,
        Some("female") => -161.0,
        Some("other") => -78.0,
        // 성별 미입력 — 추정하지 않는다.
        _ => return None,
    };
    let base = 10.0 * weight + 6.25 * height - 5.0 * f64::from(age);
    Some(base + offset)
}

/// 에너지 밸런스 = 섭취 − (BMR + 운동소모). BMR이 없으면 `maintenance_kcal`도 None이고
/// `balance_kcal`은 "섭취 − 운동소모"까지만 계산된다(무엇이 빠졌는지 `bmr_available`로 노출).
pub fn energy_balance(intake_kcal: f64, bmr_kcal: Option<f64>, workout_kcal: f64) -> EnergyBalance {
    let expenditure = bmr_kcal.unwrap_or(0.0) + workout_kcal;
    EnergyBalance {
        intake_kcal,
        bmr_kcal,
        workout_kcal,
        expenditure_kcal: expenditure,
        balance_kcal: intake_kcal - expenditure,
        bmr_available: bmr_kcal.is_some(),
    }
}

/// 체중 이동평균 — 일별 노이즈(수분/식사)를 걷어낸 추세.
/// `samples`는 **최신 우선**으로 들어온다. window보다 표본이 적으면 있는 만큼 평균한다.
pub fn weight_trend_kg(samples: &[f64], window: usize) -> Option<f64> {
    let window = window.max(1);
    let taken: Vec<f64> = samples
        .iter()
        .copied()
        .filter(|v| *v > 0.0)
        .take(window)
        .collect();
    if taken.is_empty() {
        return None;
    }
    Some(taken.iter().sum::<f64>() / taken.len() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strength(reps: i32, weight: f64) -> VolumeSet {
        VolumeSet {
            reps: Some(reps),
            weight_kg: Some(weight),
            ..Default::default()
        }
    }

    fn profile(birth_year: Option<i32>, height: Option<f64>, sex: Option<&str>) -> BodyProfile {
        BodyProfile {
            birth_year,
            height_cm: height,
            sex: sex.map(str::to_string),
            updated_at: "2026-07-26T00:00:00+09:00".into(),
        }
    }

    #[test]
    fn volume_sums_tonnage_reps_and_cardio_axes() {
        let sets = [
            strength(10, 60.0),
            strength(8, 70.0),
            VolumeSet {
                duration_sec: Some(1200),
                distance_m: Some(4000.0),
                ..Default::default()
            },
        ];
        let v = session_volume(&sets);
        assert_eq!(v.set_count, 3);
        assert_eq!(v.total_reps, 18);
        assert!((v.volume_kg - (600.0 + 560.0)).abs() < 1e-9);
        assert_eq!(v.duration_sec, 1200);
        assert!((v.distance_m - 4000.0).abs() < 1e-9);
    }

    #[test]
    fn bodyweight_sets_count_reps_without_inflating_tonnage() {
        let sets = [VolumeSet {
            reps: Some(15),
            weight_kg: None,
            ..Default::default()
        }];
        let v = session_volume(&sets);
        assert_eq!(v.total_reps, 15, "맨몸도 렙 수에는 남는다");
        assert_eq!(v.volume_kg, 0.0, "무게 없는 세트가 톤수를 만들지 않는다");
    }

    #[test]
    fn one_rm_uses_epley_and_refuses_incomplete_input() {
        // 100kg × 5렙 → 100 × (1 + 5/30) = 116.666…
        let est = estimated_1rm(Some(5), Some(100.0)).expect("1rm");
        assert!((est - 116.66666666666667).abs() < 1e-9);
        // 1렙은 추정이 아니라 실측 — 그 무게 그대로여야 한다(critic 지적 회귀 가드).
        assert_eq!(estimated_1rm(Some(1), Some(120.0)), Some(120.0));
        assert_eq!(estimated_1rm(None, Some(100.0)), None);
        assert_eq!(estimated_1rm(Some(5), None), None);
        assert_eq!(estimated_1rm(Some(0), Some(100.0)), None);
        assert_eq!(estimated_1rm(Some(5), Some(0.0)), None);
    }

    #[test]
    fn energy_burned_needs_met_weight_and_duration() {
        // 스쿼트 MET 5.0 × 69kg × 0.5h = 172.5
        assert!((energy_burned_kcal(Some(5.0), Some(69.0), 1800) - 172.5).abs() < 1e-9);
        assert_eq!(
            energy_burned_kcal(None, Some(69.0), 1800),
            0.0,
            "MET 없으면 0"
        );
        assert_eq!(
            energy_burned_kcal(Some(5.0), None, 1800),
            0.0,
            "체중 없으면 0"
        );
        assert_eq!(energy_burned_kcal(Some(5.0), Some(69.0), 0), 0.0);
    }

    #[test]
    fn bmr_matches_mifflin_st_jeor_for_the_seeded_profile() {
        // 1987년생 / 171cm / 남성 / 69kg, 2026년 → 나이 39.
        // 10×69 + 6.25×171 − 5×39 + 5 = 690 + 1068.75 − 195 + 5 = 1568.75
        let got = bmr_kcal(
            &profile(Some(1987), Some(171.0), Some("male")),
            Some(69.0),
            2026,
        )
        .expect("bmr");
        assert!((got - 1568.75).abs() < 1e-9);

        // 여성 식은 −161 오프셋.
        let female = bmr_kcal(
            &profile(Some(1987), Some(171.0), Some("female")),
            Some(69.0),
            2026,
        )
        .expect("bmr");
        assert!((female - (1568.75 - 5.0 - 161.0)).abs() < 1e-9);

        // 명시적 'other'는 Mifflin에 분기가 없어 두 식의 중간(−78) — 문서화된 선택.
        let other = bmr_kcal(
            &profile(Some(1987), Some(171.0), Some("other")),
            Some(69.0),
            2026,
        )
        .expect("bmr");
        assert!((other - (1568.75 - 5.0 - 78.0)).abs() < 1e-9);

        // 성별 **미입력**은 "모른다" → None(critic 지적 회귀 가드). 두 식의 평균을 조용히
        // 쓰면 근거 없는 숫자가 되고, 사용자는 그게 추정인지 알 수 없다.
        assert_eq!(
            bmr_kcal(&profile(Some(1987), Some(171.0), None), Some(69.0), 2026),
            None,
            "성별 미입력은 추정하지 않는다"
        );
    }

    #[test]
    fn bmr_is_none_rather_than_a_quiet_guess_when_inputs_are_missing() {
        let full = profile(Some(1987), Some(171.0), Some("male"));
        assert_eq!(bmr_kcal(&full, None, 2026), None, "체중 없음");
        assert_eq!(
            bmr_kcal(&profile(None, Some(171.0), Some("male")), Some(69.0), 2026),
            None,
            "생년 없음"
        );
        assert_eq!(
            bmr_kcal(&profile(Some(1987), None, Some("male")), Some(69.0), 2026),
            None,
            "키 없음"
        );
        // 미래 생년/비현실적 나이는 계산하지 않는다.
        assert_eq!(bmr_kcal(&full, Some(69.0), 1980), None);
        assert_eq!(
            bmr_kcal(
                &profile(Some(1800 + 90), Some(171.0), Some("male")),
                Some(69.0),
                2026
            ),
            None
        );
    }

    #[test]
    fn energy_balance_degrades_transparently_without_bmr() {
        let with_bmr = energy_balance(2200.0, Some(1568.75), 300.0);
        assert!((with_bmr.expenditure_kcal - 1868.75).abs() < 1e-9);
        assert!((with_bmr.balance_kcal - 331.25).abs() < 1e-9);
        assert!(with_bmr.bmr_available);

        let without = energy_balance(2200.0, None, 300.0);
        assert!(!without.bmr_available, "무엇이 빠졌는지 노출된다");
        assert_eq!(without.bmr_kcal, None);
        assert!(
            (without.balance_kcal - 1900.0).abs() < 1e-9,
            "섭취 − 운동소모까지만"
        );
    }

    #[test]
    fn weight_trend_averages_the_recent_window() {
        let samples = [69.4, 69.0, 68.8, 70.2, 71.0];
        let three = weight_trend_kg(&samples, 3).expect("trend");
        assert!((three - (69.4 + 69.0 + 68.8) / 3.0).abs() < 1e-9);
        // 표본이 window보다 적으면 있는 만큼.
        assert_eq!(weight_trend_kg(&[70.0], 7), Some(70.0));
        assert_eq!(weight_trend_kg(&[], 7), None);
        // 0/음수는 측정 실패로 보고 배제.
        assert_eq!(weight_trend_kg(&[0.0], 3), None);
    }
}
