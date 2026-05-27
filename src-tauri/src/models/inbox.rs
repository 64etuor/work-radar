use serde::{Deserialize, Serialize};
use specta::Type;

/// Unified Inbox row. This is local operational memory and navigation context,
/// not a decision rail.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    pub id: String,
    pub project_id: Option<String>,
    pub source: String,
    pub source_id: Option<String>,
    pub group_key: Option<String>,
    pub title: String,
    pub body: String,
    pub summary: Option<String>,
    pub priority: String,
    pub severity: String,
    pub status: String,
    pub unread: bool,
    pub related_entity_type: Option<String>,
    pub related_entity_id: Option<String>,
    pub action_payload: Option<String>,
    pub read_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxCounts {
    pub unread: u32,
    pub critical: u32,
    pub open: u32,
}
