//! 체성분 시계열 + 신체 프로필 + 에너지 수지(read-only 파생).
//!
//! **에너지 수지는 `diet_goals`를 자동으로 바꾸지 않는다.** 목표는 append-only 스냅샷이고
//! 파생 판단값 자동 설정은 결정레일 INVARIANT #1 위반이다 — 여기서 계산한 숫자는 표시용이고,
//! 목표를 조정하는 것은 사람의 결정이다.

#![allow(clippy::result_large_err)]

use tauri::State;

use super::{clean_optional, new_id, validate_date, validate_positive};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BodyMetric, BodyMetricField, BodyProfile, BodyTrend, DailyEnergyBalance, RecordBodyMetricInput,
    SetBodyProfileInput,
};
use crate::workout;

const METRIC_COLS: &str = "id, measured_on, weight_kg, body_fat_pct, skeletal_muscle_kg, \
                           waist_cm, note, source, created_at";

/// 체중 추이 이동평균 창(측정 횟수). 일별 수분/식사 노이즈를 걷어내기 위한 값.
const WEIGHT_TREND_WINDOW: usize = 7;

pub(crate) async fn record_body_metric_inner(
    db: &Db,
    input: RecordBodyMetricInput,
) -> Result<BodyMetric, AppError> {
    let measured_on = validate_date(&input.measured_on, "workout.body.date")?;
    if let Some(weight) = input.weight_kg {
        validate_positive(weight, "workout.body.weight")?;
    }
    if let Some(pct) = input.body_fat_pct {
        if !pct.is_finite() || !(0.0..100.0).contains(&pct) {
            return Err(AppError::validation(
                "workout.body.body_fat",
                "bodyFatPct must be in [0, 100)",
            ));
        }
    }
    if let Some(muscle) = input.skeletal_muscle_kg {
        validate_positive(muscle, "workout.body.muscle")?;
    }
    if let Some(waist) = input.waist_cm {
        validate_positive(waist, "workout.body.waist")?;
    }
    let clears = &input.clear;
    let conflicting = (input.weight_kg.is_some() && clears.contains(&BodyMetricField::WeightKg))
        || (input.body_fat_pct.is_some() && clears.contains(&BodyMetricField::BodyFatPct))
        || (input.skeletal_muscle_kg.is_some()
            && clears.contains(&BodyMetricField::SkeletalMuscleKg))
        || (input.waist_cm.is_some() && clears.contains(&BodyMetricField::WaistCm))
        || (input.note.is_some() && clears.contains(&BodyMetricField::Note));
    if conflicting {
        return Err(AppError::validation(
            "workout.body.patch",
            "a field cannot be both set and cleared",
        ));
    }
    if input.weight_kg.is_none()
        && input.body_fat_pct.is_none()
        && input.skeletal_muscle_kg.is_none()
        && input.waist_cm.is_none()
        && clears.is_empty()
    {
        return Err(AppError::validation(
            "workout.body.empty",
            "at least one measurement is required",
        ));
    }

    let mut tx = db.begin().await?;
    // 하루 한 행 — 같은 날 재측정은 갱신(UNIQUE(measured_on)). 값이 없는 축은 기존 값을 유지해
    // "체중만 다시 재는" 흔한 경우가 체지방률을 지우지 않게 한다.
    //
    // `source`는 갱신한다: 사람이 값을 덮어썼으면 그 행의 출처는 이제 manual이다
    // (seed 행에 손으로 70kg을 써넣고 source='seed'로 남기면 provenance가 거짓말을 한다).
    // foods의 "UPDATE는 provenance 보존"과 반대인 이유 — 저기선 식품 **정체성**의 출처였고
    // 여기선 측정 **값**의 출처다.
    sqlx::query(
        "INSERT INTO body_metrics \
           (id, measured_on, weight_kg, body_fat_pct, skeletal_muscle_kg, waist_cm, note, source) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'manual') \
         ON CONFLICT (measured_on) DO UPDATE SET \
           weight_kg = COALESCE(excluded.weight_kg, body_metrics.weight_kg), \
           body_fat_pct = COALESCE(excluded.body_fat_pct, body_metrics.body_fat_pct), \
           skeletal_muscle_kg = \
             COALESCE(excluded.skeletal_muscle_kg, body_metrics.skeletal_muscle_kg), \
           waist_cm = COALESCE(excluded.waist_cm, body_metrics.waist_cm), \
           note = COALESCE(excluded.note, body_metrics.note), \
           source = 'manual'",
    )
    .bind(new_id())
    .bind(&measured_on)
    .bind(input.weight_kg)
    .bind(input.body_fat_pct)
    .bind(input.skeletal_muscle_kg)
    .bind(input.waist_cm)
    .bind(clean_optional(input.note).as_deref())
    .execute(&mut *tx)
    .await?;

    // 명시적으로 지정한 축만 비운다(오기입 정정) — 같은 tx라 부분 적용이 남지 않는다.
    for field in clears {
        let column = match field {
            BodyMetricField::WeightKg => "weight_kg",
            BodyMetricField::BodyFatPct => "body_fat_pct",
            BodyMetricField::SkeletalMuscleKg => "skeletal_muscle_kg",
            BodyMetricField::WaistCm => "waist_cm",
            BodyMetricField::Note => "note",
        };
        sqlx::query(&format!(
            "UPDATE body_metrics SET {column} = NULL WHERE measured_on = ?1"
        ))
        .bind(&measured_on)
        .execute(&mut *tx)
        .await?;
    }

    let row = sqlx::query_as::<_, BodyMetric>(&format!(
        "SELECT {METRIC_COLS} FROM body_metrics WHERE measured_on = ?1"
    ))
    .bind(&measured_on)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub(crate) async fn delete_body_metric_inner(db: &Db, id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM body_metrics WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn body_trend_inner(db: &Db, limit: Option<i32>) -> Result<BodyTrend, AppError> {
    let limit = limit.unwrap_or(60).clamp(1, 730);
    // 최신 우선으로 뽑아 커널(최신 우선 전제)에 넘기고, 그래프용 history는 뒤집어 돌려준다.
    let newest_first = sqlx::query_as::<_, BodyMetric>(&format!(
        "SELECT {METRIC_COLS} FROM body_metrics ORDER BY measured_on DESC LIMIT ?1"
    ))
    .bind(limit)
    .fetch_all(db)
    .await?;

    let weights: Vec<f64> = newest_first.iter().filter_map(|m| m.weight_kg).collect();
    let weight_trend_kg = workout::weight_trend_kg(&weights, WEIGHT_TREND_WINDOW);
    let latest = newest_first.first().cloned();
    let mut history = newest_first;
    history.reverse();

    Ok(BodyTrend {
        latest,
        weight_trend_kg,
        history,
    })
}

pub(crate) async fn body_profile_inner(db: &Db) -> Result<BodyProfile, AppError> {
    match sqlx::query_as::<_, BodyProfile>(
        "SELECT birth_year, height_cm, sex, updated_at FROM body_profile WHERE id = 'singleton'",
    )
    .fetch_optional(db)
    .await?
    {
        Some(profile) => Ok(profile),
        // 행이 없으면 빈 프로필 — BMR은 None이 되고 UI가 "프로필 필요"를 노출한다.
        None => Ok(BodyProfile {
            birth_year: None,
            height_cm: None,
            sex: None,
            updated_at: String::new(),
        }),
    }
}

pub(crate) async fn set_body_profile_inner(
    db: &Db,
    input: SetBodyProfileInput,
) -> Result<BodyProfile, AppError> {
    if let Some(height) = input.height_cm {
        validate_positive(height, "workout.profile.height")?;
    }
    if let Some(year) = input.birth_year {
        if year <= 1900 || year >= 2200 {
            return Err(AppError::validation(
                "workout.profile.birth_year",
                "birthYear looks wrong",
            ));
        }
    }
    let sex = clean_optional(input.sex);
    if let Some(sex) = sex.as_deref() {
        if !matches!(sex, "male" | "female" | "other") {
            return Err(AppError::validation(
                "workout.profile.sex",
                "sex must be male / female / other",
            ));
        }
    }

    // 주지 않은 필드는 **기존 값을 유지**한다(COALESCE). 그냥 덮어쓰면 성별만 설정하려던
    // 호출이 생년·키를 조용히 지워 BMR이 None으로 떨어진다 — body_metrics의 축 보존과 같은 계약.
    // 한번 채운 값을 다시 비우는 경로는 없다(그럴 상황이 없다 — 키·생년은 변하지 않는다).
    sqlx::query(
        "INSERT INTO body_profile (id, birth_year, height_cm, sex) \
         VALUES ('singleton', ?1, ?2, ?3) \
         ON CONFLICT (id) DO UPDATE SET \
           birth_year = COALESCE(?1, body_profile.birth_year), \
           height_cm = COALESCE(?2, body_profile.height_cm), \
           sex = COALESCE(?3, body_profile.sex), \
           updated_at = datetime('now')",
    )
    .bind(input.birth_year)
    .bind(input.height_cm)
    .bind(sex.as_deref())
    .execute(db)
    .await?;
    body_profile_inner(db).await
}

/// 하루 에너지 수지 — 섭취(meal_logs) − (BMR + 운동 소모). 전부 read-only 파생이다.
pub(crate) async fn daily_energy_balance_inner(
    db: &Db,
    date: &str,
) -> Result<DailyEnergyBalance, AppError> {
    let date = validate_date(date, "workout.energy.date")?;
    let mut conn = db.acquire().await?;

    // COALESCE 기본값은 `0.0` — `0`이면 SQLite가 INTEGER를 돌려주고 f64 디코드가 깨진다.
    let intake_kcal: f64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(kcal), 0.0) FROM meal_logs WHERE date = ?1")
            .bind(&date)
            .fetch_one(&mut *conn)
            .await?;

    let weight_kg = super::sessions::weight_on_or_before(&mut conn, &date).await?;
    let sessions = super::sessions::list_workout_sessions_inner(db, &date, &date).await?;
    let workout_kcal: f64 = sessions.iter().map(|s| s.energy_kcal).sum();

    let profile = body_profile_inner(db).await?;
    let year: i32 = date
        .get(0..4)
        .and_then(|y| y.parse().ok())
        .ok_or_else(|| AppError::validation("workout.energy.date", "date must be YYYY-MM-DD"))?;
    let bmr = workout::bmr_kcal(&profile, weight_kg, year);

    Ok(DailyEnergyBalance {
        date,
        balance: workout::energy_balance(intake_kcal, bmr, workout_kcal),
        weight_kg,
        session_count: sessions.len() as i32,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn record_body_metric(
    db: State<'_, Db>,
    input: RecordBodyMetricInput,
) -> Result<BodyMetric, AppError> {
    record_body_metric_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_body_metric(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_body_metric_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn body_trend(db: State<'_, Db>, limit: Option<i32>) -> Result<BodyTrend, AppError> {
    body_trend_inner(db.inner(), limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_body_profile(db: State<'_, Db>) -> Result<BodyProfile, AppError> {
    body_profile_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_body_profile(
    db: State<'_, Db>,
    input: SetBodyProfileInput,
) -> Result<BodyProfile, AppError> {
    set_body_profile_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn daily_energy_balance(
    db: State<'_, Db>,
    date: String,
) -> Result<DailyEnergyBalance, AppError> {
    daily_energy_balance_inner(db.inner(), &date).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    fn metric(measured_on: &str, weight: Option<f64>) -> RecordBodyMetricInput {
        RecordBodyMetricInput {
            measured_on: measured_on.into(),
            weight_kg: weight,
            body_fat_pct: None,
            skeletal_muscle_kg: None,
            waist_cm: None,
            note: None,
            clear: vec![],
        }
    }

    #[tokio::test]
    async fn migration_seeds_the_users_profile_and_first_weight() {
        let db = fresh_db().await;
        let profile = body_profile_inner(&db).await.unwrap();
        assert_eq!(profile.birth_year, Some(1987));
        assert_eq!(profile.height_cm, Some(171.0));
        assert_eq!(profile.sex.as_deref(), Some("male"));

        let trend = body_trend_inner(&db, None).await.unwrap();
        let latest = trend.latest.expect("seed 측정값");
        assert_eq!(latest.measured_on, "2026-07-26");
        assert_eq!(latest.weight_kg, Some(69.0));
        assert_eq!(latest.source, "seed");
    }

    #[tokio::test]
    async fn same_day_remeasure_updates_without_wiping_other_axes() {
        let db = fresh_db().await;
        record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-27".into(),
                weight_kg: Some(69.5),
                body_fat_pct: Some(18.0),
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: Some("아침".into()),
                clear: vec![],
            },
        )
        .await
        .unwrap();

        // 체중만 다시 재는 흔한 경우 — 체지방률이 지워지면 안 된다.
        let after = record_body_metric_inner(&db, metric("2026-07-27", Some(69.1)))
            .await
            .unwrap();
        assert_eq!(after.weight_kg, Some(69.1));
        assert_eq!(after.body_fat_pct, Some(18.0), "다른 축 보존");
        assert_eq!(after.note.as_deref(), Some("아침"));

        let rows: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM body_metrics WHERE measured_on = ?1")
                .bind("2026-07-27")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(rows.0, 1, "하루 한 행");
    }

    #[tokio::test]
    async fn a_mistyped_axis_can_be_cleared_without_losing_the_others() {
        // critic 지적 회귀 가드: COALESCE 보존만 있으면 오기입한 체지방률을 지울 방법이 없고,
        // 유일한 대안인 행 삭제는 정상 체중까지 잃는다.
        let db = fresh_db().await;
        record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-27".into(),
                weight_kg: Some(69.5),
                body_fat_pct: Some(88.0), // 오기입
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: None,
                clear: vec![],
            },
        )
        .await
        .unwrap();

        let fixed = record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-27".into(),
                weight_kg: None,
                body_fat_pct: None,
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: None,
                clear: vec![BodyMetricField::BodyFatPct],
            },
        )
        .await
        .unwrap();
        assert_eq!(fixed.body_fat_pct, None, "오기입 축만 비워진다");
        assert_eq!(fixed.weight_kg, Some(69.5), "정상 축은 남는다");

        // 값과 clear를 동시에 주는 모순 입력은 거부.
        assert!(record_body_metric_inner(
            &db,
            RecordBodyMetricInput {
                measured_on: "2026-07-27".into(),
                weight_kg: Some(70.0),
                body_fat_pct: None,
                skeletal_muscle_kg: None,
                waist_cm: None,
                note: None,
                clear: vec![BodyMetricField::WeightKg],
            },
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn overwriting_a_seeded_row_moves_its_provenance_to_manual() {
        // critic 지적: 값이 사람 손으로 바뀌었는데 source='seed'로 남으면 provenance가 거짓말.
        let db = fresh_db().await;
        let before: (String,) =
            sqlx::query_as("SELECT source FROM body_metrics WHERE measured_on = '2026-07-26'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(before.0, "seed");

        let after = record_body_metric_inner(&db, metric("2026-07-26", Some(70.0)))
            .await
            .unwrap();
        assert_eq!(after.weight_kg, Some(70.0));
        assert_eq!(after.source, "manual", "값의 출처가 사람으로 바뀌었다");
    }

    #[tokio::test]
    async fn empty_measurement_is_rejected() {
        let db = fresh_db().await;
        let err = record_body_metric_inner(&db, metric("2026-07-27", None))
            .await
            .expect_err("빈 측정 거부");
        assert!(format!("{err:?}").contains("at least one"));
    }

    #[tokio::test]
    async fn trend_is_the_recent_average_and_history_runs_oldest_first() {
        let db = fresh_db().await;
        // seed(2026-07-26, 69.0) + 3일치.
        record_body_metric_inner(&db, metric("2026-07-27", Some(70.0)))
            .await
            .unwrap();
        record_body_metric_inner(&db, metric("2026-07-28", Some(71.0)))
            .await
            .unwrap();

        let trend = body_trend_inner(&db, None).await.unwrap();
        assert_eq!(trend.latest.as_ref().unwrap().measured_on, "2026-07-28");
        assert!((trend.weight_trend_kg.unwrap() - (69.0 + 70.0 + 71.0) / 3.0).abs() < 1e-9);
        assert_eq!(
            trend
                .history
                .iter()
                .map(|m| m.measured_on.as_str())
                .collect::<Vec<_>>(),
            vec!["2026-07-26", "2026-07-27", "2026-07-28"],
            "그래프용 history는 오래된 → 최신"
        );
    }

    #[tokio::test]
    async fn profile_validation_rejects_impossible_values() {
        let db = fresh_db().await;
        assert!(set_body_profile_inner(
            &db,
            SetBodyProfileInput {
                birth_year: Some(1600),
                height_cm: Some(171.0),
                sex: Some("male".into()),
            }
        )
        .await
        .is_err());
        assert!(set_body_profile_inner(
            &db,
            SetBodyProfileInput {
                birth_year: Some(1987),
                height_cm: Some(0.0),
                sex: Some("male".into()),
            }
        )
        .await
        .is_err());
        assert!(set_body_profile_inner(
            &db,
            SetBodyProfileInput {
                birth_year: Some(1987),
                height_cm: Some(171.0),
                sex: Some("남성".into()),
            }
        )
        .await
        .is_err());

        let ok = set_body_profile_inner(
            &db,
            SetBodyProfileInput {
                birth_year: Some(1990),
                height_cm: Some(175.0),
                sex: Some("other".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(ok.birth_year, Some(1990));
        assert_eq!(ok.sex.as_deref(), Some("other"));
    }

    #[tokio::test]
    async fn partial_profile_update_preserves_the_other_bmr_inputs() {
        let db = fresh_db().await;
        // 성별만 바꾸려는 호출이 생년·키를 지우면 BMR이 조용히 None으로 떨어진다.
        let after = set_body_profile_inner(
            &db,
            SetBodyProfileInput {
                birth_year: None,
                height_cm: None,
                sex: Some("other".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(after.birth_year, Some(1987), "seed 생년 보존");
        assert_eq!(after.height_cm, Some(171.0), "seed 키 보존");
        assert_eq!(after.sex.as_deref(), Some("other"));

        let balance = daily_energy_balance_inner(&db, "2026-07-26").await.unwrap();
        assert!(balance.balance.bmr_available, "BMR이 계속 계산된다");
    }

    #[tokio::test]
    async fn energy_balance_combines_intake_bmr_and_workout() {
        let db = fresh_db().await;
        let food =
            crate::commands::diet::foods::test_support::seed_food(&db, "밥", 130.0, 2.5).await;
        crate::commands::diet::logs::record_meal_log_inner(
            &db,
            crate::models::RecordMealLogInput {
                date: "2026-07-26".into(),
                at: None,
                planned_meal_id: None,
                ratio: None,
                recipe_id: None,
                servings: None,
                food_id: Some(food),
                qty_g: Some(1000.0),
                manual: None,
                description: None,
                satisfaction: None,
                fullness: None,
                note: None,
            },
        )
        .await
        .unwrap();

        let balance = daily_energy_balance_inner(&db, "2026-07-26").await.unwrap();
        assert!((balance.balance.intake_kcal - 1300.0).abs() < 1e-9);
        // seed 프로필(1987/171/male) + seed 체중 69kg, 2026년 → BMR 1568.75.
        assert!(balance.balance.bmr_available);
        assert!((balance.balance.bmr_kcal.unwrap() - 1568.75).abs() < 1e-9);
        assert_eq!(balance.balance.workout_kcal, 0.0, "운동 기록 없음");
        assert!((balance.balance.balance_kcal - (1300.0 - 1568.75)).abs() < 1e-9);
        assert_eq!(balance.weight_kg, Some(69.0));
        assert_eq!(balance.session_count, 0);
    }

    #[tokio::test]
    async fn energy_balance_says_so_when_the_profile_is_incomplete() {
        let db = fresh_db().await;
        // 프로필을 비운다 — BMR을 추정하지 않고 없다고 말해야 한다.
        sqlx::query(
            "UPDATE body_profile SET birth_year = NULL, height_cm = NULL WHERE id = 'singleton'",
        )
        .execute(&db)
        .await
        .unwrap();
        let balance = daily_energy_balance_inner(&db, "2026-07-26").await.unwrap();
        assert!(!balance.balance.bmr_available);
        assert_eq!(balance.balance.bmr_kcal, None);
        assert_eq!(balance.balance.intake_kcal, 0.0);
        assert_eq!(balance.balance.balance_kcal, 0.0);
    }
}
