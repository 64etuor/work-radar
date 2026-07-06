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
    // 뱅크샐러드류 가계부 앱 "머니매니저" export. DB CHECK 문자열과 정확히 일치해야
    // 하므로 snake_case 기본값('money_manager')을 'moneymanager'로 명시 override.
    // (의도적으로 doc comment가 아님 — specta가 variant doc을 union 라인 개행으로
    // 렌더링하며 trailing whitespace를 만들어 `git diff --check`를 깨뜨린다.)
    #[serde(rename = "moneymanager")]
    #[sqlx(rename = "moneymanager")]
    MoneyManager,
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
    pub deleted_at: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBookkeepingTransactionInput {
    pub id: String,
    pub merchant: Option<String>,
    pub description: Option<String>,
    pub amount_minor: Option<i32>,
    pub currency: Option<String>,
    pub spent_at: Option<String>,
    /// `Some(None)` clears the time; omitted leaves it unchanged.
    pub spent_at_time: Option<Option<String>>,
    pub direction: Option<String>,
    pub note: Option<String>,
    pub account: Option<String>,
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    pub payment_method_kind: Option<BookkeepingPaymentMethodKind>,
    pub payment_method_label: Option<String>,
    pub payment_method_last4: Option<String>,
    pub expense_kind: Option<BookkeepingExpenseKind>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportBookkeepingMmbakInput {
    pub project_id: Option<String>,
    /// 로컬 .mmbak/.sqlite 파일 경로. 임포터가 임시 사본을 떠서 읽는다(원본 무손상).
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportBookkeepingMmbakSummary {
    pub scanned_count: u32,
    pub imported_count: u32,
    pub duplicate_count: u32,
    /// 이체·불량 금액·커서-이전 행 등 의도적 매핑 스킵(실패 아님).
    pub skipped_count: u32,
    pub failed_count: u32,
    /// 백업에서 삭제 표시된 uid 중 기존 행에 source_deleted 사유가 새로 달린 수.
    pub flagged_deleted_count: u32,
    /// 임포트당 중복-프로브 상한 초과로 프로브를 건너뛴 신규 행 수(행은 정상 임포트됨).
    pub dup_probe_skipped_count: u32,
    /// 사람 손이 닿지 않은(오버라이드 없음) 미분류 moneymanager 행 중 taxonomy 동기화 후
    /// 재해석으로 category_code가 채워진 수(힌트 갱신 — review_status 불변).
    pub backfilled_category_count: u32,
    /// 이번 임포트 후 저장된 UTIME 커서(epoch ms 문자열). 없으면 진전 없음.
    pub cursor_after: Option<String>,
}

/// MoneyManager(.mmbak) 자동 임포트 옵션 — 단일 row(id=1) 미러.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingMmbakOptions {
    /// .mmbak 백업 감시 폴더(예: Google Drive 동기화 폴더). None=미설정.
    pub watch_dir: Option<String>,
    /// 자동 임포트 귀속 프로젝트(선택).
    pub project_id: Option<String>,
    pub auto_import_enabled: bool,
    /// 마지막 자동 임포트 시각('YYYY-MM-DD HH:MM:SS' UTC). 실패해도 찍힌다(24h 게이트).
    pub last_auto_import_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetBookkeepingMmbakOptionsInput {
    pub watch_dir: Option<String>,
    pub project_id: Option<String>,
    pub auto_import_enabled: bool,
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
    pub hit_count: i32,
    pub last_used_at: Option<String>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BookkeepingExportFormat {
    Csv,
    Qif,
    Ofx,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportBookkeepingInput {
    pub project_id: Option<String>,
    pub from_date: Option<String>,
    pub to_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteBookkeepingExportInput {
    pub path: String,
    pub format: BookkeepingExportFormat,
    pub export: ExportBookkeepingInput,
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

/// 벌크 작업 1건 결과(건별 보고, best-effort — 일부 실패해도 나머지 진행).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingBulkItemResult {
    pub id: String,
    pub ok: bool,
    pub message: Option<String>,
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
    pub by_currency: Vec<BookkeepingCurrencySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCurrencySummary {
    pub currency: String,
    pub expense_minor: i32,
    pub income_minor: i32,
    pub net_minor: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookkeepingReconcileAccountInput {
    pub project_id: Option<String>,
    pub account: String,
    pub statement_date: String,
    pub statement_balance_minor: i32,
    pub currency: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingReconcileAccountResult {
    pub id: String,
    pub computed_balance_minor: i32,
    pub statement_balance_minor: i32,
    pub difference_minor: i32,
    pub matched: bool,
    /// 0 when balanced, 1 when the statement balance does not match the computed ledger balance.
    pub unmatched_count: i32,
    pub reconciled_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingBudget {
    pub id: String,
    pub project_id: Option<String>,
    pub month: String,
    pub category_code: String,
    pub limit_minor: i32,
    pub currency: String,
    pub rollover: bool,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetBookkeepingBudgetInput {
    pub project_id: Option<String>,
    pub month: String,
    pub category_code: String,
    pub limit_minor: i32,
    pub currency: Option<String>,
    pub rollover: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingBudgetStatus {
    pub category_code: String,
    pub label: String,
    pub limit_minor: i32,
    pub spent_minor: i32,
    pub remaining_minor: i32,
    pub rollover_in_minor: i32,
    pub rollover: bool,
    pub pct: f64,
    pub currency: String,
}

/// 예산 탭 한 행 — 상위 카테고리별 한도(없으면 `None`)·집행·롤오버·과거 지출 기반 제안액을
/// 서버에서 합쳐 반환. `has_budget=false`는 지출은 있으나 예산 미설정인 카테고리.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingBudgetPlanRow {
    pub category_code: String,
    pub label: String,
    pub has_budget: bool,
    pub budget_id: Option<String>,
    pub limit_minor: Option<i32>,
    pub rollover: bool,
    pub spent_minor: i32,
    pub rollover_in_minor: i32,
    pub remaining_minor: i32,
    pub pct: f64,
    /// 직전 완결 N개월 지출 평균(당월 제외), 1,000원 단위 반올림.
    pub suggested_minor: i32,
    pub currency: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookkeepingCategoryTrendInput {
    pub project_id: Option<String>,
    pub from_month: String,
    pub to_month: String,
    pub category_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCategoryTrendRow {
    pub month: String,
    pub category_code: String,
    pub label: String,
    pub expense_minor: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BookkeepingCashflowInput {
    pub project_id: Option<String>,
    pub from_month: String,
    pub to_month: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BookkeepingCashflowRow {
    pub month: String,
    pub income_minor: i32,
    pub expense_minor: i32,
    /// KRW-scoped net display: income - expense within the same stored currency assumption.
    pub net_minor: i32,
}
