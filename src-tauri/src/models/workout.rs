//! Workout 도메인 타입 (docs/plans/2026-07-26-recipe-authoring-workout.md §8).
//!
//! 이 도메인은 **실적 기록 + 체성분**만 소유한다 — 계획·스케줄은 `routines`가 이미 한다.
//! 파생값(볼륨·1RM·소모 kcal·BMR·에너지 밸런스)은 저장하지 않고 쿼리타임 커널 계산이다.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ExerciseModality {
    Strength,
    Cardio,
    Mobility,
    Sport,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Exercise {
    pub id: String,
    pub name: String,
    pub modality: ExerciseModality,
    pub primary_muscle: Option<String>,
    pub equipment: Option<String>,
    /// MET 계수 — 소모 kcal = MET × 체중kg × 시간h. None이면 소모를 계산하지 않는다(0).
    pub met: Option<f64>,
    pub source: String,
    pub source_ref: Option<String>,
    pub archived: bool,
    pub aliases: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertExerciseInput {
    /// None = 새 종목 생성, Some = 갱신.
    pub id: Option<String>,
    pub name: String,
    pub modality: ExerciseModality,
    pub primary_muscle: Option<String>,
    pub equipment: Option<String>,
    pub met: Option<f64>,
    pub source: Option<String>,
    pub source_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutSet {
    pub id: String,
    pub session_id: String,
    pub exercise_id: String,
    pub exercise_name: String,
    pub modality: ExerciseModality,
    /// 1-based 표시 번호 — 쿼리타임 파생.
    pub set_no: i32,
    pub sort_rank: i32,
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
    pub rest_sec: Option<i32>,
    pub rpe: Option<i32>,
    pub note: Option<String>,
    /// Epley 추정 1RM — 저장 안 함(커널 파생).
    pub estimated_1rm_kg: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddWorkoutSetInput {
    pub session_id: String,
    pub exercise_id: String,
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
    pub rest_sec: Option<i32>,
    pub rpe: Option<i32>,
    pub note: Option<String>,
}

/// 세트 부분 수정 — 준 필드만 바뀐다. nullable 축을 비우려면 `clear`에 넣는다
/// (`Option<Option<T>>`는 specta가 TS로 내리지 못한다).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchWorkoutSetInput {
    pub id: String,
    pub exercise_id: Option<String>,
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
    pub rest_sec: Option<i32>,
    pub rpe: Option<i32>,
    pub note: Option<String>,
    #[serde(default)]
    pub clear: Vec<WorkoutSetField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkoutSetField {
    Reps,
    WeightKg,
    DurationSec,
    DistanceM,
    RestSec,
    Rpe,
    Note,
}

/// 세션 볼륨 — 전부 커널 파생(저장 컬럼 아님).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutVolume {
    pub set_count: i32,
    pub total_reps: i32,
    /// 톤수 = Σ(reps × weight). 맨몸 세트는 0으로 기여한다.
    pub volume_kg: f64,
    pub duration_sec: i32,
    pub distance_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutSession {
    pub id: String,
    pub date: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub title: Option<String>,
    pub perceived_exertion: Option<i32>,
    pub note: Option<String>,
    pub sets: Vec<WorkoutSet>,
    pub volume: WorkoutVolume,
    /// MET × 그 날 체중 × 세트 시간 합. MET/체중이 없으면 0(추정하지 않는다).
    pub energy_kcal: f64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartWorkoutSessionInput {
    /// 로컬 날짜(호출자 주입) 'YYYY-MM-DD'.
    pub date: String,
    pub started_at: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatchWorkoutSessionInput {
    pub id: String,
    pub date: Option<String>,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub perceived_exertion: Option<i32>,
    pub note: Option<String>,
    #[serde(default)]
    pub clear: Vec<WorkoutSessionField>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkoutSessionField {
    Title,
    StartedAt,
    EndedAt,
    PerceivedExertion,
    Note,
}

/// 종목별 최고 기록(추정 1RM 기준) — 쿼리타임 파생.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExercisePersonalRecord {
    pub exercise_id: String,
    pub exercise_name: String,
    pub best_1rm_kg: Option<f64>,
    pub best_weight_kg: Option<f64>,
    pub best_reps: Option<i32>,
    pub achieved_on: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkoutVolumeSummary {
    pub from: String,
    pub to: String,
    pub session_count: i32,
    pub volume: WorkoutVolume,
    pub energy_kcal: f64,
    /// 종목별 톤수 상위(내림차순).
    pub by_exercise: Vec<ExerciseVolumeRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExerciseVolumeRow {
    pub exercise_id: String,
    pub exercise_name: String,
    pub set_count: i32,
    pub volume_kg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BodyMetric {
    pub id: String,
    pub measured_on: String,
    pub weight_kg: Option<f64>,
    pub body_fat_pct: Option<f64>,
    pub skeletal_muscle_kg: Option<f64>,
    pub waist_cm: Option<f64>,
    pub note: Option<String>,
    pub source: String,
    pub created_at: String,
}

/// 잘못 기록한 축을 지울 수 있는 필드. 생략한 축은 **보존**되므로(체중만 다시 재는 흔한 경우),
/// 오기입을 없애려면 이 목록으로 명시해야 한다 — 행 전체 삭제는 정상 축까지 잃는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BodyMetricField {
    WeightKg,
    BodyFatPct,
    SkeletalMuscleKg,
    WaistCm,
    Note,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordBodyMetricInput {
    /// 측정일 'YYYY-MM-DD'. 같은 날 재측정은 갱신(하루 한 행) — 생략한 축은 기존 값 보존.
    pub measured_on: String,
    pub weight_kg: Option<f64>,
    pub body_fat_pct: Option<f64>,
    pub skeletal_muscle_kg: Option<f64>,
    pub waist_cm: Option<f64>,
    pub note: Option<String>,
    /// 비울 축(오기입 정정). 같은 축을 값과 clear로 동시에 주면 검증 오류.
    #[serde(default)]
    pub clear: Vec<BodyMetricField>,
}

/// 변하지 않는 신체 정보(BMR 입력). 단일 행.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BodyProfile {
    pub birth_year: Option<i32>,
    pub height_cm: Option<f64>,
    /// 'male' | 'female' | 'other' | None. None/other는 BMR에서 두 식의 중간값을 쓴다.
    pub sex: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBodyProfileInput {
    pub birth_year: Option<i32>,
    pub height_cm: Option<f64>,
    pub sex: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BodyTrend {
    pub latest: Option<BodyMetric>,
    /// 최근 7개 측정 이동평균(kg) — 일별 노이즈 제거.
    pub weight_trend_kg: Option<f64>,
    /// 오래된 → 최신 순 시계열(그래프용).
    pub history: Vec<BodyMetric>,
}

/// 하루 에너지 수지 — **read-only 파생**. 이 값이 `diet_goals`를 자동으로 바꾸지 않는다
/// (결정레일 INVARIANT #1: 파생 판단값을 자동 설정하지 않는다).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnergyBalance {
    pub intake_kcal: f64,
    /// 프로필/체중이 없으면 None — 추정치를 채우지 않는다.
    pub bmr_kcal: Option<f64>,
    pub workout_kcal: f64,
    pub expenditure_kcal: f64,
    pub balance_kcal: f64,
    /// false면 BMR 없이 "섭취 − 운동소모"까지만 계산된 값이다.
    pub bmr_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DailyEnergyBalance {
    pub date: String,
    pub balance: EnergyBalance,
    pub weight_kg: Option<f64>,
    pub session_count: i32,
}
