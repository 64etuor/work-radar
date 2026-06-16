use serde::{Deserialize, Serialize};
use specta::Type;

/// 가계부 거래 유입 경로. Gmail/OCR/CSV는 후속 ingest adapter가 같은 리뷰큐에 기록한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingSource {
    Manual,
    Ocr,
    Gmail,
    Csv,
}

/// 거래 리뷰 상태. 외부 자동 확정 없이 사람이 approved/ignored로 정리한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingReviewStatus {
    NeedsReview,
    Approved,
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingTransaction {
    pub id: String,
    pub project_id: Option<String>,
    pub source: BookkeepingSource,
    pub source_ref: Option<String>,
    pub merchant: String,
    pub description: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub spent_at: String,
    pub category: String,
    pub review_status: BookkeepingReviewStatus,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub reviewed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookkeepingTransactionInput {
    pub project_id: Option<String>,
    pub source: BookkeepingSource,
    pub source_ref: Option<String>,
    pub merchant: String,
    pub description: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub spent_at: String,
    pub category: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingAuditEntry {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub action: String,
    pub summary: String,
    pub metadata_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingSyncJob {
    pub id: String,
    pub source: BookkeepingSource,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub sanitized_error_code: Option<String>,
    pub sanitized_error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordBookkeepingSyncFailureInput {
    pub source: BookkeepingSource,
    pub error_code: String,
    pub raw_error_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCategorySummary {
    pub category: String,
    pub amount_minor: i32,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingMonthlySummary {
    pub month: String,
    pub total_amount_minor: i32,
    pub needs_review_count: u32,
    pub approved_count: u32,
    pub ignored_count: u32,
    pub categories: Vec<BookkeepingCategorySummary>,
}
