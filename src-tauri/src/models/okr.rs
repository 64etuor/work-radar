use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum ObjectiveStatus {
    Active,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum KeyResultKind {
    Metric,
    Milestone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum OkrConfidence {
    OnTrack,
    AtRisk,
    OffTrack,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrMilestone {
    pub label: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: i32,
    pub statement: String,
    pub note: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Objective {
    pub id: String,
    pub quarter: String,
    pub title: String,
    pub description: Option<String>,
    pub sort_rank: i32,
    pub status: ObjectiveStatus,
    pub closed_reflection: Option<String>,
    pub linked_area_keys: Vec<String>,
    pub linked_project_ids: Vec<String>,
    pub key_results: Vec<KeyResult>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyResult {
    pub id: String,
    pub objective_id: String,
    pub title: String,
    pub kind: KeyResultKind,
    pub target_value: Option<f64>,
    pub current_value: Option<f64>,
    pub unit: Option<String>,
    pub milestones: Vec<OkrMilestone>,
    pub progress: f64,
    pub sort_rank: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OkrCheckIn {
    pub id: String,
    pub key_result_id: String,
    pub week_start: String,
    pub value_snapshot: f64,
    pub confidence: OkrConfidence,
    pub note: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateObjectiveInput {
    pub quarter: String,
    pub title: String,
    pub description: Option<String>,
    pub sort_rank: i32,
    pub linked_area_keys: Vec<String>,
    pub linked_project_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateObjectiveInput {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub sort_rank: i32,
    pub linked_area_keys: Vec<String>,
    pub linked_project_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateKeyResultInput {
    pub objective_id: String,
    pub title: String,
    pub kind: KeyResultKind,
    pub target_value: Option<f64>,
    pub current_value: Option<f64>,
    pub unit: Option<String>,
    pub milestones: Vec<OkrMilestone>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateKeyResultInput {
    pub id: String,
    pub title: String,
    pub kind: KeyResultKind,
    pub target_value: Option<f64>,
    pub current_value: Option<f64>,
    pub unit: Option<String>,
    pub milestones: Vec<OkrMilestone>,
    pub sort_rank: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OkrSignalStatsBucket {
    pub captured: i32,
    pub completed: i32,
    pub scheduled_minutes: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveSignalStats {
    pub objective_id: String,
    pub week: OkrSignalStatsBucket,
    pub quarter_to_date: OkrSignalStatsBucket,
}
