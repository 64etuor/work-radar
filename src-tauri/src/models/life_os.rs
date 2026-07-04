use serde::{Deserialize, Serialize};
use specta::Type;

use super::Weekday;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum MissionHorizonKind {
    ThreeYear,
    OneYear,
    Someday,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum WscKind {
    W,
    S,
    C,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum LifeOsRecordStatus {
    Active,
    Paused,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum GuardrailTargetKind {
    RoutineCount,
    WeeklyMinutes,
    ManualCheck,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum WeeklyFocusSourceKind {
    Signal,
    Objective,
    KeyResult,
    Horizon,
    Pattern,
    Sprint,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum WeeklyFocusStatus {
    Proposed,
    Selected,
    Done,
    Missed,
    Dismissed,
    Shrunk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum LifeOsRecommendationKind {
    WeeklyFocus,
    GuardrailRecovery,
    Q1Prevention,
    Q3Containment,
    DecisionTask,
    ShrinkFocus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum LifeOsRecommendationStatus {
    Proposed,
    Accepted,
    Dismissed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum LifeOsTargetKind {
    WeeklyFocus,
    Recommendation,
    Guardrail,
    Signal,
    Sprint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum LifeOsAuditOutcome {
    Done,
    Dismissed,
    TooLarge,
    WrongPriority,
    Blocked,
    Accurate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum SprintCycleStatus {
    Active,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MissionHorizon {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub horizon_kind: MissionHorizonKind,
    pub wsc_kind: Option<WscKind>,
    pub area_keys: Vec<String>,
    pub status: LifeOsRecordStatus,
    pub sort_rank: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateMissionHorizonInput {
    pub title: String,
    pub description: Option<String>,
    pub horizon_kind: MissionHorizonKind,
    pub wsc_kind: Option<WscKind>,
    pub area_keys: Vec<String>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateMissionHorizonInput {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub horizon_kind: MissionHorizonKind,
    pub wsc_kind: Option<WscKind>,
    pub area_keys: Vec<String>,
    pub status: LifeOsRecordStatus,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrGuardrail {
    pub id: String,
    pub quarter: String,
    pub area_key: String,
    pub label: String,
    pub target_kind: GuardrailTargetKind,
    pub target_value: Option<f64>,
    pub unit: Option<String>,
    pub source_routine_ids: Vec<String>,
    pub status: LifeOsRecordStatus,
    pub sort_rank: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveHorizonLink {
    pub objective_id: String,
    pub horizon_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpsertGuardrailInput {
    pub id: Option<String>,
    pub quarter: String,
    pub area_key: String,
    pub label: String,
    pub target_kind: GuardrailTargetKind,
    pub target_value: Option<f64>,
    pub unit: Option<String>,
    pub source_routine_ids: Vec<String>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyFocus {
    pub id: String,
    pub week_start: String,
    pub title: String,
    pub source_kind: WeeklyFocusSourceKind,
    pub source_id: Option<String>,
    pub objective_id: Option<String>,
    pub key_result_id: Option<String>,
    pub horizon_id: Option<String>,
    pub status: WeeklyFocusStatus,
    pub estimated_minutes: Option<i32>,
    pub reason: Option<String>,
    pub must_do_signal_ids: Vec<String>,
    pub not_do_signal_ids: Vec<String>,
    pub guardrail_ids: Vec<String>,
    pub shrink_count: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LifeOsSignalReview {
    pub signal_id: String,
    pub title: String,
    pub area_key: String,
    pub quadrant_hint: Option<String>,
    pub okr_relevant: bool,
    pub guardrail_risk: bool,
    pub one_thing_candidate: bool,
    pub processing_action: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LifeOsDiagnosis {
    pub q1_count: i32,
    pub q2_count: i32,
    pub q3_count: i32,
    pub q4_count: i32,
    pub unclassified_count: i32,
    pub guardrail_risk_count: i32,
    pub dominant_area_key: Option<String>,
    pub method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LifeOsRecommendation {
    pub id: String,
    pub snapshot_id: Option<String>,
    pub week_start: String,
    pub kind: LifeOsRecommendationKind,
    pub title: String,
    pub reason: Option<String>,
    pub source_kind: Option<WeeklyFocusSourceKind>,
    pub source_id: Option<String>,
    pub confidence: i32,
    pub payload_json: String,
    pub status: LifeOsRecommendationStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LifeOsSnapshot {
    pub id: String,
    pub week_start: String,
    pub quarter: String,
    pub range_start: String,
    pub range_end: String,
    pub diagnosis: LifeOsDiagnosis,
    pub signal_reviews: Vec<LifeOsSignalReview>,
    pub recommendations: Vec<LifeOsRecommendation>,
    pub source_hash: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LifeOsAuditEvent {
    pub id: String,
    pub week_start: String,
    pub target_kind: LifeOsTargetKind,
    pub target_id: String,
    pub outcome: LifeOsAuditOutcome,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerateLifeOsReviewInput {
    pub week_start: String,
    pub quarter: String,
    pub range_start: String,
    pub range_end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcceptLifeOsRecommendationInput {
    pub recommendation_id: String,
    pub replace_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DismissLifeOsRecommendationInput {
    pub recommendation_id: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordLifeOsAuditInput {
    pub week_start: String,
    pub target_kind: LifeOsTargetKind,
    pub target_id: String,
    pub outcome: LifeOsAuditOutcome,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectWeeklyFocusInput {
    pub week_start: String,
    pub title: String,
    pub source_kind: WeeklyFocusSourceKind,
    pub source_id: Option<String>,
    pub objective_id: Option<String>,
    pub key_result_id: Option<String>,
    pub horizon_id: Option<String>,
    pub estimated_minutes: Option<i32>,
    pub reason: Option<String>,
    pub must_do_signal_ids: Vec<String>,
    pub not_do_signal_ids: Vec<String>,
    pub guardrail_ids: Vec<String>,
    pub replace_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SprintCycle {
    pub id: String,
    pub sprint_key: String,
    pub start_at: String,
    pub end_at: String,
    pub interval_days: i32,
    pub anchor_weekday: Weekday,
    pub anchor_time: String,
    pub goal: Option<String>,
    pub weekly_focus_id: Option<String>,
    pub status: SprintCycleStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SprintWeeklyFocusConflict {
    pub existing_weekly_focus: WeeklyFocus,
    pub sprint_goal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SprintSaveResult {
    pub sprint_cycle: Option<SprintCycle>,
    pub weekly_focus: Option<WeeklyFocus>,
    pub conflict: Option<SprintWeeklyFocusConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkSprintGoalInput {
    pub replace_existing: bool,
}
