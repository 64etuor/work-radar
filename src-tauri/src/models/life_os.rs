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
