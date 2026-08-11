//! Workout 툴 — **사용자 발주(2026-07-26)로 운동 도메인 실적 기록 전권을 에이전트에 위임**:
//! "추가 아이디어가 있다면(식단 관리 및 운동) 제안해서 작업해봐" + 풀스택 선택.
//!
//! 결정레일 논증: 이 도메인의 write는 전부 **관측 사실**(했다/이만큼 들었다/체중이 이렇다)이고
//! 로컬 SQLite뿐이다(외부 mutate 0 — INVARIANT #2 비대상). 사람 게이트는 ADR-0012대로 각 MCP
//! 호스트의 승인 UI다.
//!
//! 표면에 **없는** 것이 경계를 만든다:
//! - **계획/스케줄 툴 없음.** "무엇을 언제 할 것인가"는 `routines`가 소유한다 — 여기에 계획
//!   표면을 열면 같은 운동을 두 곳에서 트래킹하게 된다.
//! - **`diet_goals` mutate 능력 없음.** 활동량이 칼로리 목표를 자동으로 바꾸지 않는다
//!   (파생 판단값 자동 설정 = INVARIANT #1 위반). 연동은 `wr_workout_energy_balance`
//!   read-only 파생뿐이다.
//! - **세션 삭제 없음.** 되돌릴 수 없는 삭제는 앱 UI confirm 전용.

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::commands::workout as workout_commands;
use crate::mcp::{mcp_tool_error, parse_iso_date, truncate_preview, WrServer};
use crate::models::{
    AddWorkoutSetInput, ExerciseModality, PatchWorkoutSessionInput, PatchWorkoutSetInput,
    RecordBodyMetricInput, SetBodyProfileInput, StartWorkoutSessionInput, UpsertExerciseInput,
};

const NOTE_MAX_CHARS: usize = 500;
const NAME_MAX_CHARS: usize = 120;
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

// ── 파라미터 ─────────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ExerciseModalityParam {
    Strength,
    Cardio,
    Mobility,
    Sport,
}

impl From<ExerciseModalityParam> for ExerciseModality {
    fn from(v: ExerciseModalityParam) -> Self {
        match v {
            ExerciseModalityParam::Strength => ExerciseModality::Strength,
            ExerciseModalityParam::Cardio => ExerciseModality::Cardio,
            ExerciseModalityParam::Mobility => ExerciseModality::Mobility,
            ExerciseModalityParam::Sport => ExerciseModality::Sport,
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutRangeParams {
    /// 시작일 YYYY-MM-DD.
    pub from: String,
    /// 종료일 YYYY-MM-DD(포함).
    pub to: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutSessionIdParams {
    pub session_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutSearchParams {
    /// 이름/별칭 부분 일치(생략 = 전체).
    pub query: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutTrendParams {
    /// 최근 몇 개 측정(기본 60, 상한 730).
    pub limit: Option<i32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutDateParams {
    /// 로컬 날짜 YYYY-MM-DD.
    pub date: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutStartSessionParams {
    /// 운동한 날짜 YYYY-MM-DD. **계획이 아니라 실적이다** — 미래 날짜로 예약하는 용도가 아니다.
    pub date: String,
    /// 시작 시각 RFC3339(선택).
    pub started_at: Option<String>,
    /// 세션 제목(예: "하체", "상체 A"). ≤120자.
    pub title: Option<String>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutPatchSessionParams {
    pub session_id: String,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    /// 체감 강도 1..10(선택).
    pub perceived_exertion: Option<i32>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutAddSetParams {
    pub session_id: String,
    pub exercise_id: String,
    /// 근력: reps(+weight_kg). 유산소: duration_sec(+distance_m).
    /// reps / duration_sec / distance_m 중 **최소 하나**는 필요하다(무게만으로는 무엇을 했는지 모른다).
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
    pub rest_sec: Option<i32>,
    /// 세트 RPE 1..10(선택).
    pub rpe: Option<i32>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutPatchSetParams {
    /// 세트 행 id(`wr_workout_session`의 `sets[].id`).
    pub set_id: String,
    pub exercise_id: Option<String>,
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
    pub rest_sec: Option<i32>,
    pub rpe: Option<i32>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutSetIdParams {
    pub set_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutUpsertExerciseParams {
    /// 있으면 그 종목 갱신, 없으면 새로 만든다.
    pub id: Option<String>,
    pub name: String,
    pub modality: ExerciseModalityParam,
    pub primary_muscle: Option<String>,
    pub equipment: Option<String>,
    /// MET 계수 — 소모 kcal = MET × 체중 × 시간. 없으면 소모를 0으로 둔다(추정하지 않는다).
    pub met: Option<f64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutBodyMetricParams {
    /// 측정일 YYYY-MM-DD. 같은 날 재측정은 갱신되고, 주지 않은 축은 기존 값이 유지된다.
    pub measured_on: String,
    pub weight_kg: Option<f64>,
    pub body_fat_pct: Option<f64>,
    pub skeletal_muscle_kg: Option<f64>,
    pub waist_cm: Option<f64>,
    pub note: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WorkoutBodyProfileParams {
    pub birth_year: Option<i32>,
    pub height_cm: Option<f64>,
    /// 'male' | 'female' | 'other'.
    pub sex: Option<String>,
}

// ── DTO ──────────────────────────────────────────────────────────

#[derive(Serialize, JsonSchema)]
pub struct WorkoutVolumeDto {
    pub set_count: i32,
    pub total_reps: i32,
    /// 톤수 = Σ(reps × weight). 맨몸 세트는 0으로 기여한다.
    pub volume_kg: f64,
    pub duration_sec: i32,
    pub distance_m: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutSetDto {
    /// patch/remove 툴의 `set_id`로 그대로 넘긴다.
    pub id: String,
    pub set_no: i32,
    pub exercise_id: String,
    pub exercise_name: String,
    pub reps: Option<i32>,
    pub weight_kg: Option<f64>,
    pub duration_sec: Option<i32>,
    pub distance_m: Option<f64>,
    pub rpe: Option<i32>,
    /// Epley 추정 1RM(파생 — 저장값 아님).
    pub estimated_1rm_kg: Option<f64>,
    pub note: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutSessionDto {
    pub id: String,
    pub date: String,
    pub title: Option<String>,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub perceived_exertion: Option<i32>,
    pub note: Option<String>,
    pub sets: Vec<WorkoutSetDto>,
    pub volume: WorkoutVolumeDto,
    /// MET × 그 날(또는 그 이전 최근) 체중 × 시간. MET/체중이 없으면 0.
    pub energy_kcal: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutSessionSummaryDto {
    pub id: String,
    pub date: String,
    pub title: Option<String>,
    pub set_count: i32,
    pub volume_kg: f64,
    pub energy_kcal: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutSessionListDto {
    pub sessions: Vec<WorkoutSessionSummaryDto>,
    pub truncated: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct ExerciseVolumeRowDto {
    pub exercise_id: String,
    pub exercise_name: String,
    pub set_count: i32,
    pub volume_kg: f64,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutVolumeSummaryDto {
    pub from: String,
    pub to: String,
    pub session_count: i32,
    pub volume: WorkoutVolumeDto,
    pub energy_kcal: f64,
    /// 종목별 톤수 내림차순.
    pub by_exercise: Vec<ExerciseVolumeRowDto>,
    pub personal_records: Vec<ExerciseRecordDto>,
}

#[derive(Serialize, JsonSchema)]
pub struct ExerciseRecordDto {
    pub exercise_id: String,
    pub exercise_name: String,
    pub best_1rm_kg: Option<f64>,
    pub best_weight_kg: Option<f64>,
    pub best_reps: Option<i32>,
    pub achieved_on: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct ExerciseDto {
    pub id: String,
    pub name: String,
    /// 'strength' | 'cardio' | 'mobility' | 'sport'
    pub modality: String,
    pub primary_muscle: Option<String>,
    pub equipment: Option<String>,
    pub met: Option<f64>,
    pub aliases: Vec<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct ExerciseListDto {
    pub exercises: Vec<ExerciseDto>,
    pub truncated: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct BodyMetricDto {
    pub id: String,
    pub measured_on: String,
    pub weight_kg: Option<f64>,
    pub body_fat_pct: Option<f64>,
    pub skeletal_muscle_kg: Option<f64>,
    pub waist_cm: Option<f64>,
}

#[derive(Serialize, JsonSchema)]
pub struct BodyTrendDto {
    pub latest: Option<BodyMetricDto>,
    /// 최근 7개 측정 이동평균(kg) — 일별 노이즈 제거.
    pub weight_trend_kg: Option<f64>,
    /// 오래된 → 최신.
    pub history: Vec<BodyMetricDto>,
    pub birth_year: Option<i32>,
    pub height_cm: Option<f64>,
    pub sex: Option<String>,
}

#[derive(Serialize, JsonSchema)]
pub struct EnergyBalanceDto {
    pub date: String,
    pub intake_kcal: f64,
    /// 프로필(생년/키)이나 체중이 없으면 null — 추정치를 채우지 않는다.
    pub bmr_kcal: Option<f64>,
    pub workout_kcal: f64,
    pub expenditure_kcal: f64,
    pub balance_kcal: f64,
    /// false면 BMR 없이 "섭취 − 운동소모"까지만 계산된 값이다.
    pub bmr_available: bool,
    pub weight_kg: Option<f64>,
    pub session_count: i32,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutOkDto {
    pub ok: bool,
}

#[derive(Serialize, JsonSchema)]
pub struct WorkoutIdDto {
    pub id: String,
}

fn volume_dto(v: &crate::models::WorkoutVolume) -> WorkoutVolumeDto {
    WorkoutVolumeDto {
        set_count: v.set_count,
        total_reps: v.total_reps,
        volume_kg: v.volume_kg,
        duration_sec: v.duration_sec,
        distance_m: v.distance_m,
    }
}

fn session_dto(s: crate::models::WorkoutSession) -> WorkoutSessionDto {
    WorkoutSessionDto {
        volume: volume_dto(&s.volume),
        sets: s
            .sets
            .iter()
            .map(|set| WorkoutSetDto {
                id: set.id.clone(),
                set_no: set.set_no,
                exercise_id: set.exercise_id.clone(),
                exercise_name: truncate_preview(&set.exercise_name, NAME_MAX_CHARS),
                reps: set.reps,
                weight_kg: set.weight_kg,
                duration_sec: set.duration_sec,
                distance_m: set.distance_m,
                rpe: set.rpe,
                estimated_1rm_kg: set.estimated_1rm_kg,
                note: set.note.clone(),
            })
            .collect(),
        id: s.id,
        date: s.date,
        title: s.title.map(|t| truncate_preview(&t, NAME_MAX_CHARS)),
        started_at: s.started_at,
        ended_at: s.ended_at,
        perceived_exertion: s.perceived_exertion,
        note: s.note,
        energy_kcal: s.energy_kcal,
    }
}

fn metric_dto(m: &crate::models::BodyMetric) -> BodyMetricDto {
    BodyMetricDto {
        id: m.id.clone(),
        measured_on: m.measured_on.clone(),
        weight_kg: m.weight_kg,
        body_fat_pct: m.body_fat_pct,
        skeletal_muscle_kg: m.skeletal_muscle_kg,
        waist_cm: m.waist_cm,
    }
}

/// serde snake_case 표현을 문자열 토큰으로 — DTO가 enum 이름을 손으로 베끼지 않게 한다.
fn enum_token<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[tool_router(router = tool_router_workout, vis = "pub(crate)")]
impl WrServer {
    // ── read ────────────────────────────────────────────────────

    #[tool(
        name = "wr_workout_recent_sessions",
        description = "Workout sessions in a date range (newest first) with set counts, tonnage and estimated energy burn. These are records of what was actually done — planning lives in routines. Read-only."
    )]
    pub async fn workout_recent_sessions(
        &self,
        Parameters(p): Parameters<WorkoutRangeParams>,
    ) -> Result<Json<WorkoutSessionListDto>, rmcp::ErrorData> {
        self.workout_recent_sessions_inner(p).await
    }

    pub(crate) async fn workout_recent_sessions_inner(
        &self,
        p: WorkoutRangeParams,
    ) -> Result<Json<WorkoutSessionListDto>, rmcp::ErrorData> {
        let from = parse_iso_date(&p.from)?.to_string();
        let to = parse_iso_date(&p.to)?.to_string();
        let sessions = workout_commands::list_workout_sessions_inner(&self.db, &from, &to)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_recent_sessions", &e))?;
        let truncated = sessions.len() > LIST_LIMIT;
        Ok(Json(WorkoutSessionListDto {
            sessions: sessions
                .into_iter()
                .take(LIST_LIMIT)
                .map(|s| WorkoutSessionSummaryDto {
                    id: s.id,
                    date: s.date,
                    title: s.title.map(|t| truncate_preview(&t, NAME_MAX_CHARS)),
                    set_count: s.volume.set_count,
                    volume_kg: s.volume.volume_kg,
                    energy_kcal: s.energy_kcal,
                })
                .collect(),
            truncated,
        }))
    }

    #[tool(
        name = "wr_workout_session",
        description = "One workout session in full: every set with its row id (pass as set_id to patch/remove), 1-based set numbers, and derived 1RM estimates. Read-only."
    )]
    pub async fn workout_session(
        &self,
        Parameters(p): Parameters<WorkoutSessionIdParams>,
    ) -> Result<Json<WorkoutSessionDto>, rmcp::ErrorData> {
        self.workout_session_inner(p).await
    }

    pub(crate) async fn workout_session_inner(
        &self,
        p: WorkoutSessionIdParams,
    ) -> Result<Json<WorkoutSessionDto>, rmcp::ErrorData> {
        let session = workout_commands::fetch_session(&self.db, &p.session_id)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_session", &e))?;
        Ok(Json(session_dto(session)))
    }

    #[tool(
        name = "wr_workout_volume_summary",
        description = "Training volume over a date range: total sets/reps/tonnage per exercise plus best estimated 1RM per exercise. Read-only."
    )]
    pub async fn workout_volume_summary(
        &self,
        Parameters(p): Parameters<WorkoutRangeParams>,
    ) -> Result<Json<WorkoutVolumeSummaryDto>, rmcp::ErrorData> {
        self.workout_volume_summary_inner(p).await
    }

    pub(crate) async fn workout_volume_summary_inner(
        &self,
        p: WorkoutRangeParams,
    ) -> Result<Json<WorkoutVolumeSummaryDto>, rmcp::ErrorData> {
        let from = parse_iso_date(&p.from)?.to_string();
        let to = parse_iso_date(&p.to)?.to_string();
        let summary = workout_commands::workout_volume_summary_inner(&self.db, &from, &to)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_volume_summary", &e))?;
        let records = workout_commands::exercise_personal_records_inner(&self.db, None)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_volume_summary", &e))?;
        Ok(Json(WorkoutVolumeSummaryDto {
            from: summary.from,
            to: summary.to,
            session_count: summary.session_count,
            volume: volume_dto(&summary.volume),
            energy_kcal: summary.energy_kcal,
            by_exercise: summary
                .by_exercise
                .iter()
                .map(|row| ExerciseVolumeRowDto {
                    exercise_id: row.exercise_id.clone(),
                    exercise_name: truncate_preview(&row.exercise_name, NAME_MAX_CHARS),
                    set_count: row.set_count,
                    volume_kg: row.volume_kg,
                })
                .collect(),
            personal_records: records
                .iter()
                .map(|r| ExerciseRecordDto {
                    exercise_id: r.exercise_id.clone(),
                    exercise_name: truncate_preview(&r.exercise_name, NAME_MAX_CHARS),
                    best_1rm_kg: r.best_1rm_kg,
                    best_weight_kg: r.best_weight_kg,
                    best_reps: r.best_reps,
                    achieved_on: r.achieved_on.clone(),
                })
                .collect(),
        }))
    }

    #[tool(
        name = "wr_workout_search_exercises",
        description = "Find exercises by name or alias, with their MET coefficient and equipment. Read-only."
    )]
    pub async fn workout_search_exercises(
        &self,
        Parameters(p): Parameters<WorkoutSearchParams>,
    ) -> Result<Json<ExerciseListDto>, rmcp::ErrorData> {
        self.workout_search_exercises_inner(p).await
    }

    pub(crate) async fn workout_search_exercises_inner(
        &self,
        p: WorkoutSearchParams,
    ) -> Result<Json<ExerciseListDto>, rmcp::ErrorData> {
        cap_chars(p.query.as_deref(), 80, "query")?;
        let exercises = workout_commands::list_exercises_inner(&self.db, p.query, false)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_search_exercises", &e))?;
        let truncated = exercises.len() > LIST_LIMIT;
        Ok(Json(ExerciseListDto {
            exercises: exercises
                .into_iter()
                .take(LIST_LIMIT)
                .map(|e| ExerciseDto {
                    modality: enum_token(&e.modality),
                    id: e.id,
                    name: truncate_preview(&e.name, NAME_MAX_CHARS),
                    primary_muscle: e.primary_muscle,
                    equipment: e.equipment,
                    met: e.met,
                    aliases: e.aliases,
                })
                .collect(),
            truncated,
        }))
    }

    #[tool(
        name = "wr_workout_body_trend",
        description = "Body composition history with a 7-measurement moving average of weight, plus the fixed body profile (birth year, height, sex) used for BMR. Read-only."
    )]
    pub async fn workout_body_trend(
        &self,
        Parameters(p): Parameters<WorkoutTrendParams>,
    ) -> Result<Json<BodyTrendDto>, rmcp::ErrorData> {
        self.workout_body_trend_inner(p).await
    }

    pub(crate) async fn workout_body_trend_inner(
        &self,
        p: WorkoutTrendParams,
    ) -> Result<Json<BodyTrendDto>, rmcp::ErrorData> {
        let trend = workout_commands::body_trend_inner(&self.db, p.limit)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_body_trend", &e))?;
        let profile = workout_commands::body_profile_inner(&self.db)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_body_trend", &e))?;
        Ok(Json(BodyTrendDto {
            latest: trend.latest.as_ref().map(metric_dto),
            weight_trend_kg: trend.weight_trend_kg,
            history: trend.history.iter().map(metric_dto).collect(),
            birth_year: profile.birth_year,
            height_cm: profile.height_cm,
            sex: profile.sex,
        }))
    }

    #[tool(
        name = "wr_workout_energy_balance",
        description = "One day's energy balance: intake from meal logs minus (BMR + workout burn). READ-ONLY and purely derived — it does NOT change the calorie goal, which only a human sets. bmr_available=false means the body profile or a weight measurement is missing, so no BMR was estimated."
    )]
    pub async fn workout_energy_balance(
        &self,
        Parameters(p): Parameters<WorkoutDateParams>,
    ) -> Result<Json<EnergyBalanceDto>, rmcp::ErrorData> {
        self.workout_energy_balance_inner(p).await
    }

    pub(crate) async fn workout_energy_balance_inner(
        &self,
        p: WorkoutDateParams,
    ) -> Result<Json<EnergyBalanceDto>, rmcp::ErrorData> {
        let date = parse_iso_date(&p.date)?.to_string();
        let result = workout_commands::daily_energy_balance_inner(&self.db, &date)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_energy_balance", &e))?;
        Ok(Json(EnergyBalanceDto {
            date: result.date,
            intake_kcal: result.balance.intake_kcal,
            bmr_kcal: result.balance.bmr_kcal,
            workout_kcal: result.balance.workout_kcal,
            expenditure_kcal: result.balance.expenditure_kcal,
            balance_kcal: result.balance.balance_kcal,
            bmr_available: result.balance.bmr_available,
            weight_kg: result.weight_kg,
            session_count: result.session_count,
        }))
    }

    // ── write (관측 사실 기록) ───────────────────────────────────

    #[tool(
        name = "wr_workout_start_session",
        description = "Open a workout session for a date that was actually trained, then add sets to it. This records what happened; it is not a schedule (routines owns planning)."
    )]
    pub async fn workout_start_session(
        &self,
        Parameters(p): Parameters<WorkoutStartSessionParams>,
    ) -> Result<Json<WorkoutIdDto>, rmcp::ErrorData> {
        self.workout_start_session_inner(p).await
    }

    pub(crate) async fn workout_start_session_inner(
        &self,
        p: WorkoutStartSessionParams,
    ) -> Result<Json<WorkoutIdDto>, rmcp::ErrorData> {
        cap_chars(p.title.as_deref(), NAME_MAX_CHARS, "title")?;
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let date = parse_iso_date(&p.date)?.to_string();
        let session = workout_commands::start_workout_session_inner(
            &self.db,
            StartWorkoutSessionInput {
                date,
                started_at: p.started_at,
                title: p.title,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_start_session", &e))?;
        Ok(Json(WorkoutIdDto { id: session.id }))
    }

    #[tool(
        name = "wr_workout_patch_session",
        description = "Update session metadata (title, start/end time, perceived exertion 1-10, note). Only the fields you pass change."
    )]
    pub async fn workout_patch_session(
        &self,
        Parameters(p): Parameters<WorkoutPatchSessionParams>,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        self.workout_patch_session_inner(p).await
    }

    pub(crate) async fn workout_patch_session_inner(
        &self,
        p: WorkoutPatchSessionParams,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        cap_chars(p.title.as_deref(), NAME_MAX_CHARS, "title")?;
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        workout_commands::patch_workout_session_inner(
            &self.db,
            PatchWorkoutSessionInput {
                id: p.session_id,
                date: None,
                title: p.title,
                started_at: p.started_at,
                ended_at: p.ended_at,
                perceived_exertion: p.perceived_exertion,
                note: p.note,
                clear: Vec::new(),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_patch_session", &e))?;
        Ok(Json(WorkoutOkDto { ok: true }))
    }

    #[tool(
        name = "wr_workout_add_set",
        description = "Append one set to a session. Strength: reps (+ weight_kg). Cardio: duration_sec (+ distance_m). At least one of reps / duration_sec / distance_m is required — weight alone does not say what was done."
    )]
    pub async fn workout_add_set(
        &self,
        Parameters(p): Parameters<WorkoutAddSetParams>,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        self.workout_add_set_inner(p).await
    }

    pub(crate) async fn workout_add_set_inner(
        &self,
        p: WorkoutAddSetParams,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        workout_commands::add_workout_set_inner(
            &self.db,
            AddWorkoutSetInput {
                session_id: p.session_id,
                exercise_id: p.exercise_id,
                reps: p.reps,
                weight_kg: p.weight_kg,
                duration_sec: p.duration_sec,
                distance_m: p.distance_m,
                rest_sec: p.rest_sec,
                rpe: p.rpe,
                note: p.note,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_add_set", &e))?;
        Ok(Json(WorkoutOkDto { ok: true }))
    }

    #[tool(
        name = "wr_workout_patch_set",
        description = "Correct one recorded set by its row id (from wr_workout_session). Only the fields you pass change; a patch that would leave the set with no reps/duration/distance is rejected."
    )]
    pub async fn workout_patch_set(
        &self,
        Parameters(p): Parameters<WorkoutPatchSetParams>,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        self.workout_patch_set_inner(p).await
    }

    pub(crate) async fn workout_patch_set_inner(
        &self,
        p: WorkoutPatchSetParams,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        workout_commands::patch_workout_set_inner(
            &self.db,
            PatchWorkoutSetInput {
                id: p.set_id,
                exercise_id: p.exercise_id,
                reps: p.reps,
                weight_kg: p.weight_kg,
                duration_sec: p.duration_sec,
                distance_m: p.distance_m,
                rest_sec: p.rest_sec,
                rpe: p.rpe,
                note: p.note,
                clear: Vec::new(),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_patch_set", &e))?;
        Ok(Json(WorkoutOkDto { ok: true }))
    }

    #[tool(
        name = "wr_workout_remove_set",
        description = "Remove one mistakenly recorded set by its row id. Remaining sets renumber automatically. (Whole sessions can only be deleted in the app, with a confirm.)"
    )]
    pub async fn workout_remove_set(
        &self,
        Parameters(p): Parameters<WorkoutSetIdParams>,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        self.workout_remove_set_inner(p).await
    }

    pub(crate) async fn workout_remove_set_inner(
        &self,
        p: WorkoutSetIdParams,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        workout_commands::remove_workout_set_inner(&self.db, &p.set_id)
            .await
            .map_err(|e| mcp_tool_error("wr_workout_remove_set", &e))?;
        Ok(Json(WorkoutOkDto { ok: true }))
    }

    #[tool(
        name = "wr_workout_upsert_exercise",
        description = "Add or correct an exercise in the library, including its MET coefficient (needed for energy burn). Without a MET the burn is reported as 0 rather than guessed."
    )]
    pub async fn workout_upsert_exercise(
        &self,
        Parameters(p): Parameters<WorkoutUpsertExerciseParams>,
    ) -> Result<Json<WorkoutIdDto>, rmcp::ErrorData> {
        self.workout_upsert_exercise_inner(p).await
    }

    pub(crate) async fn workout_upsert_exercise_inner(
        &self,
        p: WorkoutUpsertExerciseParams,
    ) -> Result<Json<WorkoutIdDto>, rmcp::ErrorData> {
        cap_chars(Some(&p.name), NAME_MAX_CHARS, "name")?;
        cap_chars(
            p.primary_muscle.as_deref(),
            NAME_MAX_CHARS,
            "primary_muscle",
        )?;
        cap_chars(p.equipment.as_deref(), NAME_MAX_CHARS, "equipment")?;
        let exercise = workout_commands::upsert_exercise_inner(
            &self.db,
            UpsertExerciseInput {
                id: p.id,
                name: p.name,
                modality: p.modality.into(),
                primary_muscle: p.primary_muscle,
                equipment: p.equipment,
                met: p.met,
                source: Some("agent".into()),
                source_ref: None,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_upsert_exercise", &e))?;
        Ok(Json(WorkoutIdDto { id: exercise.id }))
    }

    #[tool(
        name = "wr_workout_record_body_metric",
        description = "Record a body measurement (weight, body fat %, skeletal muscle, waist) for a date. One row per day: re-measuring the same day updates it, and axes you omit keep their previous values."
    )]
    pub async fn workout_record_body_metric(
        &self,
        Parameters(p): Parameters<WorkoutBodyMetricParams>,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        self.workout_record_body_metric_inner(p).await
    }

    pub(crate) async fn workout_record_body_metric_inner(
        &self,
        p: WorkoutBodyMetricParams,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        cap_chars(p.note.as_deref(), NOTE_MAX_CHARS, "note")?;
        let measured_on = parse_iso_date(&p.measured_on)?.to_string();
        workout_commands::record_body_metric_inner(
            &self.db,
            RecordBodyMetricInput {
                measured_on,
                weight_kg: p.weight_kg,
                body_fat_pct: p.body_fat_pct,
                skeletal_muscle_kg: p.skeletal_muscle_kg,
                waist_cm: p.waist_cm,
                note: p.note,
                // MCP 표면은 축을 비우지 않는다 — 오기입 정정은 앱 UI에서(되돌릴 수 없는 삭제류
                // 는 사람 게이트 쪽에 둔다는 이 도메인의 표면 원칙과 일관).
                clear: Vec::new(),
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_record_body_metric", &e))?;
        Ok(Json(WorkoutOkDto { ok: true }))
    }

    #[tool(
        name = "wr_workout_set_body_profile",
        description = "Set the fixed body facts used for BMR: birth year, height, sex ('male'/'female'/'other'). Weight is NOT here — it belongs in wr_workout_record_body_metric because it changes."
    )]
    pub async fn workout_set_body_profile(
        &self,
        Parameters(p): Parameters<WorkoutBodyProfileParams>,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        self.workout_set_body_profile_inner(p).await
    }

    pub(crate) async fn workout_set_body_profile_inner(
        &self,
        p: WorkoutBodyProfileParams,
    ) -> Result<Json<WorkoutOkDto>, rmcp::ErrorData> {
        workout_commands::set_body_profile_inner(
            &self.db,
            SetBodyProfileInput {
                birth_year: p.birth_year,
                height_cm: p.height_cm,
                sex: p.sex,
            },
        )
        .await
        .map_err(|e| mcp_tool_error("wr_workout_set_body_profile", &e))?;
        Ok(Json(WorkoutOkDto { ok: true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    fn server(db: crate::db::Db) -> WrServer {
        WrServer { db }
    }

    #[tokio::test]
    async fn agent_can_record_a_whole_session_and_read_it_back() {
        let db = fresh_db().await;
        let srv = server(db.clone());

        let squat = srv
            .workout_upsert_exercise_inner(WorkoutUpsertExerciseParams {
                id: None,
                name: "백스쿼트".into(),
                modality: ExerciseModalityParam::Strength,
                primary_muscle: Some("quads".into()),
                equipment: Some("barbell".into()),
                met: Some(5.0),
            })
            .await
            .expect("exercise")
            .0
            .id;

        let session = srv
            .workout_start_session_inner(WorkoutStartSessionParams {
                date: "2026-07-26".into(),
                started_at: None,
                title: Some("하체".into()),
                note: None,
            })
            .await
            .expect("session")
            .0
            .id;

        for (reps, weight) in [(10, 60.0), (8, 70.0)] {
            srv.workout_add_set_inner(WorkoutAddSetParams {
                session_id: session.clone(),
                exercise_id: squat.clone(),
                reps: Some(reps),
                weight_kg: Some(weight),
                duration_sec: None,
                distance_m: None,
                rest_sec: Some(120),
                rpe: Some(8),
                note: None,
            })
            .await
            .expect("set");
        }

        let read = srv
            .workout_session_inner(WorkoutSessionIdParams {
                session_id: session.clone(),
            })
            .await
            .expect("read")
            .0;
        assert_eq!(read.sets.len(), 2);
        assert_eq!(read.sets[0].set_no, 1);
        assert!((read.volume.volume_kg - 1160.0).abs() < 1e-9);

        // patch는 세트 행 id로 — 표면이 그 id를 돌려주므로 왕복이 성립한다.
        srv.workout_patch_set_inner(WorkoutPatchSetParams {
            set_id: read.sets[1].id.clone(),
            exercise_id: None,
            reps: Some(6),
            weight_kg: Some(75.0),
            duration_sec: None,
            distance_m: None,
            rest_sec: None,
            rpe: None,
            note: None,
        })
        .await
        .expect("patch");

        let after = srv
            .workout_session_inner(WorkoutSessionIdParams {
                session_id: session,
            })
            .await
            .expect("read")
            .0;
        assert_eq!(after.sets[1].reps, Some(6));
        assert!((after.volume.volume_kg - (600.0 + 450.0)).abs() < 1e-9);
    }

    #[tokio::test]
    async fn energy_balance_is_read_only_and_reports_missing_bmr_inputs() {
        let db = fresh_db().await;
        let srv = server(db.clone());
        // seed 프로필 + seed 체중이 있으므로 BMR이 계산된다.
        let ok = srv
            .workout_energy_balance_inner(WorkoutDateParams {
                date: "2026-07-26".into(),
            })
            .await
            .expect("balance")
            .0;
        assert!(ok.bmr_available);
        assert!((ok.bmr_kcal.unwrap() - 1568.75).abs() < 1e-9);

        // 프로필을 비우면 추정하지 않고 없다고 말한다.
        sqlx::query("UPDATE body_profile SET height_cm = NULL WHERE id = 'singleton'")
            .execute(&db)
            .await
            .unwrap();
        let degraded = srv
            .workout_energy_balance_inner(WorkoutDateParams {
                date: "2026-07-26".into(),
            })
            .await
            .expect("balance")
            .0;
        assert!(!degraded.bmr_available);
        assert_eq!(degraded.bmr_kcal, None);
    }

    #[tokio::test]
    async fn body_metric_write_keeps_one_row_per_day_and_preserves_other_axes() {
        let db = fresh_db().await;
        let srv = server(db.clone());
        srv.workout_record_body_metric_inner(WorkoutBodyMetricParams {
            measured_on: "2026-07-27".into(),
            weight_kg: Some(69.5),
            body_fat_pct: Some(18.0),
            skeletal_muscle_kg: None,
            waist_cm: None,
            note: None,
        })
        .await
        .expect("metric");
        srv.workout_record_body_metric_inner(WorkoutBodyMetricParams {
            measured_on: "2026-07-27".into(),
            weight_kg: Some(69.1),
            body_fat_pct: None,
            skeletal_muscle_kg: None,
            waist_cm: None,
            note: None,
        })
        .await
        .expect("metric");

        let trend = srv
            .workout_body_trend_inner(WorkoutTrendParams { limit: None })
            .await
            .expect("trend")
            .0;
        let latest = trend.latest.expect("latest");
        assert_eq!(latest.measured_on, "2026-07-27");
        assert_eq!(latest.weight_kg, Some(69.1));
        assert_eq!(latest.body_fat_pct, Some(18.0), "다른 축 보존");
        assert_eq!(trend.birth_year, Some(1987), "프로필도 같이 노출");
    }

    #[tokio::test]
    async fn workout_params_schemas_are_closed() {
        // MCP 입력은 strict — unknown field가 조용히 무시되면 오타가 사실을 왜곡한다.
        for schema in [
            serde_json::to_value(schemars::schema_for!(WorkoutAddSetParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(WorkoutPatchSetParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(WorkoutStartSessionParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(WorkoutBodyMetricParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(WorkoutBodyProfileParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(WorkoutUpsertExerciseParams)).unwrap(),
            serde_json::to_value(schemars::schema_for!(WorkoutRangeParams)).unwrap(),
        ] {
            assert_eq!(
                schema.get("additionalProperties"),
                Some(&serde_json::Value::Bool(false)),
                "deny_unknown_fields가 생성 스키마에 박혀야 한다: {schema}"
            );
        }
    }
}
