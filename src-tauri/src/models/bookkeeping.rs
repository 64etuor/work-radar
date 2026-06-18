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

/// 거래 방향. 가계부는 지출/수입을 모두 담되 금액(`amount_minor`)은 항상 양수로 저장하고
/// 부호 의미는 이 enum이 갖는다(음수 저장 금지). 합계는 방향별로 분리 집계한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingDirection {
    #[default]
    Expense,
    Income,
}

/// 결제수단은 Gmail/OCR에서 확정하지 않고 사람이 리뷰에서 보정할 수 있는 닫힌 값으로 둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingPaymentMethodKind {
    Unknown,
    Cash,
    Card,
    BankTransfer,
    SimplePay,
}

/// 거래/고정비의 지출 성격. Gmail ingest는 기본 variable, 사용자가 fixed 계열로 확정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingExpenseKind {
    Variable,
    Fixed,
    Subscription,
    Installment,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingRecurringExpenseStatus {
    Active,
    Paused,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingRecurringOccurrenceStatus {
    Planned,
    Posted,
    Skipped,
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
    pub payment_method_kind: BookkeepingPaymentMethodKind,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: BookkeepingExpenseKind,
    pub recurring_expense_id: Option<String>,
    pub recurring_occurrence_id: Option<String>,
    /// 지출/수입 방향(기본 expense). 금액은 항상 양수.
    pub direction: BookkeepingDirection,
    /// 자산/계좌명(예: "하나은행"). 결제수단과 별개의 출처 계좌.
    pub account: Option<String>,
    /// 사람이 읽는 소분류 라벨.
    pub subcategory: Option<String>,
    /// taxonomy 대분류 코드(미해석이면 None → "미분류"는 `category`로 표현).
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    /// 유입 시 원본 분류 라벨(예: "🪑 생활용품")을 보존 — 재매핑/감사용.
    pub raw_category: Option<String>,
    /// 시:분:초(HH:MM:SS). `spent_at`(날짜)와 분리 저장.
    pub spent_at_time: Option<String>,
    /// CFO 판단 전체 신뢰도 0..1(수동 입력은 None).
    pub confidence: Option<f64>,
    /// 필드별 신뢰도 맵 raw JSON(예: {"amount":0.99,"merchant":0.7}).
    pub field_confidence_json: String,
    /// 리뷰 사유 배열 raw JSON(예: [{"code":"low_confidence","detail":"…"}]).
    pub review_reasons_json: String,
    /// 중복으로 표시된 경우 원본 거래 id(`review_status='ignored'`와 함께).
    pub duplicate_of_transaction_id: Option<String>,
    /// 주문번호 — 영수증/이메일에 있으면 강한 중복 판별 키.
    pub order_no: Option<String>,
    /// 결제(승인)번호 — 강한 중복 판별 키.
    pub payment_no: Option<String>,
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
    pub payment_method_kind: BookkeepingPaymentMethodKind,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: BookkeepingExpenseKind,
    pub recurring_expense_id: Option<String>,
    pub recurring_occurrence_id: Option<String>,
    pub direction: BookkeepingDirection,
    pub account: Option<String>,
    pub subcategory: Option<String>,
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    pub raw_category: Option<String>,
    pub spent_at_time: Option<String>,
    pub confidence: Option<f64>,
    /// 비어 있으면 "{}"로 저장.
    pub field_confidence_json: Option<String>,
    /// 비어 있으면 "[]"로 저장.
    pub review_reasons_json: Option<String>,
    pub order_no: Option<String>,
    pub payment_no: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingRecurringExpense {
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    pub merchant: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub category: String,
    pub payment_method_kind: BookkeepingPaymentMethodKind,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: BookkeepingExpenseKind,
    pub schedule_day: i32,
    pub start_month: String,
    pub end_month: Option<String>,
    pub status: BookkeepingRecurringExpenseStatus,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookkeepingRecurringExpenseInput {
    pub project_id: Option<String>,
    pub name: String,
    pub merchant: Option<String>,
    pub amount_minor: i32,
    pub currency: String,
    pub category: String,
    pub payment_method_kind: BookkeepingPaymentMethodKind,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: BookkeepingExpenseKind,
    pub schedule_day: i32,
    pub start_month: String,
    pub end_month: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingRecurringOccurrence {
    pub id: String,
    pub recurring_expense_id: String,
    pub recurring_name: String,
    pub merchant: Option<String>,
    pub month: String,
    pub due_date: String,
    pub amount_minor: i32,
    pub currency: String,
    pub category: String,
    pub payment_method_kind: BookkeepingPaymentMethodKind,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: BookkeepingExpenseKind,
    pub status: BookkeepingRecurringOccurrenceStatus,
    pub transaction_id: Option<String>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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
    pub scanned_count: u32,
    pub imported_count: u32,
    pub duplicate_count: u32,
    pub review_needed_count: u32,
    pub failed_count: u32,
    pub cursor_before: Option<String>,
    pub cursor_after: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// per-source 동기화 커서. "현재 시점 이후"만 가져오기 위한 durable 위치(마지막으로 본 지점).
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingSyncCursor {
    pub source: BookkeepingSource,
    pub scope_key: String,
    pub cursor_kind: String,
    pub cursor_value: String,
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
pub struct BookkeepingGmailLabel {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncBookkeepingGmailReceiptsInput {
    pub project_id: String,
    pub label_ids: Vec<String>,
    pub label_names: Vec<String>,
    pub query: Option<String>,
    pub max_results: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingGmailSyncResult {
    pub scanned_count: u32,
    pub imported_count: u32,
    pub duplicate_count: u32,
    pub failed_count: u32,
    /// 이번 동기화 후 저장된 커서(다음 tick의 시작점). 없으면 진전 없음.
    pub cursor_after: Option<String>,
}

/// alias 매칭 대상. raw_label = 유입 분류 라벨, merchant = 상호, domain = 발신 도메인.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingAliasMatchKind {
    Merchant,
    RawLabel,
    Domain,
}

/// alias 출처. seed = 마이그레이션 시드, user = 사람, agent = CFO 제안.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum BookkeepingAliasSource {
    Seed,
    User,
    Agent,
}

/// taxonomy 노드. 대분류는 `parent_code` None, 소분류는 부모 코드를 가리킨다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCategoryNode {
    pub code: String,
    pub parent_code: Option<String>,
    pub label: String,
    pub sort_order: i32,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCategoryAlias {
    pub id: String,
    pub pattern: String,
    pub match_kind: BookkeepingAliasMatchKind,
    pub category_code: String,
    pub subcategory_code: Option<String>,
    pub confidence: f64,
    pub source: BookkeepingAliasSource,
    pub created_at: String,
}

/// `bookkeeping_get_category_rules` 반환 — taxonomy + alias 규칙 묶음.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCategoryRules {
    pub taxonomy: Vec<BookkeepingCategoryNode>,
    pub aliases: Vec<BookkeepingCategoryAlias>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCategoryOverride {
    pub id: String,
    pub transaction_id: String,
    pub from_code: Option<String>,
    pub to_code: Option<String>,
    pub from_subcategory_code: Option<String>,
    pub to_subcategory_code: Option<String>,
    pub actor: String,
    pub reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OverrideBookkeepingCategoryInput {
    pub transaction_id: String,
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingLineItem {
    pub id: String,
    pub transaction_id: String,
    pub name: String,
    pub amount_minor: i32,
    pub quantity: i32,
    pub category_code: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookkeepingLineItemInput {
    pub name: String,
    pub amount_minor: i32,
    /// 기본 1.
    pub quantity: Option<i32>,
    pub category_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetBookkeepingLineItemsInput {
    pub transaction_id: String,
    pub items: Vec<CreateBookkeepingLineItemInput>,
}

/// 저장 전 중복 후보 조회 입력. 약한 신호(금액/날짜/상호)와 강한 신호(주문/결제번호/source_ref)를 함께 본다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FindBookkeepingDuplicateCandidatesInput {
    pub project_id: Option<String>,
    pub spent_at: String,
    pub amount_minor: i32,
    pub merchant: Option<String>,
    pub order_no: Option<String>,
    pub payment_no: Option<String>,
    pub source: Option<BookkeepingSource>,
    pub source_ref: Option<String>,
    /// 자기 자신(이미 저장된 경우)을 후보에서 제외.
    pub exclude_transaction_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingDuplicateCandidate {
    pub transaction: BookkeepingTransaction,
    /// 0..1 — 높을수록 중복 가능성이 큼.
    pub score: f64,
    pub reasons: Vec<String>,
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
    /// 지출 합계(= `total_expense_minor`). 프런트 호환을 위해 한 릴리스 유지하는 별칭.
    pub total_amount_minor: i32,
    pub total_expense_minor: i32,
    pub total_income_minor: i32,
    /// 순액 = 수입 - 지출(음수 가능).
    pub net_minor: i32,
    pub needs_review_count: u32,
    pub approved_count: u32,
    /// 사용자가 무시한 건수(중복 표시 제외).
    pub ignored_count: u32,
    /// 중복으로 표시된 건수(`review_status='ignored'` + `duplicate_of_transaction_id` 존재).
    pub duplicate_count: u32,
    pub categories: Vec<BookkeepingCategorySummary>,
}
