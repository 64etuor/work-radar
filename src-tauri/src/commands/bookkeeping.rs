//! Local bookkeeping store + IPC commands.

use tauri::State;

use crate::bookkeeping::{parse_bookkeeping_email_receipt, BookkeepingEmailReceiptInput};
use crate::bookkeeping_export::{export_csv, export_ofx, export_qif, BookkeepingExportRow};
use crate::db::Db;
use crate::error::AppError;
use crate::gmail::{GmailMessageSearch, GmailReadProvider};
use crate::models::{
    BookkeepingAliasMatchKind, BookkeepingAuditEntry, BookkeepingBudget, BookkeepingBudgetStatus,
    BookkeepingBulkItemResult, BookkeepingCategoryAlias, BookkeepingCategoryNode,
    BookkeepingCategoryOverride, BookkeepingCategoryRules, BookkeepingCategorySummary,
    BookkeepingDirection, BookkeepingDuplicateCandidate, BookkeepingExpenseKind,
    BookkeepingGmailLabel, BookkeepingGmailSyncResult, BookkeepingLineItem,
    BookkeepingMonthlySummary, BookkeepingPaymentMethodKind, BookkeepingRecurringExpense,
    BookkeepingRecurringExpenseStatus, BookkeepingRecurringOccurrence,
    BookkeepingRecurringOccurrenceStatus, BookkeepingReviewStatus, BookkeepingSource,
    BookkeepingSyncCursor, BookkeepingSyncJob, BookkeepingTransaction,
    CreateBookkeepingLineItemInput, CreateBookkeepingRecurringExpenseInput,
    CreateBookkeepingTransactionInput, ExportBookkeepingInput,
    FindBookkeepingDuplicateCandidatesInput, OverrideBookkeepingCategoryInput,
    RecordBookkeepingSyncFailureInput, SetBookkeepingBudgetInput, SetBookkeepingLineItemsInput,
    SyncBookkeepingGmailReceiptsInput, UpdateBookkeepingTransactionInput,
};

const DEFAULT_CURRENCY: &str = "KRW";
const MAX_SYNC_ERROR_LEN: usize = 160;
const DEFAULT_GMAIL_MAX_RESULTS: u32 = 25;
const GMAIL_MAX_RESULTS_CAP: u32 = 100;
const SYNC_JOB_COLUMNS: &str =
    "id, source, status, started_at, finished_at, sanitized_error_code, \
 sanitized_error_message, scanned_count, imported_count, duplicate_count, review_needed_count, \
 failed_count, cursor_before, cursor_after, created_at, updated_at";

/// Per-run ingest counts recorded on a sync job row.
#[derive(Default, Clone, Copy)]
struct SyncCounts {
    scanned: u32,
    imported: u32,
    duplicate: u32,
    review_needed: u32,
    failed: u32,
}
const TRANSACTION_RETURNING_COLUMNS: &str = "id, project_id, source, source_ref, merchant, \
 description, amount_minor, currency, spent_at, category, review_status, note, \
 payment_method_kind, payment_method_label, payment_method_last4, expense_kind, \
 recurring_expense_id, recurring_occurrence_id, direction, account, subcategory, category_code, \
 subcategory_code, raw_category, spent_at_time, confidence, field_confidence_json, \
 review_reasons_json, duplicate_of_transaction_id, order_no, payment_no, created_at, updated_at, \
 reviewed_at, deleted_at";
const RECURRING_EXPENSE_RETURNING_COLUMNS: &str = "id, project_id, name, merchant, amount_minor, \
 currency, category, payment_method_kind, payment_method_label, payment_method_last4, \
 expense_kind, schedule_day, start_month, end_month, status, note, created_at, updated_at";
const BUDGET_RETURNING_COLUMNS: &str = "id, project_id, month, category_code, limit_minor, \
 currency, rollover, note, created_at, updated_at";

#[tauri::command]
#[specta::specta]
pub async fn create_bookkeeping_transaction(
    db: State<'_, Db>,
    input: CreateBookkeepingTransactionInput,
) -> Result<BookkeepingTransaction, AppError> {
    create_bookkeeping_transaction_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_transactions(
    db: State<'_, Db>,
    status: Option<BookkeepingReviewStatus>,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    list_bookkeeping_transactions_inner(db.inner(), status, project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_bookkeeping_review_status(
    db: State<'_, Db>,
    id: String,
    status: BookkeepingReviewStatus,
) -> Result<BookkeepingTransaction, AppError> {
    update_bookkeeping_review_status_inner(db.inner(), &id, status).await
}

#[tauri::command]
#[specta::specta]
pub async fn bulk_update_bookkeeping_review_status(
    db: State<'_, Db>,
    ids: Vec<String>,
    status: BookkeepingReviewStatus,
) -> Result<Vec<BookkeepingBulkItemResult>, AppError> {
    Ok(bulk_update_bookkeeping_review_status_inner(db.inner(), &ids, status).await)
}

#[tauri::command]
#[specta::specta]
pub async fn bulk_set_bookkeeping_category(
    db: State<'_, Db>,
    ids: Vec<String>,
    category_code: Option<String>,
    subcategory_code: Option<String>,
    reason: Option<String>,
) -> Result<Vec<BookkeepingBulkItemResult>, AppError> {
    Ok(bulk_set_bookkeeping_category_inner(
        db.inner(),
        &ids,
        category_code.as_deref(),
        subcategory_code.as_deref(),
        reason.as_deref(),
    )
    .await)
}

#[tauri::command]
#[specta::specta]
pub async fn bulk_delete_bookkeeping_transactions(
    db: State<'_, Db>,
    ids: Vec<String>,
) -> Result<Vec<BookkeepingBulkItemResult>, AppError> {
    Ok(bulk_delete_bookkeeping_transactions_inner(db.inner(), &ids).await)
}

#[tauri::command]
#[specta::specta]
pub async fn update_bookkeeping_transaction(
    db: State<'_, Db>,
    input: UpdateBookkeepingTransactionInput,
) -> Result<BookkeepingTransaction, AppError> {
    update_bookkeeping_transaction_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_bookkeeping_transaction(
    db: State<'_, Db>,
    id: String,
) -> Result<BookkeepingTransaction, AppError> {
    delete_bookkeeping_transaction_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn restore_bookkeeping_transaction(
    db: State<'_, Db>,
    id: String,
) -> Result<BookkeepingTransaction, AppError> {
    restore_bookkeeping_transaction_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_trash(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    list_bookkeeping_trash_inner(db.inner(), project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_monthly_summary(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<BookkeepingMonthlySummary, AppError> {
    bookkeeping_monthly_summary_inner(db.inner(), &month, project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_bookkeeping_budget(
    db: State<'_, Db>,
    input: SetBookkeepingBudgetInput,
) -> Result<BookkeepingBudget, AppError> {
    set_bookkeeping_budget_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_budgets(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingBudget>, AppError> {
    list_bookkeeping_budgets_inner(db.inner(), &month, project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_bookkeeping_budget(db: State<'_, Db>, id: String) -> Result<bool, AppError> {
    delete_bookkeeping_budget_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_budget_status(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingBudgetStatus>, AppError> {
    bookkeeping_budget_status_inner(db.inner(), &month, project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_audit(
    db: State<'_, Db>,
    entity_id: Option<String>,
) -> Result<Vec<BookkeepingAuditEntry>, AppError> {
    list_bookkeeping_audit_inner(db.inner(), entity_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn record_bookkeeping_sync_failure(
    db: State<'_, Db>,
    input: RecordBookkeepingSyncFailureInput,
) -> Result<BookkeepingSyncJob, AppError> {
    record_bookkeeping_sync_failure_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_sync_jobs(
    db: State<'_, Db>,
) -> Result<Vec<BookkeepingSyncJob>, AppError> {
    list_bookkeeping_sync_jobs_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_sync_cursors(
    db: State<'_, Db>,
) -> Result<Vec<BookkeepingSyncCursor>, AppError> {
    list_bookkeeping_sync_cursors_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_bookkeeping_recurring_expense(
    db: State<'_, Db>,
    input: CreateBookkeepingRecurringExpenseInput,
) -> Result<BookkeepingRecurringExpense, AppError> {
    create_bookkeeping_recurring_expense_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_recurring_expenses(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingRecurringExpense>, AppError> {
    list_bookkeeping_recurring_expenses_inner(db.inner(), project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn ensure_bookkeeping_recurring_occurrences(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingRecurringOccurrence>, AppError> {
    ensure_bookkeeping_recurring_occurrences_inner(db.inner(), &month, project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_recurring_occurrences(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingRecurringOccurrence>, AppError> {
    list_bookkeeping_recurring_occurrences_inner(db.inner(), &month, project_id.as_deref()).await
}

#[tauri::command]
#[specta::specta]
pub async fn post_bookkeeping_recurring_occurrence(
    db: State<'_, Db>,
    id: String,
) -> Result<BookkeepingRecurringOccurrence, AppError> {
    post_bookkeeping_recurring_occurrence_inner(db.inner(), &id).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_bookkeeping_recurring_occurrence_status(
    db: State<'_, Db>,
    id: String,
    status: BookkeepingRecurringOccurrenceStatus,
) -> Result<BookkeepingRecurringOccurrence, AppError> {
    set_bookkeeping_recurring_occurrence_status_inner(db.inner(), &id, status).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_gmail_labels(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<BookkeepingGmailLabel>, AppError> {
    let access = crate::commands::calendar::access_token_for(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "gmail.not_connected",
                "미연결 — 먼저 Google 계정을 연결하세요",
            )
        })?;
    let provider = crate::gmail::HttpGmailProvider::new()?;
    let labels = provider.list_labels(&access).await?;
    Ok(labels
        .into_iter()
        .map(|label| BookkeepingGmailLabel {
            id: label.id,
            name: label.name,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn sync_bookkeeping_gmail_receipts(
    db: State<'_, Db>,
    input: SyncBookkeepingGmailReceiptsInput,
) -> Result<BookkeepingGmailSyncResult, AppError> {
    let access = crate::commands::calendar::access_token_for(db.inner(), &input.project_id)
        .await
        .map_err(|e| AppError::terminal("gmail.access_token", e))?
        .ok_or_else(|| {
            AppError::not_found(
                "gmail.not_connected",
                "미연결 — 먼저 Google 계정을 연결하세요",
            )
        })?;
    let provider = crate::gmail::HttpGmailProvider::new()?;
    sync_bookkeeping_gmail_receipts_with_provider(db.inner(), &provider, &access, input).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_list_taxonomy(
    db: State<'_, Db>,
) -> Result<Vec<BookkeepingCategoryNode>, AppError> {
    list_bookkeeping_taxonomy_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_get_category_rules(
    db: State<'_, Db>,
) -> Result<BookkeepingCategoryRules, AppError> {
    bookkeeping_category_rules_inner(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn override_bookkeeping_category(
    db: State<'_, Db>,
    input: OverrideBookkeepingCategoryInput,
) -> Result<BookkeepingTransaction, AppError> {
    override_bookkeeping_category_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_category_overrides(
    db: State<'_, Db>,
    transaction_id: String,
) -> Result<Vec<BookkeepingCategoryOverride>, AppError> {
    list_bookkeeping_category_overrides_inner(db.inner(), &transaction_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_line_items(
    db: State<'_, Db>,
    transaction_id: String,
) -> Result<Vec<BookkeepingLineItem>, AppError> {
    list_bookkeeping_line_items_inner(db.inner(), &transaction_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_bookkeeping_line_items(
    db: State<'_, Db>,
    input: SetBookkeepingLineItemsInput,
) -> Result<Vec<BookkeepingLineItem>, AppError> {
    set_bookkeeping_line_items_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn export_bookkeeping_csv(
    db: State<'_, Db>,
    input: ExportBookkeepingInput,
) -> Result<String, AppError> {
    let rows = export_bookkeeping_rows(db.inner(), input).await?;
    Ok(export_csv(&rows))
}

#[tauri::command]
#[specta::specta]
pub async fn export_bookkeeping_qif(
    db: State<'_, Db>,
    input: ExportBookkeepingInput,
) -> Result<String, AppError> {
    let rows = export_bookkeeping_rows(db.inner(), input).await?;
    Ok(export_qif(&rows))
}

#[tauri::command]
#[specta::specta]
pub async fn export_bookkeeping_ofx(
    db: State<'_, Db>,
    input: ExportBookkeepingInput,
) -> Result<String, AppError> {
    let rows = export_bookkeeping_rows(db.inner(), input).await?;
    Ok(export_ofx(&rows))
}

#[tauri::command]
#[specta::specta]
pub async fn find_bookkeeping_duplicate_candidates(
    db: State<'_, Db>,
    input: FindBookkeepingDuplicateCandidatesInput,
) -> Result<Vec<BookkeepingDuplicateCandidate>, AppError> {
    find_bookkeeping_duplicate_candidates_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn mark_bookkeeping_duplicate(
    db: State<'_, Db>,
    id: String,
    duplicate_of_transaction_id: String,
) -> Result<BookkeepingTransaction, AppError> {
    mark_bookkeeping_duplicate_inner(db.inner(), &id, &duplicate_of_transaction_id).await
}

pub(crate) async fn create_bookkeeping_transaction_inner(
    db: &Db,
    input: CreateBookkeepingTransactionInput,
) -> Result<BookkeepingTransaction, AppError> {
    let merchant = clean_required(&input.merchant, "bookkeeping.merchant")?;
    let category = clean_required(&input.category, "bookkeeping.category")?;
    let currency = clean_currency(&input.currency)?;
    validate_date(&input.spent_at)?;
    if input.amount_minor <= 0 {
        return Err(AppError::validation(
            "bookkeeping.amount",
            "금액은 0보다 커야 합니다",
        ));
    }
    let source_ref = clean_optional(input.source_ref.as_deref());
    let description = clean_optional(input.description.as_deref());
    let note = clean_optional(input.note.as_deref());
    let payment_method_label = clean_optional(input.payment_method_label.as_deref());
    let payment_method_last4 = clean_payment_last4(input.payment_method_last4.as_deref())?;
    let mut jf = prepare_judgment_fields(&input)?;
    apply_category_resolution(db, &mut jf, &category, &merchant).await?;

    let mut tx = db.begin().await?;
    let created_sql = format!(
        "INSERT INTO bookkeeping_transactions \
         (id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
          spent_at, category, review_status, note, payment_method_kind, payment_method_label, \
          payment_method_last4, expense_kind, recurring_expense_id, recurring_occurrence_id, \
          direction, account, subcategory, category_code, subcategory_code, raw_category, \
          spent_at_time, confidence, field_confidence_json, review_reasons_json, order_no, \
          payment_no) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
          'needs_review', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, \
          ?23, ?24, ?25, ?26, ?27, ?28) \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    );
    let created = sqlx::query_as::<_, BookkeepingTransaction>(&created_sql)
        .bind(input.project_id.as_deref())
        .bind(input.source)
        .bind(source_ref.as_deref())
        .bind(&merchant)
        .bind(description.as_deref())
        .bind(input.amount_minor)
        .bind(&currency)
        .bind(&input.spent_at)
        .bind(&category)
        .bind(note.as_deref())
        .bind(input.payment_method_kind)
        .bind(payment_method_label.as_deref())
        .bind(payment_method_last4.as_deref())
        .bind(input.expense_kind)
        .bind(input.recurring_expense_id.as_deref())
        .bind(input.recurring_occurrence_id.as_deref())
        .bind(jf.direction)
        .bind(jf.account.as_deref())
        .bind(jf.subcategory.as_deref())
        .bind(jf.category_code.as_deref())
        .bind(jf.subcategory_code.as_deref())
        .bind(jf.raw_category.as_deref())
        .bind(jf.spent_at_time.as_deref())
        .bind(jf.confidence)
        .bind(&jf.field_confidence_json)
        .bind(&jf.review_reasons_json)
        .bind(jf.order_no.as_deref())
        .bind(jf.payment_no.as_deref())
        .fetch_one(&mut *tx)
        .await?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &created.id,
        "transaction.created",
        "거래가 리뷰큐에 추가됨",
        serde_json::json!({ "source": input.source, "reviewStatus": created.review_status }),
    )
    .await?;
    tx.commit().await?;
    Ok(created)
}

pub(crate) async fn upsert_bookkeeping_transaction_from_ingest_inner(
    db: &Db,
    input: CreateBookkeepingTransactionInput,
    audit_action: &str,
    audit_summary: &str,
) -> Result<BookkeepingTransaction, AppError> {
    if input.source_ref.as_deref().map(str::trim).is_none() {
        return create_bookkeeping_transaction_inner(db, input).await;
    }

    let merchant = clean_required(&input.merchant, "bookkeeping.merchant")?;
    let category = clean_required(&input.category, "bookkeeping.category")?;
    let currency = clean_currency(&input.currency)?;
    validate_date(&input.spent_at)?;
    if input.amount_minor <= 0 {
        return Err(AppError::validation(
            "bookkeeping.amount",
            "금액은 0보다 커야 합니다",
        ));
    }
    let source_ref = clean_optional(input.source_ref.as_deref());
    let description = clean_optional(input.description.as_deref());
    let note = clean_optional(input.note.as_deref());
    let payment_method_label = clean_optional(input.payment_method_label.as_deref());
    let payment_method_last4 = clean_payment_last4(input.payment_method_last4.as_deref())?;
    let mut jf = prepare_judgment_fields(&input)?;
    apply_category_resolution(db, &mut jf, &category, &merchant).await?;

    let mut tx = db.begin().await?;
    // Re-ingest keeps user-authoritative row state (`review_status`, `deleted_at`) and category
    // overrides. Field-level edit locks are intentionally delegated to Hermes'
    // source_ref duplicate precheck, which skips a re-save on an exact source_ref match.
    let upsert_sql = format!(
        "INSERT INTO bookkeeping_transactions \
         (id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
          spent_at, category, review_status, note, payment_method_kind, payment_method_label, \
          payment_method_last4, expense_kind, recurring_expense_id, recurring_occurrence_id, \
          direction, account, subcategory, category_code, subcategory_code, raw_category, \
          spent_at_time, confidence, field_confidence_json, review_reasons_json, order_no, \
          payment_no) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, \
          'needs_review', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, \
          ?23, ?24, ?25, ?26, ?27, ?28) \
         ON CONFLICT(source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET \
           project_id=excluded.project_id, \
           merchant=excluded.merchant, \
           description=COALESCE(excluded.description, bookkeeping_transactions.description), \
           amount_minor=excluded.amount_minor, \
           currency=excluded.currency, \
           spent_at=excluded.spent_at, \
           category=excluded.category, \
           note=COALESCE(excluded.note, bookkeeping_transactions.note), \
           payment_method_kind=excluded.payment_method_kind, \
           payment_method_label=COALESCE(excluded.payment_method_label, bookkeeping_transactions.payment_method_label), \
           payment_method_last4=COALESCE(excluded.payment_method_last4, bookkeeping_transactions.payment_method_last4), \
           expense_kind=excluded.expense_kind, \
           recurring_expense_id=COALESCE(excluded.recurring_expense_id, bookkeeping_transactions.recurring_expense_id), \
           recurring_occurrence_id=COALESCE(excluded.recurring_occurrence_id, bookkeeping_transactions.recurring_occurrence_id), \
           account=COALESCE(excluded.account, bookkeeping_transactions.account), \
           subcategory=COALESCE(excluded.subcategory, bookkeeping_transactions.subcategory), \
           raw_category=COALESCE(excluded.raw_category, bookkeeping_transactions.raw_category), \
           spent_at_time=COALESCE(excluded.spent_at_time, bookkeeping_transactions.spent_at_time), \
           order_no=COALESCE(excluded.order_no, bookkeeping_transactions.order_no), \
           payment_no=COALESCE(excluded.payment_no, bookkeeping_transactions.payment_no), \
           direction=bookkeeping_transactions.direction, \
           category_code=COALESCE(bookkeeping_transactions.category_code, excluded.category_code), \
           subcategory_code=COALESCE(bookkeeping_transactions.subcategory_code, excluded.subcategory_code), \
           confidence=COALESCE(bookkeeping_transactions.confidence, excluded.confidence), \
           field_confidence_json=bookkeeping_transactions.field_confidence_json, \
           review_reasons_json=bookkeeping_transactions.review_reasons_json, \
           updated_at=datetime('now') \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&upsert_sql)
        .bind(input.project_id.as_deref())
        .bind(input.source)
        .bind(source_ref.as_deref())
        .bind(&merchant)
        .bind(description.as_deref())
        .bind(input.amount_minor)
        .bind(&currency)
        .bind(&input.spent_at)
        .bind(&category)
        .bind(note.as_deref())
        .bind(input.payment_method_kind)
        .bind(payment_method_label.as_deref())
        .bind(payment_method_last4.as_deref())
        .bind(input.expense_kind)
        .bind(input.recurring_expense_id.as_deref())
        .bind(input.recurring_occurrence_id.as_deref())
        .bind(jf.direction)
        .bind(jf.account.as_deref())
        .bind(jf.subcategory.as_deref())
        .bind(jf.category_code.as_deref())
        .bind(jf.subcategory_code.as_deref())
        .bind(jf.raw_category.as_deref())
        .bind(jf.spent_at_time.as_deref())
        .bind(jf.confidence)
        .bind(&jf.field_confidence_json)
        .bind(&jf.review_reasons_json)
        .bind(jf.order_no.as_deref())
        .bind(jf.payment_no.as_deref())
        .fetch_one(&mut *tx)
        .await?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &row.id,
        audit_action,
        audit_summary,
        serde_json::json!({
            "source": input.source,
            "reviewStatus": row.review_status,
            "hasSourceRef": source_ref.is_some()
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}

// Foundation for the future Gmail read-side sync worker. We keep this off the renderer IPC surface
// so raw email bodies do not become a frontend contract before the Rust Gmail adapter exists.
#[allow(dead_code)]
pub(crate) async fn ingest_bookkeeping_gmail_receipt_inner(
    db: &Db,
    input: BookkeepingEmailReceiptInput,
) -> Result<Option<BookkeepingTransaction>, AppError> {
    let parsed = match parse_bookkeeping_email_receipt(&input) {
        Ok(parsed) => parsed,
        Err(err) => {
            record_bookkeeping_sync_failure_inner(
                db,
                RecordBookkeepingSyncFailureInput {
                    source: BookkeepingSource::Gmail,
                    error_code: "gmail.parse_failed".to_string(),
                    raw_error_message: err.code().to_string(),
                },
            )
            .await?;
            return Ok(None);
        }
    };

    let row = upsert_bookkeeping_transaction_from_ingest_inner(
        db,
        CreateBookkeepingTransactionInput {
            project_id: input.project_id,
            source: BookkeepingSource::Gmail,
            source_ref: Some(input.message_id),
            merchant: parsed.merchant,
            description: parsed.description,
            amount_minor: parsed.amount_minor,
            currency: parsed.currency,
            spent_at: parsed.spent_at,
            category: parsed.category,
            note: None,
            payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Variable,
            recurring_expense_id: None,
            recurring_occurrence_id: None,
            direction: BookkeepingDirection::Expense,
            account: None,
            subcategory: None,
            category_code: None,
            subcategory_code: None,
            raw_category: None,
            spent_at_time: None,
            confidence: None,
            field_confidence_json: None,
            review_reasons_json: None,
            order_no: None,
            payment_no: None,
        },
        "transaction.gmail_ingested",
        "Gmail 영수증이 리뷰큐에 추가됨",
    )
    .await?;
    Ok(Some(row))
}

pub(crate) async fn get_bookkeeping_sync_cursor_inner(
    db: &Db,
    source: BookkeepingSource,
    scope_key: &str,
) -> Result<Option<BookkeepingSyncCursor>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingSyncCursor>(
        "SELECT source, scope_key, cursor_kind, cursor_value, updated_at \
         FROM bookkeeping_sync_cursors WHERE source = ?1 AND scope_key = ?2",
    )
    .bind(source)
    .bind(scope_key)
    .fetch_optional(db)
    .await?)
}

pub(crate) async fn list_bookkeeping_sync_cursors_inner(
    db: &Db,
) -> Result<Vec<BookkeepingSyncCursor>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingSyncCursor>(
        "SELECT source, scope_key, cursor_kind, cursor_value, updated_at \
         FROM bookkeeping_sync_cursors ORDER BY source ASC, scope_key ASC",
    )
    .fetch_all(db)
    .await?)
}

async fn upsert_bookkeeping_sync_cursor_inner(
    db: &Db,
    source: BookkeepingSource,
    scope_key: &str,
    cursor_kind: &str,
    cursor_value: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO bookkeeping_sync_cursors (source, scope_key, cursor_kind, cursor_value) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(source, scope_key) DO UPDATE SET \
           cursor_kind = excluded.cursor_kind, \
           cursor_value = excluded.cursor_value, \
           updated_at = datetime('now')",
    )
    .bind(source)
    .bind(scope_key)
    .bind(cursor_kind)
    .bind(cursor_value)
    .execute(db)
    .await?;
    Ok(())
}

async fn bookkeeping_source_ref_exists(
    db: &Db,
    source: BookkeepingSource,
    source_ref: &str,
) -> Result<bool, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM bookkeeping_transactions WHERE source = ?1 AND source_ref = ?2 LIMIT 1",
    )
    .bind(source)
    .bind(source_ref)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// Extract a YYYY-MM-DD date prefix from an ISO timestamp (e.g. "2026-06-16T10:11:12Z").
fn iso_date_prefix(value: &str) -> Option<String> {
    if value.len() >= 10 && validate_date(&value[..10]).is_ok() {
        Some(value[..10].to_string())
    } else {
        None
    }
}

pub(crate) async fn sync_bookkeeping_gmail_receipts_with_provider<P: GmailReadProvider>(
    db: &Db,
    provider: &P,
    access_token: &str,
    input: SyncBookkeepingGmailReceiptsInput,
) -> Result<BookkeepingGmailSyncResult, AppError> {
    let project_id = clean_required(&input.project_id, "bookkeeping.gmail.project")?;
    ensure_project_exists(db, &project_id).await?;
    let query = clean_optional(input.query.as_deref());
    let max_results = input
        .max_results
        .unwrap_or(DEFAULT_GMAIL_MAX_RESULTS)
        .clamp(1, GMAIL_MAX_RESULTS_CAP);
    let mut label_ids = clean_string_vec(input.label_ids);
    let label_names = clean_string_vec(input.label_names);

    if label_ids.is_empty() && label_names.is_empty() && query.is_none() {
        return Err(AppError::validation(
            "bookkeeping.gmail.filter",
            "Gmail 라벨 또는 검색어를 지정하세요",
        ));
    }

    if !label_names.is_empty() {
        let labels = provider
            .list_labels(access_token)
            .await
            .map_err(AppError::from)?;
        for name in label_names {
            let Some(label) = labels.iter().find(|label| label.name == name) else {
                return Err(AppError::validation(
                    "bookkeeping.gmail.label_not_found",
                    format!("Gmail 라벨을 찾을 수 없습니다: {name}"),
                ));
            };
            label_ids.push(label.id.clone());
        }
    }
    label_ids.sort();
    label_ids.dedup();

    // Incremental polling: the per-project cursor (last seen date) drives a "current-point-forward"
    // query when the caller did not pin an explicit query. A failed sync leaves the cursor unchanged
    // so the next tick retries from the same point.
    let cursor =
        get_bookkeeping_sync_cursor_inner(db, BookkeepingSource::Gmail, &project_id).await?;
    let cursor_before = cursor.map(|c| c.cursor_value);
    let effective_query = match (query, &cursor_before) {
        // Explicit caller query intentionally overrides the cursor (one-shot full rescan).
        (Some(q), _) => Some(q),
        (None, Some(date)) => {
            // Widen one day back so a UTC cursor can't exclude an earlier-in-mailbox-TZ receipt;
            // pagination + source_ref dedup make the redundant re-scan harmless.
            let widened = date_minus_one_day(date).unwrap_or_else(|| date.clone());
            Some(format!("after:{}", widened.replace('-', "/")))
        }
        (None, None) => None,
    };

    let search = GmailMessageSearch {
        label_ids,
        query: effective_query,
        max_results,
    };
    let ids = match provider.list_message_ids(access_token, &search).await {
        Ok(ids) => ids,
        Err(e) => {
            record_bookkeeping_sync_job_inner(
                db,
                BookkeepingSource::Gmail,
                "failed",
                Some("gmail.list_failed"),
                Some(&e.to_string()),
                SyncCounts::default(),
                cursor_before.as_deref(),
                None,
            )
            .await?;
            return Err(AppError::from(e));
        }
    };

    let mut counts = SyncCounts::default();
    let mut max_seen_date = cursor_before.clone();

    for message_id in ids {
        counts.scanned += 1;
        let candidate = match provider
            .get_receipt_candidate(access_token, &message_id)
            .await
        {
            Ok(candidate) => candidate,
            Err(e) => {
                counts.failed += 1;
                record_bookkeeping_sync_status_inner(
                    db,
                    BookkeepingSource::Gmail,
                    "failed",
                    Some("gmail.message_fetch_failed"),
                    Some(&e.to_string()),
                )
                .await?;
                if matches!(e, crate::gmail::GmailError::ReconnectRequired(_)) {
                    return Err(AppError::from(e));
                }
                continue;
            }
        };

        let received_date = candidate.received_at.as_deref().and_then(iso_date_prefix);
        let existed =
            bookkeeping_source_ref_exists(db, BookkeepingSource::Gmail, &candidate.message_id)
                .await?;

        let created = ingest_bookkeeping_gmail_receipt_inner(
            db,
            BookkeepingEmailReceiptInput {
                project_id: Some(project_id.clone()),
                message_id: candidate.message_id,
                from: candidate.from,
                subject: candidate.subject,
                snippet: candidate.snippet,
                body_text: candidate.body_text,
                received_at: candidate.received_at,
            },
        )
        .await?;
        match created {
            Some(_) => {
                if existed {
                    counts.duplicate += 1;
                } else {
                    counts.imported += 1;
                    counts.review_needed += 1;
                }
                if let Some(date) = received_date {
                    if max_seen_date.as_deref().is_none_or(|m| date.as_str() > m) {
                        max_seen_date = Some(date);
                    }
                }
            }
            None => counts.failed += 1,
        }
    }

    let cursor_after = max_seen_date;
    if let Some(after) = cursor_after.as_deref() {
        upsert_bookkeeping_sync_cursor_inner(
            db,
            BookkeepingSource::Gmail,
            &project_id,
            "internal_date",
            after,
        )
        .await?;
    }
    record_bookkeeping_sync_job_inner(
        db,
        BookkeepingSource::Gmail,
        "succeeded",
        None,
        None,
        counts,
        cursor_before.as_deref(),
        cursor_after.as_deref(),
    )
    .await?;

    Ok(BookkeepingGmailSyncResult {
        scanned_count: counts.scanned,
        imported_count: counts.imported,
        duplicate_count: counts.duplicate,
        failed_count: counts.failed,
        cursor_after,
    })
}

pub(crate) async fn create_bookkeeping_recurring_expense_inner(
    db: &Db,
    input: CreateBookkeepingRecurringExpenseInput,
) -> Result<BookkeepingRecurringExpense, AppError> {
    let name = clean_required(&input.name, "bookkeeping.recurring.name")?;
    let merchant = clean_optional(input.merchant.as_deref());
    let category = clean_required(&input.category, "bookkeeping.category")?;
    let currency = clean_currency(&input.currency)?;
    validate_month(&input.start_month)?;
    if let Some(end_month) = input.end_month.as_deref() {
        validate_month(end_month)?;
        if end_month < input.start_month.as_str() {
            return Err(AppError::validation(
                "bookkeeping.recurring.end_month",
                "종료 월은 시작 월 이후여야 합니다",
            ));
        }
    }
    if input.amount_minor <= 0 {
        return Err(AppError::validation(
            "bookkeeping.amount",
            "금액은 0보다 커야 합니다",
        ));
    }
    if !(1..=31).contains(&input.schedule_day) {
        return Err(AppError::validation(
            "bookkeeping.recurring.schedule_day",
            "결제일은 1~31 범위여야 합니다",
        ));
    }
    if matches!(input.expense_kind, BookkeepingExpenseKind::Variable) {
        return Err(AppError::validation(
            "bookkeeping.recurring.expense_kind",
            "고정비는 variable이 될 수 없습니다",
        ));
    }
    let payment_method_label = clean_optional(input.payment_method_label.as_deref());
    let payment_method_last4 = clean_payment_last4(input.payment_method_last4.as_deref())?;
    let note = clean_optional(input.note.as_deref());
    let status = BookkeepingRecurringExpenseStatus::Active;
    let insert_sql = format!(
        "INSERT INTO bookkeeping_recurring_expenses \
         (id, project_id, name, merchant, amount_minor, currency, category, payment_method_kind, \
          payment_method_label, payment_method_last4, expense_kind, schedule_day, start_month, \
          end_month, status, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) \
         RETURNING {RECURRING_EXPENSE_RETURNING_COLUMNS}"
    );

    let row = sqlx::query_as::<_, BookkeepingRecurringExpense>(&insert_sql)
        .bind(input.project_id.as_deref())
        .bind(&name)
        .bind(merchant.as_deref())
        .bind(input.amount_minor)
        .bind(&currency)
        .bind(&category)
        .bind(input.payment_method_kind)
        .bind(payment_method_label.as_deref())
        .bind(payment_method_last4.as_deref())
        .bind(input.expense_kind)
        .bind(input.schedule_day)
        .bind(&input.start_month)
        .bind(input.end_month.as_deref())
        .bind(status)
        .bind(note.as_deref())
        .fetch_one(db)
        .await?;
    Ok(row)
}

pub(crate) async fn list_bookkeeping_recurring_expenses_inner(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingRecurringExpense>, AppError> {
    let sql = format!(
        "SELECT {RECURRING_EXPENSE_RETURNING_COLUMNS} \
         FROM bookkeeping_recurring_expenses \
         WHERE (?1 IS NULL OR project_id = ?1) \
         ORDER BY status ASC, start_month DESC, name ASC \
         LIMIT 200"
    );
    Ok(sqlx::query_as::<_, BookkeepingRecurringExpense>(&sql)
        .bind(project_id)
        .fetch_all(db)
        .await?)
}

pub(crate) async fn ensure_bookkeeping_recurring_occurrences_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingRecurringOccurrence>, AppError> {
    validate_month(month)?;
    let rules = sqlx::query_as::<_, BookkeepingRecurringExpense>(
        "SELECT id, project_id, name, merchant, amount_minor, currency, category, \
           payment_method_kind, payment_method_label, payment_method_last4, expense_kind, \
           schedule_day, start_month, end_month, status, note, created_at, updated_at \
         FROM bookkeeping_recurring_expenses \
         WHERE status = 'active' \
           AND start_month <= ?1 \
           AND (end_month IS NULL OR end_month >= ?1) \
           AND (?2 IS NULL OR project_id = ?2)",
    )
    .bind(month)
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let mut tx = db.begin().await?;
    for rule in rules {
        let due_date = due_date_for_month(month, rule.schedule_day)?;
        sqlx::query(
            "INSERT INTO bookkeeping_recurring_occurrences \
             (id, recurring_expense_id, month, due_date, amount_minor, currency, status, note) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'planned', ?6) \
             ON CONFLICT(recurring_expense_id, month) DO NOTHING",
        )
        .bind(&rule.id)
        .bind(month)
        .bind(&due_date)
        .bind(rule.amount_minor)
        .bind(&rule.currency)
        .bind(rule.note.as_deref())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    list_bookkeeping_recurring_occurrences_inner(db, month, project_id).await
}

pub(crate) async fn list_bookkeeping_recurring_occurrences_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingRecurringOccurrence>, AppError> {
    validate_month(month)?;
    let sql = recurring_occurrence_select_sql(
        "WHERE o.month = ?1 AND (?2 IS NULL OR e.project_id = ?2) \
         ORDER BY o.due_date ASC, e.name ASC, o.id ASC",
    );
    Ok(sqlx::query_as::<_, BookkeepingRecurringOccurrence>(&sql)
        .bind(month)
        .bind(project_id)
        .fetch_all(db)
        .await?)
}

pub(crate) async fn post_bookkeeping_recurring_occurrence_inner(
    db: &Db,
    id: &str,
) -> Result<BookkeepingRecurringOccurrence, AppError> {
    let id = clean_required(id, "bookkeeping.recurring.occurrence_id")?;
    let mut tx = db.begin().await?;
    let fetch_sql = recurring_occurrence_select_sql("WHERE o.id = ?1");
    let occurrence = sqlx::query_as::<_, BookkeepingRecurringOccurrence>(&fetch_sql)
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if occurrence.status == BookkeepingRecurringOccurrenceStatus::Posted {
        tx.commit().await?;
        return Ok(occurrence);
    }
    if occurrence.status == BookkeepingRecurringOccurrenceStatus::Skipped {
        return Err(AppError::validation(
            "bookkeeping.recurring.skipped",
            "건너뛴 고정비는 먼저 예정 상태로 되돌리세요",
        ));
    }
    let merchant = occurrence
        .merchant
        .clone()
        .unwrap_or_else(|| occurrence.recurring_name.clone());
    let insert_sql = format!(
        "INSERT INTO bookkeeping_transactions \
         (id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
          spent_at, category, review_status, note, payment_method_kind, payment_method_label, \
          payment_method_last4, expense_kind, recurring_expense_id, recurring_occurrence_id, reviewed_at) \
         SELECT lower(hex(randomblob(16))), e.project_id, 'manual', NULL, ?2, e.name, o.amount_minor, \
          o.currency, o.due_date, e.category, 'approved', o.note, e.payment_method_kind, \
          e.payment_method_label, e.payment_method_last4, e.expense_kind, e.id, o.id, datetime('now') \
         FROM bookkeeping_recurring_occurrences o \
         JOIN bookkeeping_recurring_expenses e ON e.id = o.recurring_expense_id \
         WHERE o.id = ?1 \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    );
    let created = sqlx::query_as::<_, BookkeepingTransaction>(&insert_sql)
        .bind(&id)
        .bind(&merchant)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE bookkeeping_recurring_occurrences SET \
           status='posted', transaction_id=?2, updated_at=datetime('now') \
         WHERE id=?1",
    )
    .bind(&id)
    .bind(&created.id)
    .execute(&mut *tx)
    .await?;
    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &created.id,
        "transaction.recurring_posted",
        "고정비 예정 건이 거래로 확정됨",
        serde_json::json!({
            "recurringExpenseId": occurrence.recurring_expense_id,
            "recurringOccurrenceId": occurrence.id,
            "expenseKind": created.expense_kind
        }),
    )
    .await?;
    tx.commit().await?;

    let sql = recurring_occurrence_select_sql("WHERE o.id = ?1");
    Ok(sqlx::query_as::<_, BookkeepingRecurringOccurrence>(&sql)
        .bind(&id)
        .fetch_one(db)
        .await?)
}

pub(crate) async fn set_bookkeeping_recurring_occurrence_status_inner(
    db: &Db,
    id: &str,
    status: BookkeepingRecurringOccurrenceStatus,
) -> Result<BookkeepingRecurringOccurrence, AppError> {
    if status == BookkeepingRecurringOccurrenceStatus::Posted {
        return post_bookkeeping_recurring_occurrence_inner(db, id).await;
    }
    let id = clean_required(id, "bookkeeping.recurring.occurrence_id")?;
    sqlx::query(
        "UPDATE bookkeeping_recurring_occurrences SET \
           status=?2, transaction_id=CASE WHEN ?2='planned' THEN NULL ELSE transaction_id END, \
           updated_at=datetime('now') \
         WHERE id=?1",
    )
    .bind(&id)
    .bind(status)
    .execute(db)
    .await?;
    let sql = recurring_occurrence_select_sql("WHERE o.id = ?1");
    Ok(sqlx::query_as::<_, BookkeepingRecurringOccurrence>(&sql)
        .bind(&id)
        .fetch_one(db)
        .await?)
}

pub(crate) async fn list_bookkeeping_transactions_inner(
    db: &Db,
    status: Option<BookkeepingReviewStatus>,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    let list_sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} \
         FROM bookkeeping_transactions \
         WHERE (?1 IS NULL OR review_status = ?1) \
           AND (?2 IS NULL OR project_id = ?2) \
           AND deleted_at IS NULL \
         ORDER BY spent_at DESC, updated_at DESC, id DESC \
         LIMIT 200"
    );
    let rows = sqlx::query_as::<_, BookkeepingTransaction>(&list_sql)
        .bind(status)
        .bind(project_id)
        .fetch_all(db)
        .await?;
    Ok(rows)
}

pub(crate) async fn list_bookkeeping_trash_inner(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    let list_sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} \
         FROM bookkeeping_transactions \
         WHERE (deleted_at IS NOT NULL OR review_status = 'ignored') \
           AND (?1 IS NULL OR project_id = ?1) \
         ORDER BY COALESCE(deleted_at, reviewed_at, updated_at) DESC, id DESC \
         LIMIT 200"
    );
    let rows = sqlx::query_as::<_, BookkeepingTransaction>(&list_sql)
        .bind(project_id)
        .fetch_all(db)
        .await?;
    Ok(rows)
}

pub(crate) async fn update_bookkeeping_review_status_inner(
    db: &Db,
    id: &str,
    status: BookkeepingReviewStatus,
) -> Result<BookkeepingTransaction, AppError> {
    let mut tx = db.begin().await?;
    let update_sql = format!(
        "UPDATE bookkeeping_transactions SET \
           review_status=?2, \
           reviewed_at=CASE WHEN ?2='needs_review' THEN NULL ELSE datetime('now') END, \
           updated_at=datetime('now') \
         WHERE id=?1 \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&update_sql)
        .bind(id)
        .bind(status)
        .fetch_one(&mut *tx)
        .await?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        id,
        "transaction.review_status_changed",
        "거래 리뷰 상태가 변경됨",
        serde_json::json!({ "reviewStatus": status }),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}

/// 벌크 리뷰 상태 변경. 각 항목을 독립 처리(best-effort) — 한 항목 실패가 배치를 중단시키지
/// 않는다. 변이는 단일 `update_bookkeeping_review_status_inner`(자체 tx + 감사 기록)에 위임하고
/// 그 `Result`만 건별 결과로 분류한다(변이 로직 단일 소스).
pub(crate) async fn bulk_update_bookkeeping_review_status_inner(
    db: &Db,
    ids: &[String],
    status: BookkeepingReviewStatus,
) -> Vec<BookkeepingBulkItemResult> {
    let mut out = Vec::with_capacity(ids.len());
    for raw in ids {
        let id = raw.trim();
        let result = match update_bookkeeping_review_status_inner(db, id, status).await {
            Ok(_) => BookkeepingBulkItemResult {
                id: id.to_string(),
                ok: true,
                message: None,
            },
            Err(e) => BookkeepingBulkItemResult {
                id: id.to_string(),
                ok: false,
                message: Some(e.to_string()),
            },
        };
        out.push(result);
    }
    out
}

/// 벌크 분류 지정. `override_bookkeeping_category_inner`가 자체 tx와 audit row를 소유하므로,
/// 호출자는 공유 tx를 만들지 않고 항목별 best-effort로 위임한다.
pub(crate) async fn bulk_set_bookkeeping_category_inner(
    db: &Db,
    ids: &[String],
    category_code: Option<&str>,
    subcategory_code: Option<&str>,
    reason: Option<&str>,
) -> Vec<BookkeepingBulkItemResult> {
    let mut out = Vec::with_capacity(ids.len());
    for raw in ids {
        let id = raw.trim();
        let result = match override_bookkeeping_category_inner(
            db,
            OverrideBookkeepingCategoryInput {
                transaction_id: id.to_string(),
                category_code: category_code.map(str::to_string),
                subcategory_code: subcategory_code.map(str::to_string),
                reason: reason.map(str::to_string),
            },
        )
        .await
        {
            Ok(_) => BookkeepingBulkItemResult {
                id: id.to_string(),
                ok: true,
                message: None,
            },
            Err(e) => BookkeepingBulkItemResult {
                id: id.to_string(),
                ok: false,
                message: Some(e.to_string()),
            },
        };
        out.push(result);
    }
    out
}

/// 벌크 소프트 삭제. 기존 삭제 inner가 검증, tx, 감사 기록을 소유하므로 항목별로 재사용한다.
pub(crate) async fn bulk_delete_bookkeeping_transactions_inner(
    db: &Db,
    ids: &[String],
) -> Vec<BookkeepingBulkItemResult> {
    let mut out = Vec::with_capacity(ids.len());
    for raw in ids {
        let id = raw.trim();
        let result = match delete_bookkeeping_transaction_inner(db, id).await {
            Ok(_) => BookkeepingBulkItemResult {
                id: id.to_string(),
                ok: true,
                message: None,
            },
            Err(e) => BookkeepingBulkItemResult {
                id: id.to_string(),
                ok: false,
                message: Some(e.to_string()),
            },
        };
        out.push(result);
    }
    out
}

pub(crate) async fn update_bookkeeping_transaction_inner(
    db: &Db,
    input: UpdateBookkeepingTransactionInput,
) -> Result<BookkeepingTransaction, AppError> {
    let tx_id = clean_required(&input.id, "bookkeeping.transaction_id")?;
    let current = fetch_bookkeeping_transaction(db, &tx_id).await?;

    let merchant = match input.merchant.as_deref() {
        Some(value) => clean_required(value, "bookkeeping.merchant")?,
        None => current.merchant.clone(),
    };
    let description = match input.description.as_deref() {
        Some(value) => clean_optional(Some(value)),
        None => current.description.clone(),
    };
    let amount_minor = match input.amount_minor {
        Some(value) if value > 0 => value,
        Some(_) => {
            return Err(AppError::validation(
                "bookkeeping.amount",
                "금액은 0보다 커야 합니다",
            ))
        }
        None => current.amount_minor,
    };
    let currency = match input.currency.as_deref() {
        Some(value) => clean_currency(value)?,
        None => current.currency.clone(),
    };
    let spent_at = match input.spent_at.as_deref() {
        Some(value) => {
            validate_date(value)?;
            value.to_string()
        }
        None => current.spent_at.clone(),
    };
    let spent_at_time = match input.spent_at_time {
        Some(Some(value)) => {
            let cleaned = clean_optional(Some(value.as_str()));
            if let Some(time) = cleaned.as_deref() {
                validate_time(time)?;
            }
            cleaned
        }
        Some(None) => None,
        None => current.spent_at_time.clone(),
    };
    let direction = match input.direction.as_deref() {
        Some(value) => parse_bookkeeping_direction(value)?,
        None => current.direction,
    };
    let note = match input.note.as_deref() {
        Some(value) => clean_optional(Some(value)),
        None => current.note.clone(),
    };
    let account = match input.account.as_deref() {
        Some(value) => clean_optional(Some(value)),
        None => current.account.clone(),
    };
    let payment_method_kind = input
        .payment_method_kind
        .unwrap_or(current.payment_method_kind);
    let payment_method_label = match input.payment_method_label.as_deref() {
        Some(value) => clean_optional(Some(value)),
        None => current.payment_method_label.clone(),
    };
    let payment_method_last4 = match input.payment_method_last4.as_deref() {
        Some(value) => clean_payment_last4(Some(value))?,
        None => current.payment_method_last4.clone(),
    };
    let expense_kind = input.expense_kind.unwrap_or(current.expense_kind);
    let order_no = match input.order_no.as_deref() {
        Some(value) => clean_optional(Some(value)),
        None => current.order_no.clone(),
    };
    let payment_no = match input.payment_no.as_deref() {
        Some(value) => clean_optional(Some(value)),
        None => current.payment_no.clone(),
    };
    let category_code = input
        .category_code
        .as_deref()
        .map(|value| clean_optional(Some(value)))
        .unwrap_or_else(|| current.category_code.clone());
    let subcategory_code = input
        .subcategory_code
        .as_deref()
        .map(|value| clean_optional(Some(value)))
        .unwrap_or_else(|| current.subcategory_code.clone());
    let category_changed =
        category_code != current.category_code || subcategory_code != current.subcategory_code;
    let amount_changed = amount_minor != current.amount_minor;

    let mut tx = db.begin().await?;
    let update_sql = format!(
        "UPDATE bookkeeping_transactions SET \
           merchant=?2, description=?3, amount_minor=?4, currency=?5, spent_at=?6, \
           spent_at_time=?7, direction=?8, note=?9, account=?10, \
           payment_method_kind=?11, payment_method_label=?12, payment_method_last4=?13, \
           expense_kind=?14, order_no=?15, payment_no=?16, updated_at=datetime('now') \
         WHERE id=?1 \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&update_sql)
        .bind(&tx_id)
        .bind(&merchant)
        .bind(description.as_deref())
        .bind(amount_minor)
        .bind(&currency)
        .bind(&spent_at)
        .bind(spent_at_time.as_deref())
        .bind(direction)
        .bind(note.as_deref())
        .bind(account.as_deref())
        .bind(payment_method_kind)
        .bind(payment_method_label.as_deref())
        .bind(payment_method_last4.as_deref())
        .bind(expense_kind)
        .bind(order_no.as_deref())
        .bind(payment_no.as_deref())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::not_found(
                "bookkeeping.transaction_not_found",
                "거래를 찾을 수 없습니다",
            )
        })?;

    if amount_changed {
        let (items_sum, item_count): (i64, i64) = sqlx::query_as(
            "SELECT COALESCE(SUM(amount_minor * quantity), 0), COUNT(*) \
             FROM bookkeeping_transaction_line_items WHERE transaction_id = ?1",
        )
        .bind(&tx_id)
        .fetch_one(&mut *tx)
        .await?;
        let mismatch = item_count > 0 && items_sum != i64::from(amount_minor);
        update_sum_mismatch_reason_tx(
            &mut tx,
            &tx_id,
            mismatch,
            items_sum,
            i64::from(amount_minor),
        )
        .await?;
    }

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &tx_id,
        "transaction.updated",
        "거래 필드가 수정됨",
        serde_json::json!({
            "amountChanged": amount_changed,
            "categoryChanged": category_changed
        }),
    )
    .await?;
    tx.commit().await?;

    if category_changed {
        override_bookkeeping_category_inner(
            db,
            OverrideBookkeepingCategoryInput {
                transaction_id: tx_id.clone(),
                category_code,
                subcategory_code,
                reason: Some("transaction_edit".to_string()),
            },
        )
        .await?;
    }

    if amount_changed || category_changed {
        fetch_bookkeeping_transaction(db, &tx_id).await
    } else {
        Ok(row)
    }
}

pub(crate) async fn delete_bookkeeping_transaction_inner(
    db: &Db,
    id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    set_bookkeeping_deleted_at(db, id, true).await
}

pub(crate) async fn restore_bookkeeping_transaction_inner(
    db: &Db,
    id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    set_bookkeeping_deleted_at(db, id, false).await
}

async fn set_bookkeeping_deleted_at(
    db: &Db,
    id: &str,
    deleted: bool,
) -> Result<BookkeepingTransaction, AppError> {
    let tx_id = clean_required(id, "bookkeeping.transaction_id")?;
    let mut tx = db.begin().await?;
    let sql = if deleted {
        format!(
            "UPDATE bookkeeping_transactions SET deleted_at=datetime('now'), \
             updated_at=datetime('now') WHERE id=?1 RETURNING {TRANSACTION_RETURNING_COLUMNS}"
        )
    } else {
        format!(
            "UPDATE bookkeeping_transactions SET deleted_at=NULL, updated_at=datetime('now') \
             WHERE id=?1 RETURNING {TRANSACTION_RETURNING_COLUMNS}"
        )
    };
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&sql)
        .bind(&tx_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::not_found(
                "bookkeeping.transaction_not_found",
                "거래를 찾을 수 없습니다",
            )
        })?;
    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &tx_id,
        if deleted {
            "transaction.deleted"
        } else {
            "transaction.restored"
        },
        if deleted {
            "거래가 휴지통으로 이동됨"
        } else {
            "거래가 휴지통에서 복원됨"
        },
        serde_json::json!({ "deleted": deleted }),
    )
    .await?;
    tx.commit().await?;
    Ok(row)
}

pub(crate) async fn bookkeeping_monthly_summary_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<BookkeepingMonthlySummary, AppError> {
    let (start, end) = month_bounds(month)?;
    // Category breakdown is EXPENSE only (income has no expense taxonomy). Non-ignored, non-deleted
    // rows.
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT category, COALESCE(SUM(amount_minor), 0), COUNT(*) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 AND review_status != 'ignored' \
           AND direction = 'expense' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3) \
         GROUP BY category \
         ORDER BY COALESCE(SUM(amount_minor), 0) DESC, category ASC",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let categories: Vec<BookkeepingCategorySummary> = rows
        .into_iter()
        .map(|(category, amount, count)| BookkeepingCategorySummary {
            category,
            amount_minor: amount.max(0).min(i32::MAX as i64) as i32,
            count: count.max(0).min(u32::MAX as i64) as u32,
        })
        .collect();

    // Direction totals (KRW-scoped: net only meaningful in a single currency; the app is
    // KRW-default and net mixes amounts as-is — surfaced per the CFO contract assumption).
    let (expense_total, income_total): (i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN direction='expense' THEN amount_minor ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN direction='income' THEN amount_minor ELSE 0 END), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 AND review_status != 'ignored' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3)",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let total_expense_minor = expense_total.max(0).min(i32::MAX as i64) as i32;
    let total_income_minor = income_total.max(0).min(i32::MAX as i64) as i32;
    let net_minor = (income_total - expense_total).clamp(i32::MIN as i64, i32::MAX as i64) as i32;

    // Duplicates are review_status='ignored' AND duplicate_of_transaction_id present; keep them out
    // of the user-driven ignored_count so the two metrics don't conflate.
    let (needs_review, approved, ignored, duplicate): (i64, i64, i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN review_status='needs_review' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN review_status='approved' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN review_status='ignored' AND duplicate_of_transaction_id IS NULL THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN review_status='ignored' AND duplicate_of_transaction_id IS NOT NULL THEN 1 ELSE 0 END), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3)",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id)
    .fetch_one(db)
    .await?;

    Ok(BookkeepingMonthlySummary {
        month: month.to_string(),
        // Legacy alias retained for one release; MUST equal expense total (not the old all-rows sum).
        total_amount_minor: total_expense_minor,
        total_expense_minor,
        total_income_minor,
        net_minor,
        needs_review_count: needs_review.max(0).min(u32::MAX as i64) as u32,
        approved_count: approved.max(0).min(u32::MAX as i64) as u32,
        ignored_count: ignored.max(0).min(u32::MAX as i64) as u32,
        duplicate_count: duplicate.max(0).min(u32::MAX as i64) as u32,
        categories,
    })
}

pub(crate) async fn set_bookkeeping_budget_inner(
    db: &Db,
    input: SetBookkeepingBudgetInput,
) -> Result<BookkeepingBudget, AppError> {
    validate_month(&input.month)?;
    if input.limit_minor < 0 {
        return Err(AppError::validation(
            "bookkeeping.budget.limit",
            "예산은 0 이상이어야 합니다",
        ));
    }
    let project_id = clean_optional(input.project_id.as_deref());
    if let Some(project_id) = project_id.as_deref() {
        ensure_budget_project_exists(db, project_id).await?;
    }
    let category_code = clean_required(&input.category_code, "bookkeeping.budget.category")?;
    let currency = clean_currency(input.currency.as_deref().unwrap_or(DEFAULT_CURRENCY))?;
    let note = clean_optional(input.note.as_deref());

    let existing: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM bookkeeping_budgets \
         WHERE COALESCE(project_id, '') = COALESCE(?1, '') AND month = ?2 AND category_code = ?3",
    )
    .bind(project_id.as_deref())
    .bind(&input.month)
    .bind(&category_code)
    .fetch_optional(db)
    .await?;

    let id = if let Some((id,)) = existing {
        sqlx::query(
            "UPDATE bookkeeping_budgets \
             SET limit_minor = ?2, currency = ?3, rollover = ?4, note = ?5, updated_at = datetime('now') \
             WHERE id = ?1",
        )
        .bind(&id)
        .bind(input.limit_minor)
        .bind(&currency)
        .bind(input.rollover)
        .bind(note.as_deref())
        .execute(db)
        .await?;
        id
    } else {
        let row: (String,) = sqlx::query_as(
            "INSERT INTO bookkeeping_budgets \
             (id, project_id, month, category_code, limit_minor, currency, rollover, note) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7) \
             RETURNING id",
        )
        .bind(project_id.as_deref())
        .bind(&input.month)
        .bind(&category_code)
        .bind(input.limit_minor)
        .bind(&currency)
        .bind(input.rollover)
        .bind(note.as_deref())
        .fetch_one(db)
        .await?;
        row.0
    };

    fetch_bookkeeping_budget(db, &id).await
}

pub(crate) async fn list_bookkeeping_budgets_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingBudget>, AppError> {
    validate_month(month)?;
    let project_id = clean_optional(project_id);
    let rows = sqlx::query_as::<_, BookkeepingBudget>(&format!(
        "SELECT {BUDGET_RETURNING_COLUMNS} FROM bookkeeping_budgets \
         WHERE month = ?1 AND COALESCE(project_id, '') = COALESCE(?2, '') \
         ORDER BY category_code ASC"
    ))
    .bind(month)
    .bind(project_id.as_deref())
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub(crate) async fn delete_bookkeeping_budget_inner(db: &Db, id: &str) -> Result<bool, AppError> {
    let id = clean_required(id, "bookkeeping.budget.id")?;
    let result = sqlx::query("DELETE FROM bookkeeping_budgets WHERE id = ?1")
        .bind(&id)
        .execute(db)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub(crate) async fn bookkeeping_budget_status_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingBudgetStatus>, AppError> {
    let budgets = list_bookkeeping_budgets_inner(db, month, project_id).await?;
    let mut rows = Vec::with_capacity(budgets.len());

    for budget in budgets {
        let spent = spent_for_budget_category(
            db,
            &budget.month,
            budget.project_id.as_deref(),
            &budget.category_code,
        )
        .await?;
        let rollover_in = if budget.rollover {
            rollover_in_for_budget(
                db,
                &budget.month,
                budget.project_id.as_deref(),
                &budget.category_code,
            )
            .await?
        } else {
            0
        };
        let available = budget.limit_minor.saturating_add(rollover_in);
        let remaining = available - spent;
        let pct = if available > 0 {
            spent as f64 / available as f64
        } else {
            0.0
        };
        let label = category_label(db, &budget.category_code).await?;
        rows.push(BookkeepingBudgetStatus {
            category_code: budget.category_code,
            label,
            limit_minor: budget.limit_minor,
            spent_minor: spent,
            remaining_minor: remaining,
            rollover_in_minor: rollover_in,
            rollover: budget.rollover,
            pct,
            currency: budget.currency,
        });
    }

    rows.sort_by(|a, b| {
        b.pct
            .partial_cmp(&a.pct)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.category_code.cmp(&b.category_code))
    });
    Ok(rows)
}

pub(crate) async fn list_bookkeeping_audit_inner(
    db: &Db,
    entity_id: Option<String>,
) -> Result<Vec<BookkeepingAuditEntry>, AppError> {
    let rows = sqlx::query_as::<_, BookkeepingAuditEntry>(
        "SELECT id, entity_type, entity_id, action, summary, metadata_json, created_at \
         FROM bookkeeping_audit_log \
         WHERE (?1 IS NULL OR entity_id = ?1) \
         ORDER BY created_at DESC, rowid DESC \
         LIMIT 200",
    )
    .bind(entity_id.as_deref())
    .fetch_all(db)
    .await?;
    Ok(rows)
}

pub(crate) async fn record_bookkeeping_sync_failure_inner(
    db: &Db,
    input: RecordBookkeepingSyncFailureInput,
) -> Result<BookkeepingSyncJob, AppError> {
    if matches!(input.source, BookkeepingSource::Manual) {
        return Err(AppError::validation(
            "bookkeeping.sync.source",
            "수동 입력은 sync job source가 아닙니다",
        ));
    }
    let code = clean_required(&input.error_code, "bookkeeping.sync.error_code")?;
    record_bookkeeping_sync_status_inner(
        db,
        input.source,
        "failed",
        Some(&code),
        Some(&input.raw_error_message),
    )
    .await
}

async fn record_bookkeeping_sync_status_inner(
    db: &Db,
    source: BookkeepingSource,
    status: &str,
    error_code: Option<&str>,
    raw_error_message: Option<&str>,
) -> Result<BookkeepingSyncJob, AppError> {
    record_bookkeeping_sync_job_inner(
        db,
        source,
        status,
        error_code,
        raw_error_message,
        SyncCounts::default(),
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn record_bookkeeping_sync_job_inner(
    db: &Db,
    source: BookkeepingSource,
    status: &str,
    error_code: Option<&str>,
    raw_error_message: Option<&str>,
    counts: SyncCounts,
    cursor_before: Option<&str>,
    cursor_after: Option<&str>,
) -> Result<BookkeepingSyncJob, AppError> {
    if matches!(source, BookkeepingSource::Manual) {
        return Err(AppError::validation(
            "bookkeeping.sync.source",
            "수동 입력은 sync job source가 아닙니다",
        ));
    }
    let sanitized_error_message = raw_error_message.map(sanitize_sync_error_message);
    let mut tx = db.begin().await?;
    let insert_sql = format!(
        "INSERT INTO bookkeeping_sync_jobs \
         (id, source, status, started_at, finished_at, sanitized_error_code, \
          sanitized_error_message, scanned_count, imported_count, duplicate_count, \
          review_needed_count, failed_count, cursor_before, cursor_after) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, datetime('now'), datetime('now'), ?3, ?4, \
          ?5, ?6, ?7, ?8, ?9, ?10, ?11) \
         RETURNING {SYNC_JOB_COLUMNS}"
    );
    let job = sqlx::query_as::<_, BookkeepingSyncJob>(&insert_sql)
        .bind(source)
        .bind(status)
        .bind(error_code)
        .bind(sanitized_error_message.as_deref())
        .bind(counts.scanned)
        .bind(counts.imported)
        .bind(counts.duplicate)
        .bind(counts.review_needed)
        .bind(counts.failed)
        .bind(cursor_before)
        .bind(cursor_after)
        .fetch_one(&mut *tx)
        .await?;

    let action = if status == "succeeded" {
        "sync.succeeded"
    } else {
        "sync.failed"
    };
    let summary = if status == "succeeded" {
        "가계부 sync job 성공이 기록됨"
    } else {
        "가계부 sync job 실패가 기록됨"
    };
    insert_audit_log_tx(
        &mut tx,
        "sync_job",
        &job.id,
        action,
        summary,
        serde_json::json!({ "source": source, "code": error_code }),
    )
    .await?;
    tx.commit().await?;
    Ok(job)
}

pub(crate) async fn list_bookkeeping_sync_jobs_inner(
    db: &Db,
) -> Result<Vec<BookkeepingSyncJob>, AppError> {
    let list_sql = format!(
        "SELECT {SYNC_JOB_COLUMNS} FROM bookkeeping_sync_jobs \
         ORDER BY updated_at DESC, id DESC LIMIT 50"
    );
    let rows = sqlx::query_as::<_, BookkeepingSyncJob>(&list_sql)
        .fetch_all(db)
        .await?;
    Ok(rows)
}

// ── Category taxonomy + alias resolution (Phase B) ──────────────────────────────────────────────

/// Resolver output: a resolved taxonomy code pair + confidence (None = caller-authoritative).
#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedCategory {
    pub category_code: Option<String>,
    pub subcategory_code: Option<String>,
    pub confidence: Option<f64>,
}

/// Normalize a category/merchant label for matching: keep alphanumerics (incl. Hangul), collapse
/// whitespace, drop emoji/symbols. "🪑 생활용품" → "생활용품"; "주유·충전" → "주유 충전" (· dropped).
fn normalize_label(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for ch in value.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            out.push(ch);
            pending_space = false;
        } else if ch.is_whitespace() {
            pending_space = true;
        }
        // emoji / punctuation are dropped
    }
    out.trim().to_string()
}

pub(crate) async fn list_bookkeeping_taxonomy_inner(
    db: &Db,
) -> Result<Vec<BookkeepingCategoryNode>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingCategoryNode>(
        "SELECT code, parent_code, label, sort_order, active \
         FROM bookkeeping_category_taxonomy \
         ORDER BY sort_order ASC, code ASC",
    )
    .fetch_all(db)
    .await?)
}

pub(crate) async fn list_bookkeeping_category_aliases_inner(
    db: &Db,
) -> Result<Vec<BookkeepingCategoryAlias>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingCategoryAlias>(
        "SELECT id, pattern, match_kind, category_code, subcategory_code, confidence, source, \
           created_at \
         FROM bookkeeping_category_alias \
         ORDER BY match_kind ASC, pattern ASC",
    )
    .fetch_all(db)
    .await?)
}

pub(crate) async fn bookkeeping_category_rules_inner(
    db: &Db,
) -> Result<BookkeepingCategoryRules, AppError> {
    Ok(BookkeepingCategoryRules {
        taxonomy: list_bookkeeping_taxonomy_inner(db).await?,
        aliases: list_bookkeeping_category_aliases_inner(db).await?,
    })
}

/// Resolve a taxonomy code from caller hints. Precedence: explicit `provided_code` → a non-sentinel
/// `category_hint` that is a real taxonomy code → raw-label alias → raw-label taxonomy match →
/// merchant alias → `uncategorized`. Tolerates codes absent from the taxonomy (soft ref).
pub(crate) async fn resolve_category_inner(
    db: &Db,
    provided_code: Option<&str>,
    provided_subcategory: Option<&str>,
    category_hint: &str,
    raw_category: Option<&str>,
    merchant: &str,
) -> Result<ResolvedCategory, AppError> {
    if let Some(code) = provided_code.map(str::trim).filter(|c| !c.is_empty()) {
        return Ok(ResolvedCategory {
            category_code: Some(code.to_string()),
            subcategory_code: provided_subcategory
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            confidence: None,
        });
    }

    let rules = bookkeeping_category_rules_inner(db).await?;

    // A non-sentinel category hint that is itself a real top-level/sub code is honored as-is.
    let hint = category_hint.trim();
    if !hint.is_empty() && hint != "uncategorized" && rules.taxonomy.iter().any(|n| n.code == hint)
    {
        return Ok(ResolvedCategory {
            category_code: Some(hint.to_string()),
            subcategory_code: provided_subcategory
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .map(str::to_string),
            confidence: None,
        });
    }

    if let Some(raw) = raw_category {
        let norm = normalize_label(raw);
        if !norm.is_empty() {
            if let Some(alias) = rules.aliases.iter().find(|a| {
                a.match_kind == BookkeepingAliasMatchKind::RawLabel
                    && normalize_label(&a.pattern) == norm
            }) {
                return Ok(ResolvedCategory {
                    category_code: Some(alias.category_code.clone()),
                    subcategory_code: alias.subcategory_code.clone(),
                    confidence: Some(alias.confidence),
                });
            }
            if let Some(node) = rules
                .taxonomy
                .iter()
                .find(|n| n.active && normalize_label(&n.label) == norm)
            {
                let (category_code, subcategory_code) = match &node.parent_code {
                    Some(parent) => (parent.clone(), Some(node.code.clone())),
                    None => (node.code.clone(), None),
                };
                return Ok(ResolvedCategory {
                    category_code: Some(category_code),
                    subcategory_code,
                    confidence: Some(0.95),
                });
            }
        }
    }

    let merchant = merchant.trim();
    if !merchant.is_empty() {
        if let Some(alias) = rules.aliases.iter().find(|a| {
            a.match_kind == BookkeepingAliasMatchKind::Merchant && a.pattern.trim() == merchant
        }) {
            return Ok(ResolvedCategory {
                category_code: Some(alias.category_code.clone()),
                subcategory_code: alias.subcategory_code.clone(),
                confidence: Some(alias.confidence),
            });
        }
    }

    Ok(ResolvedCategory {
        category_code: Some("uncategorized".to_string()),
        subcategory_code: None,
        confidence: Some(0.0),
    })
}

async fn category_labels_for_codes(
    db: &Db,
    category_code: Option<&str>,
    subcategory_code: Option<&str>,
) -> Result<(String, Option<String>), AppError> {
    let category_label = match category_code {
        Some(code) => taxonomy_label(db, code)
            .await?
            .unwrap_or_else(|| code.to_string()),
        None => "미분류".to_string(),
    };
    let subcategory_label = match subcategory_code {
        Some(code) => Some(
            taxonomy_label(db, code)
                .await?
                .unwrap_or_else(|| code.to_string()),
        ),
        None => None,
    };
    Ok((category_label, subcategory_label))
}

async fn taxonomy_label(db: &Db, code: &str) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT label FROM bookkeeping_category_taxonomy WHERE code = ?1")
            .bind(code)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(label,)| label))
}

pub(crate) async fn override_bookkeeping_category_inner(
    db: &Db,
    input: OverrideBookkeepingCategoryInput,
) -> Result<BookkeepingTransaction, AppError> {
    let tx_id = clean_required(&input.transaction_id, "bookkeeping.override.transaction_id")?;
    let to_code = clean_optional(input.category_code.as_deref());
    let to_subcategory = clean_optional(input.subcategory_code.as_deref());
    let reason = clean_optional(input.reason.as_deref());
    let (category_label, subcategory_label) =
        category_labels_for_codes(db, to_code.as_deref(), to_subcategory.as_deref()).await?;

    let mut tx = db.begin().await?;
    let current: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT category_code, subcategory_code FROM bookkeeping_transactions WHERE id = ?1",
    )
    .bind(&tx_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found("bookkeeping.override.not_found", "거래를 찾을 수 없습니다")
    })?;

    sqlx::query(
        "UPDATE bookkeeping_transactions SET category = ?2, subcategory = ?3, \
           category_code = ?4, subcategory_code = ?5, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(&tx_id)
    .bind(&category_label)
    .bind(subcategory_label.as_deref())
    .bind(to_code.as_deref())
    .bind(to_subcategory.as_deref())
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO bookkeeping_category_overrides \
         (id, transaction_id, from_code, to_code, from_subcategory_code, to_subcategory_code, \
          actor, reason) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'user', ?6)",
    )
    .bind(&tx_id)
    .bind(current.0.as_deref())
    .bind(to_code.as_deref())
    .bind(current.1.as_deref())
    .bind(to_subcategory.as_deref())
    .bind(reason.as_deref())
    .execute(&mut *tx)
    .await?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &tx_id,
        "transaction.category_overridden",
        "거래 분류가 수동 보정됨",
        serde_json::json!({ "toCode": to_code, "toSubcategoryCode": to_subcategory }),
    )
    .await?;
    tx.commit().await?;

    let row = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions WHERE id = ?1"
    ))
    .bind(&tx_id)
    .fetch_one(db)
    .await?;
    Ok(row)
}

pub(crate) async fn list_bookkeeping_category_overrides_inner(
    db: &Db,
    transaction_id: &str,
) -> Result<Vec<BookkeepingCategoryOverride>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingCategoryOverride>(
        "SELECT id, transaction_id, from_code, to_code, from_subcategory_code, \
           to_subcategory_code, actor, reason, created_at \
         FROM bookkeeping_category_overrides \
         WHERE transaction_id = ?1 \
         ORDER BY created_at DESC, id DESC \
         LIMIT 100",
    )
    .bind(transaction_id)
    .fetch_all(db)
    .await?)
}

// ── Line items (Phase C) ────────────────────────────────────────────────────────────────────────

const LINE_ITEM_SUM_MISMATCH_CODE: &str = "line_item_sum_mismatch";

pub(crate) async fn list_bookkeeping_line_items_inner(
    db: &Db,
    transaction_id: &str,
) -> Result<Vec<BookkeepingLineItem>, AppError> {
    Ok(sqlx::query_as::<_, BookkeepingLineItem>(
        "SELECT id, transaction_id, name, amount_minor, quantity, category_code, sort_order, \
           created_at \
         FROM bookkeeping_transaction_line_items \
         WHERE transaction_id = ?1 \
         ORDER BY sort_order ASC, created_at ASC, id ASC \
         LIMIT 500",
    )
    .bind(transaction_id)
    .fetch_all(db)
    .await?)
}

type PreparedLineItem = (String, i32, i32, Option<String>);

/// Validate + normalize line-item inputs without touching the DB. Callers (the IPC set command and
/// the MCP save path) run this BEFORE any transaction commit so an invalid item fails fast and never
/// leaves a saved row without its itemization.
#[allow(clippy::result_large_err)]
pub(crate) fn prepare_line_items(
    items: &[CreateBookkeepingLineItemInput],
) -> Result<Vec<PreparedLineItem>, AppError> {
    if items.len() > 500 {
        return Err(AppError::validation(
            "bookkeeping.line_items.too_many",
            "라인아이템은 500개 이하여야 합니다",
        ));
    }
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        let name = clean_required(&item.name, "bookkeeping.line_items.name")?;
        if item.amount_minor < 0 {
            return Err(AppError::validation(
                "bookkeeping.line_items.amount",
                "라인아이템 금액은 0 이상이어야 합니다",
            ));
        }
        let quantity = item.quantity.unwrap_or(1);
        if !(1..=100_000).contains(&quantity) {
            return Err(AppError::validation(
                "bookkeeping.line_items.quantity",
                "수량은 1~100000 범위여야 합니다",
            ));
        }
        prepared.push((
            name,
            item.amount_minor,
            quantity,
            clean_optional(item.category_code.as_deref()),
        ));
    }
    Ok(prepared)
}

/// Replace the whole line-item set for a transaction (idempotent set semantics) and recompute the
/// sum-mismatch review reason. A mismatch is surfaced as a review reason, never a hard reject.
pub(crate) async fn set_bookkeeping_line_items_inner(
    db: &Db,
    input: SetBookkeepingLineItemsInput,
) -> Result<Vec<BookkeepingLineItem>, AppError> {
    let tx_id = clean_required(
        &input.transaction_id,
        "bookkeeping.line_items.transaction_id",
    )?;
    let prepared = prepare_line_items(&input.items)?;

    let mut tx = db.begin().await?;
    let existing: Option<(i32,)> =
        sqlx::query_as("SELECT amount_minor FROM bookkeeping_transactions WHERE id = ?1")
            .bind(&tx_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((tx_amount,)) = existing else {
        return Err(AppError::not_found(
            "bookkeeping.line_items.not_found",
            "거래를 찾을 수 없습니다",
        ));
    };

    sqlx::query("DELETE FROM bookkeeping_transaction_line_items WHERE transaction_id = ?1")
        .bind(&tx_id)
        .execute(&mut *tx)
        .await?;

    let mut sum: i64 = 0;
    for (idx, (name, amount, quantity, category_code)) in prepared.iter().enumerate() {
        sqlx::query(
            "INSERT INTO bookkeeping_transaction_line_items \
             (id, transaction_id, name, amount_minor, quantity, category_code, sort_order) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(&tx_id)
        .bind(name)
        .bind(amount)
        .bind(quantity)
        .bind(category_code.as_deref())
        .bind(idx as i32)
        .execute(&mut *tx)
        .await?;
        sum += (*amount as i64) * (*quantity as i64);
    }

    let mismatch = !prepared.is_empty() && sum != tx_amount as i64;
    update_sum_mismatch_reason_tx(&mut tx, &tx_id, mismatch, sum, tx_amount as i64).await?;
    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &tx_id,
        "transaction.line_items_set",
        "거래 라인아이템이 갱신됨",
        serde_json::json!({ "count": prepared.len(), "sumMismatch": mismatch }),
    )
    .await?;
    tx.commit().await?;

    list_bookkeeping_line_items_inner(db, &tx_id).await
}

pub(crate) async fn export_bookkeeping_rows(
    db: &Db,
    input: ExportBookkeepingInput,
) -> Result<Vec<BookkeepingExportRow>, AppError> {
    let project_id = clean_optional(input.project_id.as_deref());
    let from_date = clean_optional(input.from_date.as_deref());
    let to_date = clean_optional(input.to_date.as_deref());
    let sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} \
         FROM bookkeeping_transactions \
         WHERE deleted_at IS NULL \
           AND review_status != 'ignored' \
           AND (?1 IS NULL OR project_id = ?1) \
           AND (?2 IS NULL OR spent_at >= ?2) \
           AND (?3 IS NULL OR spent_at <= ?3) \
         ORDER BY spent_at ASC, COALESCE(spent_at_time, '') ASC, id ASC \
         LIMIT 5000"
    );
    let transactions = sqlx::query_as::<_, BookkeepingTransaction>(&sql)
        .bind(project_id.as_deref())
        .bind(from_date.as_deref())
        .bind(to_date.as_deref())
        .fetch_all(db)
        .await?;
    let mut rows = Vec::with_capacity(transactions.len());
    for transaction in transactions {
        let line_items = list_bookkeeping_line_items_inner(db, &transaction.id).await?;
        rows.push(BookkeepingExportRow {
            transaction,
            line_items,
        });
    }
    Ok(rows)
}

/// Add or clear the `line_item_sum_mismatch` review reason on a transaction, preserving any other
/// reasons. Malformed prior JSON degrades to an empty reason list (never panics).
async fn update_sum_mismatch_reason_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    tx_id: &str,
    mismatch: bool,
    items_sum: i64,
    tx_amount: i64,
) -> Result<(), AppError> {
    let current: (String,) =
        sqlx::query_as("SELECT review_reasons_json FROM bookkeeping_transactions WHERE id = ?1")
            .bind(tx_id)
            .fetch_one(&mut **tx)
            .await?;
    let mut reasons: Vec<serde_json::Value> = serde_json::from_str(&current.0).unwrap_or_default();
    reasons.retain(|r| r.get("code").and_then(|c| c.as_str()) != Some(LINE_ITEM_SUM_MISMATCH_CODE));
    if mismatch {
        reasons.push(serde_json::json!({
            "code": LINE_ITEM_SUM_MISMATCH_CODE,
            "detail": format!("items={items_sum}, total={tx_amount}")
        }));
    }
    let serialized = serde_json::to_string(&reasons).unwrap_or_else(|_| "[]".to_string());
    sqlx::query(
        "UPDATE bookkeeping_transactions SET review_reasons_json = ?2, updated_at = datetime('now') \
         WHERE id = ?1",
    )
    .bind(tx_id)
    .bind(serialized)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

// ── Duplicate detection (Phase D) ───────────────────────────────────────────────────────────────

/// Days since civil epoch (Howard Hinnant's algorithm) for YYYY-MM-DD date diffing without a date
/// crate. Returns None if the string is not a valid YYYY-MM-DD.
fn parse_ymd(value: &str) -> Option<(i64, i64, i64)> {
    if value.len() != 10 {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i64 = value[0..4].parse().ok()?;
    let m: i64 = value[5..7].parse().ok()?;
    let d: i64 = value[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn date_diff_days(a: &str, b: &str) -> Option<i64> {
    let (ay, am, ad) = parse_ymd(a)?;
    let (by, bm, bd) = parse_ymd(b)?;
    Some((days_from_civil(ay, am, ad) - days_from_civil(by, bm, bd)).abs())
}

/// Inverse of `days_from_civil` (Howard Hinnant).
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// One day before `date` (YYYY-MM-DD). Widens the Gmail `after:` window so a UTC cursor date can't
/// exclude a receipt that falls on an earlier day in the mailbox timezone (re-scan + source_ref dedup
/// absorbs the overlap).
fn date_minus_one_day(date: &str) -> Option<String> {
    let (y, m, d) = parse_ymd(date)?;
    let (py, pm, pd) = civil_from_days(days_from_civil(y, m, d) - 1);
    Some(format!("{py:04}-{pm:02}-{pd:02}"))
}

/// True if the two merchant strings share any normalized token (emoji/whitespace tolerant).
fn merchant_token_overlap(a: Option<&str>, b: Option<&str>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    let a_tokens: std::collections::BTreeSet<String> =
        normalize_label(a).split(' ').map(str::to_string).collect();
    if a_tokens.iter().all(|t| t.is_empty()) {
        return false;
    }
    normalize_label(b)
        .split(' ')
        .any(|t| !t.is_empty() && a_tokens.contains(t))
}

pub(crate) async fn find_bookkeeping_duplicate_candidates_inner(
    db: &Db,
    input: FindBookkeepingDuplicateCandidatesInput,
) -> Result<Vec<BookkeepingDuplicateCandidate>, AppError> {
    validate_date(&input.spent_at)?;
    if input.amount_minor <= 0 {
        return Err(AppError::validation(
            "bookkeeping.duplicate.amount",
            "금액은 0보다 커야 합니다",
        ));
    }
    let order_no = clean_optional(input.order_no.as_deref());
    let payment_no = clean_optional(input.payment_no.as_deref());
    let source_ref = clean_optional(input.source_ref.as_deref());

    // Bounded candidate set: exact amount OR a strong key match. Already-duplicate rows are excluded
    // (we never suggest a row that is itself a duplicate of something else).
    let sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions \
         WHERE (?1 IS NULL OR project_id = ?1) \
           AND (?2 IS NULL OR id != ?2) \
           AND duplicate_of_transaction_id IS NULL \
           AND ( \
             amount_minor = ?3 \
             OR (?4 IS NOT NULL AND order_no = ?4) \
             OR (?5 IS NOT NULL AND payment_no = ?5) \
             OR (?6 IS NOT NULL AND ?7 IS NOT NULL AND source = ?6 AND source_ref = ?7) \
           ) \
         LIMIT 200"
    );
    let rows = sqlx::query_as::<_, BookkeepingTransaction>(&sql)
        .bind(input.project_id.as_deref())
        .bind(input.exclude_transaction_id.as_deref())
        .bind(input.amount_minor)
        .bind(order_no.as_deref())
        .bind(payment_no.as_deref())
        .bind(input.source)
        .bind(source_ref.as_deref())
        .fetch_all(db)
        .await?;

    let mut candidates: Vec<BookkeepingDuplicateCandidate> = rows
        .into_iter()
        .filter_map(|cand| {
            let mut score = 0.0_f64;
            let mut reasons: Vec<String> = Vec::new();

            if let (Some(src), Some(sref)) = (input.source, source_ref.as_deref()) {
                if cand.source == src && cand.source_ref.as_deref() == Some(sref) {
                    score = score.max(1.0);
                    reasons.push("source_ref 일치".to_string());
                }
            }
            if let Some(order) = order_no.as_deref() {
                if cand.order_no.as_deref() == Some(order) {
                    score = score.max(0.95);
                    reasons.push("주문번호 일치".to_string());
                }
            }
            if let Some(payment) = payment_no.as_deref() {
                if cand.payment_no.as_deref() == Some(payment) {
                    score = score.max(0.95);
                    reasons.push("결제번호 일치".to_string());
                }
            }
            if cand.amount_minor == input.amount_minor {
                let merchant_match =
                    merchant_token_overlap(input.merchant.as_deref(), Some(cand.merchant.as_str()));
                match date_diff_days(&cand.spent_at, &input.spent_at) {
                    Some(0) => {
                        score = score.max(if merchant_match { 0.95 } else { 0.8 });
                        reasons.push(if merchant_match {
                            "금액·날짜·상호 일치".to_string()
                        } else {
                            "금액·날짜 일치".to_string()
                        });
                    }
                    Some(diff) if diff <= 3 => {
                        score = score.max(if merchant_match { 0.7 } else { 0.6 });
                        reasons.push(format!("금액 일치 + 날짜 {diff}일 차이"));
                    }
                    _ => {}
                }
            }

            if score > 0.0 {
                Some(BookkeepingDuplicateCandidate {
                    transaction: cand,
                    score,
                    reasons,
                })
            } else {
                None
            }
        })
        .collect();

    candidates.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.transaction.spent_at.cmp(&a.transaction.spent_at))
    });
    candidates.truncate(10);
    Ok(candidates)
}

pub(crate) async fn mark_bookkeeping_duplicate_inner(
    db: &Db,
    id: &str,
    duplicate_of_transaction_id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    let id = clean_required(id, "bookkeeping.duplicate.id")?;
    let target = clean_required(duplicate_of_transaction_id, "bookkeeping.duplicate.target")?;
    if id == target {
        return Err(AppError::validation(
            "bookkeeping.duplicate.self",
            "거래를 자기 자신의 중복으로 표시할 수 없습니다",
        ));
    }

    let mut tx = db.begin().await?;
    let target_row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, duplicate_of_transaction_id FROM bookkeeping_transactions WHERE id = ?1",
    )
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((_, target_duplicate_of)) = target_row else {
        return Err(AppError::not_found(
            "bookkeeping.duplicate.target_not_found",
            "원본 거래를 찾을 수 없습니다",
        ));
    };
    // No duplicate chains: the target must itself be a canonical row, so following
    // duplicate_of_transaction_id always reaches the original in one hop.
    if target_duplicate_of.is_some() {
        return Err(AppError::validation(
            "bookkeeping.duplicate.target_is_duplicate",
            "원본 거래가 이미 다른 거래의 중복으로 표시돼 있습니다",
        ));
    }

    let updated = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "UPDATE bookkeeping_transactions SET \
           review_status = 'ignored', \
           duplicate_of_transaction_id = ?2, \
           reviewed_at = datetime('now'), \
           updated_at = datetime('now') \
         WHERE id = ?1 \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    ))
    .bind(&id)
    .bind(&target)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        AppError::not_found("bookkeeping.duplicate.not_found", "거래를 찾을 수 없습니다")
    })?;

    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &id,
        "transaction.marked_duplicate",
        "거래가 중복으로 표시됨",
        serde_json::json!({ "duplicateOf": target }),
    )
    .await?;
    tx.commit().await?;
    Ok(updated)
}

async fn insert_audit_log_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    entity_type: &str,
    entity_id: &str,
    action: &str,
    summary: &str,
    metadata: serde_json::Value,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO bookkeeping_audit_log \
         (id, entity_type, entity_id, action, summary, metadata_json) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
    )
    .bind(entity_type)
    .bind(entity_id)
    .bind(action)
    .bind(summary)
    .bind(metadata.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn fetch_bookkeeping_transaction(
    db: &Db,
    id: &str,
) -> Result<BookkeepingTransaction, AppError> {
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} FROM bookkeeping_transactions WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| {
        AppError::not_found(
            "bookkeeping.transaction_not_found",
            "거래를 찾을 수 없습니다",
        )
    })?;
    Ok(row)
}

#[allow(clippy::result_large_err)]
fn clean_required(value: &str, code: &str) -> Result<String, AppError> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        return Err(AppError::validation(code, "필수 값을 입력하세요"));
    }
    Ok(cleaned.to_string())
}

fn clean_optional(value: Option<&str>) -> Option<String> {
    value.and_then(|v| {
        let cleaned = v.trim();
        (!cleaned.is_empty()).then(|| cleaned.to_string())
    })
}

fn clean_string_vec(values: Vec<String>) -> Vec<String> {
    let mut cleaned = values
        .into_iter()
        .filter_map(|value| {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_string())
        })
        .collect::<Vec<_>>();
    cleaned.sort();
    cleaned.dedup();
    cleaned
}

async fn ensure_project_exists(db: &Db, project_id: &str) -> Result<(), AppError> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?;
    if exists.is_some() {
        Ok(())
    } else {
        Err(AppError::not_found(
            "bookkeeping.gmail.project_not_found",
            "project not found",
        ))
    }
}

async fn ensure_budget_project_exists(db: &Db, project_id: &str) -> Result<(), AppError> {
    let exists: Option<(String,)> = sqlx::query_as("SELECT id FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?;
    if exists.is_some() {
        Ok(())
    } else {
        Err(AppError::not_found(
            "bookkeeping.budget.project_not_found",
            "project not found",
        ))
    }
}

async fn fetch_bookkeeping_budget(db: &Db, id: &str) -> Result<BookkeepingBudget, AppError> {
    let row = sqlx::query_as::<_, BookkeepingBudget>(&format!(
        "SELECT {BUDGET_RETURNING_COLUMNS} FROM bookkeeping_budgets WHERE id = ?1"
    ))
    .bind(id)
    .fetch_one(db)
    .await?;
    Ok(row)
}

async fn spent_for_budget_category(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
    category_code: &str,
) -> Result<i32, AppError> {
    let (start, end) = month_bounds(month)?;
    let (amount,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount_minor), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 \
           AND review_status != 'ignored' \
           AND direction = 'expense' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3) \
           AND COALESCE(category_code, category) = ?4",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id)
    .bind(category_code)
    .fetch_one(db)
    .await?;
    Ok(amount.max(0).min(i32::MAX as i64) as i32)
}

async fn budget_for_scope(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
    category_code: &str,
) -> Result<Option<BookkeepingBudget>, AppError> {
    let row = sqlx::query_as::<_, BookkeepingBudget>(&format!(
        "SELECT {BUDGET_RETURNING_COLUMNS} FROM bookkeeping_budgets \
         WHERE month = ?1 AND COALESCE(project_id, '') = COALESCE(?2, '') AND category_code = ?3"
    ))
    .bind(month)
    .bind(project_id)
    .bind(category_code)
    .fetch_optional(db)
    .await?;
    Ok(row)
}

async fn rollover_in_for_budget(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
    category_code: &str,
) -> Result<i32, AppError> {
    let mut cursor = previous_month(month)?;
    let mut chain = Vec::new();
    for _ in 0..24 {
        let Some(budget) = budget_for_scope(db, &cursor, project_id, category_code).await? else {
            break;
        };
        let continue_chain = budget.rollover;
        chain.push(budget);
        if !continue_chain {
            break;
        }
        cursor = previous_month(&cursor)?;
    }

    let mut carry = 0_i32;
    for budget in chain.into_iter().rev() {
        let spent = spent_for_budget_category(
            db,
            &budget.month,
            budget.project_id.as_deref(),
            &budget.category_code,
        )
        .await?;
        carry = budget
            .limit_minor
            .saturating_add(carry)
            .saturating_sub(spent)
            .max(0);
    }
    Ok(carry)
}

async fn category_label(db: &Db, category_code: &str) -> Result<String, AppError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT label FROM bookkeeping_category_taxonomy WHERE code = ?1")
            .bind(category_code)
            .fetch_optional(db)
            .await?;
    Ok(row
        .map(|(label,)| label)
        .unwrap_or_else(|| category_code.to_string()))
}

fn recurring_occurrence_select_sql(where_clause: &str) -> String {
    format!(
        "SELECT o.id, o.recurring_expense_id, e.name AS recurring_name, e.merchant, \
          o.month, o.due_date, o.amount_minor, o.currency, e.category, e.payment_method_kind, \
          e.payment_method_label, e.payment_method_last4, e.expense_kind, o.status, \
          o.transaction_id, o.note, o.created_at, o.updated_at \
         FROM bookkeeping_recurring_occurrences o \
         JOIN bookkeeping_recurring_expenses e ON e.id = o.recurring_expense_id \
         {where_clause}"
    )
}

#[allow(clippy::result_large_err)]
fn clean_currency(value: &str) -> Result<String, AppError> {
    let raw = value.trim();
    let cleaned = if raw.is_empty() {
        DEFAULT_CURRENCY.to_string()
    } else {
        raw.to_ascii_uppercase()
    };
    if cleaned.len() != 3 || !cleaned.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(AppError::validation(
            "bookkeeping.currency",
            "통화 코드는 3자리 영문이어야 합니다",
        ));
    }
    Ok(cleaned)
}

#[allow(clippy::result_large_err)]
fn parse_bookkeeping_direction(value: &str) -> Result<BookkeepingDirection, AppError> {
    match value.trim() {
        "expense" => Ok(BookkeepingDirection::Expense),
        "income" => Ok(BookkeepingDirection::Income),
        _ => Err(AppError::validation(
            "bookkeeping.direction",
            "수입/지출은 expense 또는 income이어야 합니다",
        )),
    }
}

#[allow(clippy::result_large_err)]
fn clean_payment_last4(value: Option<&str>) -> Result<Option<String>, AppError> {
    let Some(value) = clean_optional(value) else {
        return Ok(None);
    };
    if value.len() > 8 || !value.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(AppError::validation(
            "bookkeeping.payment_last4",
            "결제수단 끝자리는 8자 이하 영문/숫자만 입력하세요",
        ));
    }
    Ok(Some(value))
}

/// Cleaned + validated judgment fields shared by the manual-create and ingest-upsert paths.
struct JudgmentFields {
    direction: BookkeepingDirection,
    account: Option<String>,
    subcategory: Option<String>,
    category_code: Option<String>,
    subcategory_code: Option<String>,
    raw_category: Option<String>,
    spent_at_time: Option<String>,
    confidence: Option<f64>,
    field_confidence_json: String,
    review_reasons_json: String,
    order_no: Option<String>,
    payment_no: Option<String>,
}

#[allow(clippy::result_large_err)]
fn prepare_judgment_fields(
    input: &CreateBookkeepingTransactionInput,
) -> Result<JudgmentFields, AppError> {
    let spent_at_time = clean_optional(input.spent_at_time.as_deref());
    if let Some(time) = spent_at_time.as_deref() {
        validate_time(time)?;
    }
    if let Some(confidence) = input.confidence {
        if confidence.is_nan() || !(0.0..=1.0).contains(&confidence) {
            return Err(AppError::validation(
                "bookkeeping.confidence",
                "신뢰도는 0~1 범위여야 합니다",
            ));
        }
    }
    let field_confidence_json = clean_json(
        input.field_confidence_json.as_deref(),
        JsonShape::Object,
        "bookkeeping.field_confidence",
    )?;
    let review_reasons_json = clean_json(
        input.review_reasons_json.as_deref(),
        JsonShape::Array,
        "bookkeeping.review_reasons",
    )?;
    Ok(JudgmentFields {
        direction: input.direction,
        account: clean_optional(input.account.as_deref()),
        subcategory: clean_optional(input.subcategory.as_deref()),
        category_code: clean_optional(input.category_code.as_deref()),
        subcategory_code: clean_optional(input.subcategory_code.as_deref()),
        raw_category: clean_optional(input.raw_category.as_deref()),
        spent_at_time,
        confidence: input.confidence,
        field_confidence_json,
        review_reasons_json,
        order_no: clean_optional(input.order_no.as_deref()),
        payment_no: clean_optional(input.payment_no.as_deref()),
    })
}

/// Fill `category_code`/`subcategory_code`/`confidence` from the taxonomy resolver when the caller
/// did not provide a code. Caller-provided codes and confidence are never overwritten.
async fn apply_category_resolution(
    db: &Db,
    jf: &mut JudgmentFields,
    category_hint: &str,
    merchant: &str,
) -> Result<(), AppError> {
    if jf.category_code.is_some() {
        return Ok(());
    }
    let resolved = resolve_category_inner(
        db,
        None,
        jf.subcategory_code.as_deref(),
        category_hint,
        jf.raw_category.as_deref(),
        merchant,
    )
    .await?;
    jf.category_code = resolved.category_code;
    if jf.subcategory_code.is_none() {
        jf.subcategory_code = resolved.subcategory_code;
    }
    if jf.confidence.is_none() {
        jf.confidence = resolved.confidence;
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum JsonShape {
    Object,
    Array,
}

const MAX_JSON_PAYLOAD_LEN: usize = 4000;

#[allow(clippy::result_large_err)]
fn clean_json(value: Option<&str>, shape: JsonShape, code: &str) -> Result<String, AppError> {
    let default = match shape {
        JsonShape::Object => "{}",
        JsonShape::Array => "[]",
    };
    let Some(raw) = clean_optional(value) else {
        return Ok(default.to_string());
    };
    if raw.len() > MAX_JSON_PAYLOAD_LEN {
        return Err(AppError::validation(code, "JSON 페이로드가 너무 큽니다"));
    }
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| AppError::validation(code, "유효한 JSON이 아닙니다"))?;
    let shape_ok = match shape {
        JsonShape::Object => parsed.is_object(),
        JsonShape::Array => parsed.is_array(),
    };
    if !shape_ok {
        return Err(AppError::validation(code, "JSON 구조가 올바르지 않습니다"));
    }
    Ok(raw)
}

#[allow(clippy::result_large_err)]
fn validate_time(value: &str) -> Result<(), AppError> {
    let err = || AppError::validation("bookkeeping.time", "시간은 HH:MM:SS 형식이어야 합니다");
    let bytes = value.as_bytes();
    let structural_ok = value.len() == 8
        && bytes[2] == b':'
        && bytes[5] == b':'
        && value
            .bytes()
            .enumerate()
            .all(|(idx, b)| idx == 2 || idx == 5 || b.is_ascii_digit());
    if !structural_ok {
        return Err(err());
    }
    let hh: u32 = value[0..2].parse().map_err(|_| err())?;
    let mm: u32 = value[3..5].parse().map_err(|_| err())?;
    let ss: u32 = value[6..8].parse().map_err(|_| err())?;
    if hh > 23 || mm > 59 || ss > 59 {
        return Err(err());
    }
    Ok(())
}

#[allow(clippy::result_large_err)]
fn validate_date(value: &str) -> Result<(), AppError> {
    if value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(idx, b)| idx == 4 || idx == 7 || b.is_ascii_digit())
    {
        return Ok(());
    }
    Err(AppError::validation(
        "bookkeeping.date",
        "날짜는 YYYY-MM-DD 형식이어야 합니다",
    ))
}

#[allow(clippy::result_large_err)]
fn validate_month(value: &str) -> Result<(i32, u32), AppError> {
    if value.len() != 7 || value.as_bytes()[4] != b'-' {
        return Err(AppError::validation(
            "bookkeeping.month",
            "월은 YYYY-MM 형식이어야 합니다",
        ));
    }
    let year: i32 = value[..4]
        .parse()
        .map_err(|_| AppError::validation("bookkeeping.month", "월은 YYYY-MM 형식이어야 합니다"))?;
    let mon: u32 = value[5..7]
        .parse()
        .map_err(|_| AppError::validation("bookkeeping.month", "월은 YYYY-MM 형식이어야 합니다"))?;
    if !(1..=12).contains(&mon) {
        return Err(AppError::validation(
            "bookkeeping.month",
            "월은 01~12 범위여야 합니다",
        ));
    }
    Ok((year, mon))
}

#[allow(clippy::result_large_err)]
fn month_bounds(month: &str) -> Result<(String, String), AppError> {
    let (year, mon) = validate_month(month)?;
    let (next_year, next_mon) = if mon == 12 {
        (year + 1, 1)
    } else {
        (year, mon + 1)
    };
    Ok((
        format!("{year:04}-{mon:02}-01"),
        format!("{next_year:04}-{next_mon:02}-01"),
    ))
}

#[allow(clippy::result_large_err)]
fn previous_month(month: &str) -> Result<String, AppError> {
    let (year, mon) = validate_month(month)?;
    let (prev_year, prev_mon) = if mon == 1 {
        (year - 1, 12)
    } else {
        (year, mon - 1)
    };
    Ok(format!("{prev_year:04}-{prev_mon:02}"))
}

#[allow(clippy::result_large_err)]
fn due_date_for_month(month: &str, schedule_day: i32) -> Result<String, AppError> {
    let (year, mon) = validate_month(month)?;
    let last_day = last_day_of_month(year, mon);
    let day = schedule_day.clamp(1, last_day as i32) as u32;
    Ok(format!("{year:04}-{mon:02}-{day:02}"))
}

fn last_day_of_month(year: i32, mon: u32) -> u32 {
    match mon {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 28,
    }
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn sanitize_sync_error_message(raw: &str) -> String {
    let scrubbed = raw
        .split_whitespace()
        .map(|token| {
            if looks_like_email(token) {
                "[redacted-email]".to_string()
            } else {
                redact_long_digit_runs(token)
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = scrubbed.trim().to_string();
    if out.is_empty() {
        out = "동기화 실패".to_string();
    }
    if out.chars().count() > MAX_SYNC_ERROR_LEN {
        out = out.chars().take(MAX_SYNC_ERROR_LEN).collect::<String>();
        out.push('…');
    }
    out
}

fn looks_like_email(token: &str) -> bool {
    token.contains('@') && token.contains('.')
}

fn redact_long_digit_runs(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut digits = String::new();
    for ch in token.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            continue;
        }
        flush_digits(&mut out, &mut digits);
        out.push(ch);
    }
    flush_digits(&mut out, &mut digits);
    out
}

fn flush_digits(out: &mut String, digits: &mut String) {
    if digits.is_empty() {
        return;
    }
    if digits.len() >= 6 {
        out.push_str("[redacted-number]");
    } else {
        out.push_str(digits);
    }
    digits.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::gmail::{
        GmailError, GmailLabelInfo, GmailMessageSearch, GmailReadProvider, GmailReceiptCandidate,
    };
    use crate::models::{
        BookkeepingExpenseKind, BookkeepingPaymentMethodKind, BookkeepingRecurringOccurrenceStatus,
        BookkeepingReviewStatus, BookkeepingSource, CreateBookkeepingLineItemInput,
        CreateBookkeepingRecurringExpenseInput, CreateBookkeepingTransactionInput,
        CreateProjectInput, ProjectKind, RecordBookkeepingSyncFailureInput,
        SetBookkeepingBudgetInput, SyncBookkeepingGmailReceiptsInput,
        UpdateBookkeepingTransactionInput,
    };
    use std::sync::Mutex;

    async fn pool() -> Db {
        let p = sqlx::SqlitePool::connect("sqlite::memory:")
            .await
            .expect("sqlite in-memory");
        sqlx::migrate!("./migrations")
            .run(&p)
            .await
            .expect("migrations");
        p
    }

    fn manual_input(
        merchant: &str,
        amount_minor: i32,
        spent_at: &str,
        category: &str,
    ) -> CreateBookkeepingTransactionInput {
        CreateBookkeepingTransactionInput {
            project_id: None,
            source: BookkeepingSource::Manual,
            source_ref: None,
            merchant: merchant.to_string(),
            description: None,
            amount_minor,
            currency: "KRW".to_string(),
            spent_at: spent_at.to_string(),
            category: category.to_string(),
            note: None,
            payment_method_kind: BookkeepingPaymentMethodKind::Unknown,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Variable,
            recurring_expense_id: None,
            recurring_occurrence_id: None,
            direction: BookkeepingDirection::Expense,
            account: None,
            subcategory: None,
            category_code: None,
            subcategory_code: None,
            raw_category: None,
            spent_at_time: None,
            confidence: None,
            field_confidence_json: None,
            review_reasons_json: None,
            order_no: None,
            payment_no: None,
        }
    }

    fn update_input(id: String) -> UpdateBookkeepingTransactionInput {
        UpdateBookkeepingTransactionInput {
            id,
            merchant: None,
            description: None,
            amount_minor: None,
            currency: None,
            spent_at: None,
            spent_at_time: None,
            direction: None,
            note: None,
            account: None,
            category_code: None,
            subcategory_code: None,
            payment_method_kind: None,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: None,
            order_no: None,
            payment_no: None,
        }
    }

    fn recurring_input(
        project_id: Option<String>,
        name: &str,
        amount_minor: i32,
    ) -> CreateBookkeepingRecurringExpenseInput {
        CreateBookkeepingRecurringExpenseInput {
            project_id,
            name: name.to_string(),
            merchant: Some(name.to_string()),
            amount_minor,
            currency: "KRW".to_string(),
            category: "housing".to_string(),
            payment_method_kind: BookkeepingPaymentMethodKind::BankTransfer,
            payment_method_label: None,
            payment_method_last4: None,
            expense_kind: BookkeepingExpenseKind::Fixed,
            schedule_day: 25,
            start_month: "2026-06".to_string(),
            end_month: None,
            note: None,
        }
    }

    #[derive(Default)]
    struct FakeGmailReadProvider {
        labels: Vec<GmailLabelInfo>,
        ids: Vec<String>,
        candidates: std::collections::HashMap<String, GmailReceiptCandidate>,
        searches: Mutex<Vec<GmailMessageSearch>>,
    }

    impl GmailReadProvider for FakeGmailReadProvider {
        async fn list_labels(&self, _: &str) -> Result<Vec<GmailLabelInfo>, GmailError> {
            Ok(self.labels.clone())
        }

        async fn list_message_ids(
            &self,
            _: &str,
            search: &GmailMessageSearch,
        ) -> Result<Vec<String>, GmailError> {
            self.searches.lock().expect("searches").push(search.clone());
            Ok(self.ids.clone())
        }

        async fn get_receipt_candidate(
            &self,
            _: &str,
            message_id: &str,
        ) -> Result<GmailReceiptCandidate, GmailError> {
            self.candidates
                .get(message_id)
                .cloned()
                .ok_or_else(|| GmailError::Terminal("not found".into()))
        }
    }

    #[tokio::test]
    async fn manual_create_writes_transaction_and_sanitized_audit() {
        let db = pool().await;

        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Sensitive Store", 12_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        assert_eq!(tx.review_status, BookkeepingReviewStatus::NeedsReview);
        assert_eq!(tx.merchant, "Sensitive Store");

        let audit = list_bookkeeping_audit_inner(&db, Some(tx.id.clone()))
            .await
            .expect("audit list");
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].action, "transaction.created");
        assert!(!audit[0].summary.contains("Sensitive Store"));
    }

    #[tokio::test]
    async fn review_update_appends_audit_without_overwriting_history() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Cafe", 7_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        let reviewed =
            update_bookkeeping_review_status_inner(&db, &tx.id, BookkeepingReviewStatus::Approved)
                .await
                .expect("review update");

        assert_eq!(reviewed.review_status, BookkeepingReviewStatus::Approved);
        assert!(reviewed.reviewed_at.is_some());

        let audit = list_bookkeeping_audit_inner(&db, Some(tx.id))
            .await
            .expect("audit list");
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].action, "transaction.review_status_changed");
        assert_eq!(audit[1].action, "transaction.created");
    }

    #[tokio::test]
    async fn bulk_update_review_status_marks_all_selected() {
        let db = pool().await;
        let mut ids = Vec::new();
        for merchant in ["Cafe", "Books", "Lunch"] {
            let tx = create_bookkeeping_transaction_inner(
                &db,
                manual_input(merchant, 5_000, "2026-06-16", "food"),
            )
            .await
            .expect("create transaction");
            assert_eq!(tx.review_status, BookkeepingReviewStatus::NeedsReview);
            ids.push(tx.id);
        }

        let results = bulk_update_bookkeeping_review_status_inner(
            &db,
            &ids,
            BookkeepingReviewStatus::Approved,
        )
        .await;

        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.ok));
        for id in &ids {
            let row = fetch_bookkeeping_transaction(&db, id)
                .await
                .expect("fetch transaction");
            assert_eq!(row.review_status, BookkeepingReviewStatus::Approved);
        }
    }

    #[tokio::test]
    async fn bulk_update_review_status_is_best_effort_on_bad_id() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Cafe", 5_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        let ids = vec![tx.id.clone(), "nonexistent-id".to_string()];
        let results = bulk_update_bookkeeping_review_status_inner(
            &db,
            &ids,
            BookkeepingReviewStatus::Approved,
        )
        .await;

        assert_eq!(results.len(), 2);
        let good = results
            .iter()
            .find(|r| r.id == tx.id)
            .expect("valid result");
        assert!(good.ok);
        assert!(good.message.is_none());
        let bad = results
            .iter()
            .find(|r| r.id == "nonexistent-id")
            .expect("bad result");
        assert!(!bad.ok);
        assert!(bad.message.is_some());

        // 유효한 항목은 그대로 적용된다(나쁜 id가 배치를 중단시키지 않음).
        let row = fetch_bookkeeping_transaction(&db, &tx.id)
            .await
            .expect("fetch transaction");
        assert_eq!(row.review_status, BookkeepingReviewStatus::Approved);
    }

    #[tokio::test]
    async fn bulk_set_category_routes_each_item_through_override_audit() {
        let db = pool().await;
        let mut ids = Vec::new();
        for merchant in ["Taxi", "Metro"] {
            let tx = create_bookkeeping_transaction_inner(
                &db,
                manual_input(merchant, 5_000, "2026-06-16", "food"),
            )
            .await
            .expect("create transaction");
            ids.push(tx.id);
        }

        let results = bulk_set_bookkeeping_category_inner(
            &db,
            &ids,
            Some("transport"),
            Some("transport_taxi"),
            Some("bulk_triage"),
        )
        .await;

        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.ok));
        for id in &ids {
            let row = fetch_bookkeeping_transaction(&db, id)
                .await
                .expect("fetch transaction");
            assert_eq!(row.category_code.as_deref(), Some("transport"));
            assert_eq!(row.subcategory_code.as_deref(), Some("transport_taxi"));

            let history = list_bookkeeping_category_overrides_inner(&db, id)
                .await
                .expect("override history");
            assert_eq!(history.len(), 1);

            let audit = list_bookkeeping_audit_inner(&db, Some(id.clone()))
                .await
                .expect("audit");
            assert!(audit
                .iter()
                .any(|entry| entry.action == "transaction.category_overridden"));
        }
    }

    #[tokio::test]
    async fn bulk_set_category_is_best_effort_on_bad_id() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Taxi", 5_000, "2026-06-16", "food"),
        )
        .await
        .expect("create transaction");

        let ids = vec![tx.id.clone(), "missing-category-target".to_string()];
        let results =
            bulk_set_bookkeeping_category_inner(&db, &ids, Some("transport"), None, None).await;

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.id == tx.id && r.ok));
        let bad = results
            .iter()
            .find(|r| r.id == "missing-category-target")
            .expect("missing id result");
        assert!(!bad.ok);
        assert!(bad.message.is_some());
        let row = fetch_bookkeeping_transaction(&db, &tx.id)
            .await
            .expect("fetch transaction");
        assert_eq!(row.category_code.as_deref(), Some("transport"));
    }

    #[tokio::test]
    async fn bulk_delete_transactions_soft_deletes_each_item_best_effort() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Delete Me", 9_500, "2026-06-17", "food"),
        )
        .await
        .expect("create transaction");
        let ids = vec![tx.id.clone(), "missing-delete-target".to_string()];

        let results = bulk_delete_bookkeeping_transactions_inner(&db, &ids).await;

        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|r| r.id == tx.id && r.ok));
        let bad = results
            .iter()
            .find(|r| r.id == "missing-delete-target")
            .expect("missing id result");
        assert!(!bad.ok);
        assert!(bad.message.is_some());

        let deleted = fetch_bookkeeping_transaction(&db, &tx.id)
            .await
            .expect("fetch transaction");
        assert!(deleted.deleted_at.is_some());
        let main_rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("main list");
        assert!(main_rows.iter().all(|row| row.id != tx.id));
    }

    #[tokio::test]
    async fn soft_delete_moves_transaction_to_trash_and_restore_returns_it_to_lists() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Delete Me", 9_500, "2026-06-17", "food"),
        )
        .await
        .expect("create transaction");

        let deleted = delete_bookkeeping_transaction_inner(&db, &tx.id)
            .await
            .expect("soft delete");
        assert!(deleted.deleted_at.is_some());

        let main_rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("main list");
        assert!(main_rows.iter().all(|row| row.id != tx.id));

        let trash = list_bookkeeping_trash_inner(&db, None)
            .await
            .expect("trash list");
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, tx.id);

        let restored = restore_bookkeeping_transaction_inner(&db, &tx.id)
            .await
            .expect("restore");
        assert!(restored.deleted_at.is_none());

        let main_rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("main list after restore");
        assert!(main_rows.iter().any(|row| row.id == tx.id));
    }

    #[tokio::test]
    async fn update_transaction_persists_fields_validates_input_and_recomputes_sum_mismatch() {
        let db = pool().await;
        let tx = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Old Merchant", 10_000, "2026-06-17", "misc"),
        )
        .await
        .expect("create transaction");
        set_bookkeeping_line_items_inner(
            &db,
            SetBookkeepingLineItemsInput {
                transaction_id: tx.id.clone(),
                items: vec![CreateBookkeepingLineItemInput {
                    name: "Corrected item".to_string(),
                    amount_minor: 9_000,
                    quantity: Some(1),
                    category_code: None,
                }],
            },
        )
        .await
        .expect("line item mismatch");

        let updated = update_bookkeeping_transaction_inner(
            &db,
            UpdateBookkeepingTransactionInput {
                id: tx.id.clone(),
                merchant: Some("Corrected Merchant".to_string()),
                description: Some("Corrected description".to_string()),
                amount_minor: Some(9_000),
                currency: Some("krw".to_string()),
                spent_at: Some("2026-06-18".to_string()),
                spent_at_time: Some(Some("12:34:56".to_string())),
                direction: Some("income".to_string()),
                note: Some("Reviewed note".to_string()),
                account: Some("하나은행".to_string()),
                category_code: Some("food".to_string()),
                subcategory_code: Some("food_cafe".to_string()),
                payment_method_kind: Some(BookkeepingPaymentMethodKind::Card),
                payment_method_label: Some("개인카드".to_string()),
                payment_method_last4: Some("1234".to_string()),
                expense_kind: Some(BookkeepingExpenseKind::Fixed),
                order_no: Some("ORDER-1".to_string()),
                payment_no: Some("PAY-1".to_string()),
            },
        )
        .await
        .expect("update transaction");

        assert_eq!(updated.merchant, "Corrected Merchant");
        assert_eq!(
            updated.description.as_deref(),
            Some("Corrected description")
        );
        assert_eq!(updated.amount_minor, 9_000);
        assert_eq!(updated.currency, "KRW");
        assert_eq!(updated.spent_at, "2026-06-18");
        assert_eq!(updated.spent_at_time.as_deref(), Some("12:34:56"));
        assert_eq!(updated.direction, BookkeepingDirection::Income);
        assert_eq!(updated.note.as_deref(), Some("Reviewed note"));
        assert_eq!(updated.account.as_deref(), Some("하나은행"));
        assert_eq!(updated.category_code.as_deref(), Some("food"));
        assert_eq!(updated.subcategory_code.as_deref(), Some("food_cafe"));
        assert_eq!(updated.category, "식비");
        assert_eq!(updated.subcategory.as_deref(), Some("카페"));
        assert_eq!(
            updated.payment_method_kind,
            BookkeepingPaymentMethodKind::Card
        );
        assert_eq!(updated.payment_method_label.as_deref(), Some("개인카드"));
        assert_eq!(updated.payment_method_last4.as_deref(), Some("1234"));
        assert_eq!(updated.expense_kind, BookkeepingExpenseKind::Fixed);
        assert_eq!(updated.order_no.as_deref(), Some("ORDER-1"));
        assert_eq!(updated.payment_no.as_deref(), Some("PAY-1"));
        assert!(!updated
            .review_reasons_json
            .contains(LINE_ITEM_SUM_MISMATCH_CODE));

        let overrides = list_bookkeeping_category_overrides_inner(&db, &tx.id)
            .await
            .expect("category override history");
        assert_eq!(overrides.len(), 1);

        let bad_amount = update_bookkeeping_transaction_inner(
            &db,
            UpdateBookkeepingTransactionInput {
                id: tx.id.clone(),
                amount_minor: Some(0),
                ..update_input(tx.id.clone())
            },
        )
        .await
        .expect_err("amount validation");
        assert_eq!(bad_amount.code, "bookkeeping.amount");

        let bad_direction = update_bookkeeping_transaction_inner(
            &db,
            UpdateBookkeepingTransactionInput {
                id: tx.id.clone(),
                direction: Some("refund".to_string()),
                ..update_input(tx.id.clone())
            },
        )
        .await
        .expect_err("direction validation");
        assert_eq!(bad_direction.code, "bookkeeping.direction");
    }

    #[tokio::test]
    async fn reingest_upsert_preserves_deleted_at_and_review_status() {
        let db = pool().await;
        let mut input = manual_input("Gmail Store", 15_000, "2026-06-17", "food");
        input.source = BookkeepingSource::Gmail;
        input.source_ref = Some("gmail-message-1".to_string());

        let tx = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input.clone(),
            "transaction.ingested",
            "거래가 저장됨",
        )
        .await
        .expect("initial ingest");
        update_bookkeeping_review_status_inner(&db, &tx.id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve");
        delete_bookkeeping_transaction_inner(&db, &tx.id)
            .await
            .expect("delete");

        input.merchant = "Gmail Store Reingested".to_string();
        let reingested = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input,
            "transaction.ingested",
            "거래가 저장됨",
        )
        .await
        .expect("reingest");

        assert_eq!(reingested.id, tx.id);
        assert_eq!(reingested.review_status, BookkeepingReviewStatus::Approved);
        assert!(reingested.deleted_at.is_some());
    }

    #[tokio::test]
    async fn monthly_summary_groups_by_category_and_excludes_ignored_total() {
        let db = pool().await;
        let food = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 12_000, "2026-06-01", "food"),
        )
        .await
        .expect("food");
        update_bookkeeping_review_status_inner(&db, &food.id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve food");

        create_bookkeeping_transaction_inner(
            &db,
            manual_input("Subway", 3_000, "2026-06-02", "transport"),
        )
        .await
        .expect("transport");

        let ignored = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Noise", 1_000, "2026-06-03", "misc"),
        )
        .await
        .expect("ignored");
        update_bookkeeping_review_status_inner(&db, &ignored.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore");

        create_bookkeeping_transaction_inner(
            &db,
            manual_input("July", 5_000, "2026-07-01", "food"),
        )
        .await
        .expect("july");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");

        assert_eq!(summary.total_amount_minor, 15_000);
        assert_eq!(summary.needs_review_count, 1);
        assert_eq!(summary.approved_count, 1);
        assert_eq!(summary.ignored_count, 1);
        assert_eq!(summary.categories.len(), 2);
        assert_eq!(summary.categories[0].category, "food");
        assert_eq!(summary.categories[0].amount_minor, 12_000);
        assert_eq!(summary.categories[1].category, "transport");
        assert_eq!(summary.categories[1].amount_minor, 3_000);
    }

    #[tokio::test]
    async fn project_scope_filters_bookkeeping_lists_and_summary() {
        let db = pool().await;
        let personal = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("personal project");
        let work = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Work".to_string(),
                kind: ProjectKind::Work,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("work project");

        let mut personal_tx = manual_input("Personal Market", 12_000, "2026-06-01", "food");
        personal_tx.project_id = Some(personal.id.clone());
        create_bookkeeping_transaction_inner(&db, personal_tx)
            .await
            .expect("personal transaction");

        let mut work_tx = manual_input("Work Cafe", 7_000, "2026-06-02", "work");
        work_tx.project_id = Some(work.id.clone());
        create_bookkeeping_transaction_inner(&db, work_tx)
            .await
            .expect("work transaction");

        create_bookkeeping_recurring_expense_inner(
            &db,
            recurring_input(Some(personal.id.clone()), "월세", 900_000),
        )
        .await
        .expect("personal recurring");
        create_bookkeeping_recurring_expense_inner(
            &db,
            recurring_input(Some(work.id.clone()), "법인 구독", 50_000),
        )
        .await
        .expect("work recurring");

        let personal_rows = list_bookkeeping_transactions_inner(&db, None, Some(&personal.id))
            .await
            .expect("personal rows");
        assert_eq!(personal_rows.len(), 1);
        assert_eq!(
            personal_rows[0].project_id.as_deref(),
            Some(personal.id.as_str())
        );

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", Some(&personal.id))
            .await
            .expect("personal summary");
        assert_eq!(summary.total_amount_minor, 12_000);
        assert_eq!(summary.categories.len(), 1);
        assert_eq!(summary.categories[0].category, "food");

        let recurring = list_bookkeeping_recurring_expenses_inner(&db, Some(&personal.id))
            .await
            .expect("personal recurring list");
        assert_eq!(recurring.len(), 1);
        assert_eq!(
            recurring[0].project_id.as_deref(),
            Some(personal.id.as_str())
        );

        let occurrences =
            ensure_bookkeeping_recurring_occurrences_inner(&db, "2026-06", Some(&personal.id))
                .await
                .expect("personal occurrences");
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].recurring_name, "월세");
    }

    #[tokio::test]
    async fn budgets_upsert_by_scope_and_status_uses_monthly_expense_predicate() {
        let db = pool().await;
        let needs_review = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("needs review expense");

        let mut income = manual_input("Refund", 9_000, "2026-06-02", "food");
        income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, income)
            .await
            .expect("income excluded");

        let ignored = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Ignored", 2_000, "2026-06-03", "food"),
        )
        .await
        .expect("ignored expense");
        update_bookkeeping_review_status_inner(&db, &ignored.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore");

        let deleted = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Deleted", 3_000, "2026-06-04", "food"),
        )
        .await
        .expect("deleted expense");
        delete_bookkeeping_transaction_inner(&db, &deleted.id)
            .await
            .expect("soft delete");

        let first = set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-06".to_string(),
                category_code: "food".to_string(),
                limit_minor: 5_000,
                currency: Some("krw".to_string()),
                rollover: false,
                note: Some("initial".to_string()),
            },
        )
        .await
        .expect("insert budget");
        let second = set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-06".to_string(),
                category_code: "food".to_string(),
                limit_minor: 1_500,
                currency: None,
                rollover: false,
                note: Some("updated".to_string()),
            },
        )
        .await
        .expect("upsert budget");

        assert_eq!(first.id, second.id);
        assert_eq!(second.limit_minor, 1_500);
        assert_eq!(
            needs_review.review_status,
            BookkeepingReviewStatus::NeedsReview
        );

        let status = bookkeeping_budget_status_inner(&db, "2026-06", None)
            .await
            .expect("status");
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].spent_minor, 1_000);
        assert_eq!(status[0].remaining_minor, 500);
        assert_eq!(status[0].rollover_in_minor, 0);
    }

    #[tokio::test]
    async fn budget_status_rolls_positive_prior_remaining_and_exposes_over_budget() {
        let db = pool().await;
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("May Market", 3_000, "2026-05-10", "food"),
        )
        .await
        .expect("may expense");
        create_bookkeeping_transaction_inner(
            &db,
            manual_input("June Market", 3_500, "2026-06-10", "food"),
        )
        .await
        .expect("june expense");

        set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-05".to_string(),
                category_code: "food".to_string(),
                limit_minor: 5_000,
                currency: None,
                rollover: false,
                note: None,
            },
        )
        .await
        .expect("may budget");
        set_bookkeeping_budget_inner(
            &db,
            SetBookkeepingBudgetInput {
                project_id: None,
                month: "2026-06".to_string(),
                category_code: "food".to_string(),
                limit_minor: 1_000,
                currency: None,
                rollover: true,
                note: None,
            },
        )
        .await
        .expect("june budget");

        let status = bookkeeping_budget_status_inner(&db, "2026-06", None)
            .await
            .expect("status");

        assert_eq!(status[0].rollover_in_minor, 2_000);
        assert_eq!(status[0].spent_minor, 3_500);
        assert_eq!(status[0].remaining_minor, -500);
        assert!(status[0].pct > 1.0);
    }

    #[tokio::test]
    async fn sync_failure_scrubs_sensitive_values_before_storage() {
        let db = pool().await;
        let job = record_bookkeeping_sync_failure_inner(
            &db,
            RecordBookkeepingSyncFailureInput {
                source: BookkeepingSource::Gmail,
                error_code: "gmail.parse_failed".to_string(),
                raw_error_message:
                    "receipt for buyer@example.com card 4111111111111111 order 123456789012 failed"
                        .to_string(),
            },
        )
        .await
        .expect("record failure");

        let message = job.sanitized_error_message.expect("message");
        assert!(message.contains("[redacted"));
        assert!(!message.contains("buyer@example.com"));
        assert!(!message.contains("4111111111111111"));
        assert!(!message.contains("123456789012"));

        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            jobs[0].sanitized_error_message.as_deref(),
            Some(message.as_str())
        );
    }

    #[tokio::test]
    async fn gmail_ingest_parses_receipt_and_dedups_by_message_id() {
        let db = pool().await;
        let input = BookkeepingEmailReceiptInput {
            project_id: None,
            message_id: "gmail-message-001".to_string(),
            from: "receipts@coupang.test".to_string(),
            subject: "[쿠팡] 결제 영수증".to_string(),
            snippet: "쿠팡 결제금액 23,400원".to_string(),
            body_text: "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원".to_string(),
            received_at: Some("2026-06-16T10:11:12+09:00".to_string()),
        };

        let first = ingest_bookkeeping_gmail_receipt_inner(&db, input.clone())
            .await
            .expect("first ingest")
            .expect("receipt parsed");
        let second = ingest_bookkeeping_gmail_receipt_inner(&db, input)
            .await
            .expect("retry ingest")
            .expect("receipt parsed on retry");

        assert_eq!(first.id, second.id, "Gmail retry should upsert same row");
        assert_eq!(second.source, BookkeepingSource::Gmail);
        assert_eq!(second.source_ref.as_deref(), Some("gmail-message-001"));
        assert_eq!(second.merchant, "쿠팡");
        assert_eq!(second.amount_minor, 23_400);
        assert_eq!(second.spent_at, "2026-06-16");
        assert_eq!(second.review_status, BookkeepingReviewStatus::NeedsReview);

        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("transactions");
        assert_eq!(rows.len(), 1, "source_ref dedup should keep one row");
    }

    #[tokio::test]
    async fn gmail_ingest_records_sanitized_failure_when_receipt_is_unparseable() {
        let db = pool().await;
        let created = ingest_bookkeeping_gmail_receipt_inner(
            &db,
            BookkeepingEmailReceiptInput {
                project_id: None,
                message_id: "gmail-message-002".to_string(),
                from: "buyer@example.com".to_string(),
                subject: "hello".to_string(),
                snippet: "card 4111111111111111".to_string(),
                body_text: "no amount or merchant here 123456789012".to_string(),
                received_at: Some("2026-06-16T10:11:12+09:00".to_string()),
            },
        )
        .await
        .expect("unparseable is non-fatal");

        assert!(
            created.is_none(),
            "unparseable mail should not create a row"
        );
        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].source, BookkeepingSource::Gmail);
        assert_eq!(
            jobs[0].sanitized_error_code.as_deref(),
            Some("gmail.parse_failed")
        );
        let message = jobs[0]
            .sanitized_error_message
            .as_deref()
            .expect("sanitized message");
        assert!(!message.contains("buyer@example.com"));
        assert!(!message.contains("4111111111111111"));
        assert!(!message.contains("123456789012"));
    }

    #[tokio::test]
    async fn gmail_sync_resolves_label_names_and_ingests_candidates() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");

        let mut candidates = std::collections::HashMap::new();
        candidates.insert(
            "ok-1".to_string(),
            GmailReceiptCandidate {
                message_id: "ok-1".to_string(),
                from: "receipts@coupang.test".to_string(),
                subject: "[쿠팡] 결제 영수증".to_string(),
                snippet: "쿠팡 결제금액 23,400원".to_string(),
                body_text: "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원".to_string(),
                received_at: Some("2026-06-16T10:11:12Z".to_string()),
            },
        );
        candidates.insert(
            "bad-1".to_string(),
            GmailReceiptCandidate {
                message_id: "bad-1".to_string(),
                from: "buyer@example.com".to_string(),
                subject: "not a receipt".to_string(),
                snippet: "card 4111111111111111".to_string(),
                body_text: "no parseable amount 123456789012".to_string(),
                received_at: Some("2026-06-16T10:11:12Z".to_string()),
            },
        );
        let provider = FakeGmailReadProvider {
            labels: vec![GmailLabelInfo {
                id: "Label_42".to_string(),
                name: "가계부".to_string(),
            }],
            ids: vec!["ok-1".to_string(), "bad-1".to_string()],
            candidates,
            searches: Mutex::new(Vec::new()),
        };

        let result = sync_bookkeeping_gmail_receipts_with_provider(
            &db,
            &provider,
            "access-token",
            SyncBookkeepingGmailReceiptsInput {
                project_id: project.id.clone(),
                label_ids: Vec::new(),
                label_names: vec!["가계부".to_string()],
                query: Some("newer_than:30d".to_string()),
                max_results: Some(10),
            },
        )
        .await
        .expect("sync");

        assert_eq!(result.scanned_count, 2);
        assert_eq!(result.imported_count, 1);
        assert_eq!(result.failed_count, 1);
        let search = {
            let searches = provider.searches.lock().expect("searches");
            assert_eq!(searches.len(), 1);
            searches[0].clone()
        };
        assert_eq!(search.label_ids, vec!["Label_42".to_string()]);
        assert_eq!(search.query.as_deref(), Some("newer_than:30d"));

        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("transactions");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_ref.as_deref(), Some("ok-1"));
        assert_eq!(rows[0].project_id.as_deref(), Some(project.id.as_str()));

        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        assert_eq!(jobs.len(), 2, "parse failure + completed sync marker");
        assert!(jobs.iter().any(|job| job.status == "succeeded"));
        let parse_failure = jobs
            .iter()
            .find(|job| job.sanitized_error_code.as_deref() == Some("gmail.parse_failed"))
            .expect("parse failure job");
        let message = parse_failure
            .sanitized_error_message
            .as_deref()
            .unwrap_or_default();
        assert!(!message.contains("buyer@example.com"));
        assert!(!message.contains("4111111111111111"));
        assert!(!message.contains("123456789012"));
    }

    #[tokio::test]
    async fn gmail_sync_requires_a_bounded_filter() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");
        let provider = FakeGmailReadProvider::default();

        let err = sync_bookkeeping_gmail_receipts_with_provider(
            &db,
            &provider,
            "access-token",
            SyncBookkeepingGmailReceiptsInput {
                project_id: project.id,
                label_ids: Vec::new(),
                label_names: Vec::new(),
                query: None,
                max_results: Some(10),
            },
        )
        .await
        .expect_err("unbounded Gmail scan should be rejected");

        assert_eq!(err.code, "bookkeeping.gmail.filter");
    }

    #[tokio::test]
    async fn recurring_expense_generates_monthly_occurrence_and_posts_transaction() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");

        let recurring = create_bookkeeping_recurring_expense_inner(
            &db,
            CreateBookkeepingRecurringExpenseInput {
                project_id: Some(project.id.clone()),
                name: "월세".to_string(),
                merchant: Some("건물주".to_string()),
                amount_minor: 900_000,
                currency: "KRW".to_string(),
                category: "housing".to_string(),
                payment_method_kind: BookkeepingPaymentMethodKind::BankTransfer,
                payment_method_label: Some("주거래 계좌".to_string()),
                payment_method_last4: Some("4821".to_string()),
                expense_kind: BookkeepingExpenseKind::Fixed,
                schedule_day: 25,
                start_month: "2026-06".to_string(),
                end_month: None,
                note: Some("메일로 관측 불가".to_string()),
            },
        )
        .await
        .expect("create recurring expense");

        let occurrences = ensure_bookkeeping_recurring_occurrences_inner(&db, "2026-06", None)
            .await
            .expect("ensure occurrences");
        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].recurring_expense_id, recurring.id);
        assert_eq!(occurrences[0].due_date, "2026-06-25");
        assert_eq!(
            occurrences[0].payment_method_kind,
            BookkeepingPaymentMethodKind::BankTransfer
        );

        let posted = post_bookkeeping_recurring_occurrence_inner(&db, &occurrences[0].id)
            .await
            .expect("post occurrence");
        assert_eq!(posted.status, BookkeepingRecurringOccurrenceStatus::Posted);
        assert!(posted.transaction_id.is_some());

        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("transactions");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].expense_kind, BookkeepingExpenseKind::Fixed);
        assert_eq!(
            rows[0].payment_method_kind,
            BookkeepingPaymentMethodKind::BankTransfer
        );
        assert_eq!(rows[0].payment_method_label.as_deref(), Some("주거래 계좌"));
        assert_eq!(rows[0].payment_method_last4.as_deref(), Some("4821"));
        assert_eq!(
            rows[0].recurring_expense_id.as_deref(),
            Some(recurring.id.as_str())
        );
        assert_eq!(
            rows[0].recurring_occurrence_id.as_deref(),
            Some(posted.id.as_str())
        );

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");
        assert_eq!(summary.total_amount_minor, 900_000);
    }

    #[tokio::test]
    async fn summary_splits_income_expense_and_alias_equals_expense() {
        let db = pool().await;
        let expense = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 10_000, "2026-06-01", "food"),
        )
        .await
        .expect("expense");
        update_bookkeeping_review_status_inner(&db, &expense.id, BookkeepingReviewStatus::Approved)
            .await
            .expect("approve expense");

        let mut income = manual_input("용돈", 50_000, "2026-06-02", "income");
        income.direction = BookkeepingDirection::Income;
        create_bookkeeping_transaction_inner(&db, income)
            .await
            .expect("income");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");
        assert_eq!(summary.total_expense_minor, 10_000);
        assert_eq!(summary.total_income_minor, 50_000);
        assert_eq!(summary.net_minor, 40_000);
        assert_eq!(
            summary.total_amount_minor, 10_000,
            "legacy alias must equal expense, never include income"
        );
        assert_eq!(summary.categories.len(), 1, "income excluded from chart");
        assert_eq!(summary.categories[0].category, "food");
    }

    #[tokio::test]
    async fn summary_separates_duplicate_from_ignored_counts() {
        let db = pool().await;
        let original = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("original");
        let dup = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A copy", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("dup");
        let plain = create_bookkeeping_transaction_inner(
            &db,
            manual_input("noise", 500, "2026-06-01", "misc"),
        )
        .await
        .expect("plain");
        update_bookkeeping_review_status_inner(&db, &plain.id, BookkeepingReviewStatus::Ignored)
            .await
            .expect("ignore plain");
        // Simulate mark_duplicate (Phase D command) at the SQL level for the summary contract.
        sqlx::query(
            "UPDATE bookkeeping_transactions SET review_status='ignored', \
             duplicate_of_transaction_id=?2 WHERE id=?1",
        )
        .bind(&dup.id)
        .bind(&original.id)
        .execute(&db)
        .await
        .expect("mark dup");

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06", None)
            .await
            .expect("summary");
        assert_eq!(summary.ignored_count, 1, "user-ignored excludes duplicates");
        assert_eq!(summary.duplicate_count, 1);
    }

    #[tokio::test]
    async fn judgment_fields_round_trip_on_create() {
        let db = pool().await;
        let mut input = manual_input("쿠팡", 59_010, "2026-06-12", "shopping");
        input.account = Some("하나".to_string());
        input.subcategory = Some("생활용품".to_string());
        input.category_code = Some("shopping".to_string());
        input.subcategory_code = Some("daily_goods".to_string());
        input.raw_category = Some("🪑 생활용품".to_string());
        input.spent_at_time = Some("14:28:47".to_string());
        input.confidence = Some(0.92);
        input.field_confidence_json = Some("{\"amount\":0.99,\"merchant\":0.7}".to_string());
        input.review_reasons_json = Some("[{\"code\":\"low_merchant_confidence\"}]".to_string());
        input.order_no = Some("ORDER-1".to_string());
        input.payment_no = Some("PAY-1".to_string());

        let row = create_bookkeeping_transaction_inner(&db, input)
            .await
            .expect("create with judgment fields");

        assert_eq!(row.direction, BookkeepingDirection::Expense);
        assert_eq!(row.account.as_deref(), Some("하나"));
        assert_eq!(row.subcategory.as_deref(), Some("생활용품"));
        assert_eq!(row.raw_category.as_deref(), Some("🪑 생활용품"));
        assert_eq!(row.spent_at_time.as_deref(), Some("14:28:47"));
        assert_eq!(row.confidence, Some(0.92));
        assert_eq!(row.order_no.as_deref(), Some("ORDER-1"));
        assert_eq!(row.payment_no.as_deref(), Some("PAY-1"));
        assert!(row.field_confidence_json.contains("amount"));
        assert!(row.review_reasons_json.contains("low_merchant_confidence"));

        // Defaults when omitted.
        let plain = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Cafe", 4_500, "2026-06-12", "food"),
        )
        .await
        .expect("plain create");
        assert_eq!(plain.field_confidence_json, "{}");
        assert_eq!(plain.review_reasons_json, "[]");
        assert!(plain.confidence.is_none());
    }

    #[tokio::test]
    async fn rejects_malformed_judgment_inputs() {
        let db = pool().await;

        let mut bad_json = manual_input("X", 100, "2026-06-01", "food");
        bad_json.field_confidence_json = Some("not json".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, bad_json)
                .await
                .is_err(),
            "invalid JSON rejected"
        );

        let mut wrong_shape = manual_input("X", 100, "2026-06-01", "food");
        wrong_shape.field_confidence_json = Some("[1,2,3]".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, wrong_shape)
                .await
                .is_err(),
            "object-shaped field must reject an array"
        );

        let mut bad_time = manual_input("X", 100, "2026-06-01", "food");
        bad_time.spent_at_time = Some("9:9:9".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, bad_time)
                .await
                .is_err(),
            "malformed time rejected"
        );

        let mut out_of_range_time = manual_input("X", 100, "2026-06-01", "food");
        out_of_range_time.spent_at_time = Some("25:61:99".to_string());
        assert!(
            create_bookkeeping_transaction_inner(&db, out_of_range_time)
                .await
                .is_err(),
            "out-of-range time rejected"
        );

        let mut bad_conf = manual_input("X", 100, "2026-06-01", "food");
        bad_conf.confidence = Some(1.5);
        assert!(
            create_bookkeeping_transaction_inner(&db, bad_conf)
                .await
                .is_err(),
            "confidence out of range rejected"
        );
    }

    #[tokio::test]
    async fn taxonomy_seed_is_loaded() {
        let db = pool().await;
        let nodes = list_bookkeeping_taxonomy_inner(&db)
            .await
            .expect("taxonomy");
        assert!(nodes
            .iter()
            .any(|n| n.code == "food" && n.parent_code.is_none()));
        assert!(nodes
            .iter()
            .any(|n| n.code == "shopping_daily" && n.parent_code.as_deref() == Some("shopping")));
        let uncategorized = nodes
            .iter()
            .find(|n| n.code == "uncategorized")
            .expect("uncategorized node");
        assert_eq!(uncategorized.label, "미분류");

        let rules = bookkeeping_category_rules_inner(&db)
            .await
            .expect("category rules");
        assert!(!rules.aliases.is_empty());
    }

    #[tokio::test]
    async fn resolver_maps_emoji_raw_label_via_alias() {
        let db = pool().await;
        let resolved = resolve_category_inner(
            &db,
            None,
            None,
            "uncategorized",
            Some("🪑 생활용품"),
            "쿠팡",
        )
        .await
        .expect("resolve");
        assert_eq!(resolved.category_code.as_deref(), Some("shopping"));
        assert_eq!(resolved.subcategory_code.as_deref(), Some("shopping_daily"));
        assert!(resolved.confidence.unwrap_or(0.0) > 0.5);
    }

    #[tokio::test]
    async fn resolver_falls_back_to_uncategorized_and_honors_explicit_code() {
        let db = pool().await;

        let unknown = resolve_category_inner(
            &db,
            None,
            None,
            "uncategorized",
            Some("듣도보도 못한 라벨"),
            "정체불명",
        )
        .await
        .expect("resolve unknown");
        assert_eq!(unknown.category_code.as_deref(), Some("uncategorized"));
        assert_eq!(unknown.confidence, Some(0.0));

        let explicit = resolve_category_inner(
            &db,
            Some("transport"),
            Some("transport_taxi"),
            "uncategorized",
            Some("🪑 생활용품"),
            "쿠팡",
        )
        .await
        .expect("resolve explicit");
        assert_eq!(explicit.category_code.as_deref(), Some("transport"));
        assert_eq!(explicit.subcategory_code.as_deref(), Some("transport_taxi"));
        assert_eq!(
            explicit.confidence, None,
            "explicit code is caller-authoritative"
        );
    }

    #[tokio::test]
    async fn ingest_create_resolves_category_code_from_raw_label() {
        let db = pool().await;
        let mut input = manual_input("쿠팡", 59_010, "2026-06-12", "uncategorized");
        input.source = BookkeepingSource::Gmail;
        input.source_ref = Some("ingest-resolve-1".to_string());
        input.raw_category = Some("🪑 생활용품".to_string());
        let row = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input,
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("ingest");
        assert_eq!(row.category_code.as_deref(), Some("shopping"));
        assert_eq!(row.subcategory_code.as_deref(), Some("shopping_daily"));
        assert_eq!(row.raw_category.as_deref(), Some("🪑 생활용품"));
    }

    #[tokio::test]
    async fn override_category_writes_history_and_updates_row() {
        let db = pool().await;
        let row = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Market", 12_000, "2026-06-01", "food"),
        )
        .await
        .expect("create");
        assert_eq!(row.category_code.as_deref(), Some("food"));

        let updated = override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: row.id.clone(),
                category_code: Some("transport".to_string()),
                subcategory_code: Some("transport_taxi".to_string()),
                reason: Some("실은 택시비".to_string()),
            },
        )
        .await
        .expect("override");
        assert_eq!(updated.category_code.as_deref(), Some("transport"));
        assert_eq!(updated.subcategory_code.as_deref(), Some("transport_taxi"));

        let history = list_bookkeeping_category_overrides_inner(&db, &row.id)
            .await
            .expect("override history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].from_code.as_deref(), Some("food"));
        assert_eq!(history[0].to_code.as_deref(), Some("transport"));

        let audit = list_bookkeeping_audit_inner(&db, Some(row.id))
            .await
            .expect("audit");
        assert!(audit
            .iter()
            .any(|a| a.action == "transaction.category_overridden"));
    }

    #[tokio::test]
    async fn reingest_preserves_user_category_and_direction_override() {
        let db = pool().await;
        let mut input = manual_input("쿠팡", 10_000, "2026-06-12", "uncategorized");
        input.source = BookkeepingSource::Gmail;
        input.source_ref = Some("msg-clobber-1".to_string());
        input.raw_category = Some("🪑 생활용품".to_string());

        let row = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input.clone(),
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("first ingest");
        assert_eq!(row.category_code.as_deref(), Some("shopping"));

        // User corrects category + direction.
        override_bookkeeping_category_inner(
            &db,
            OverrideBookkeepingCategoryInput {
                transaction_id: row.id.clone(),
                category_code: Some("transport".to_string()),
                subcategory_code: Some("transport_taxi".to_string()),
                reason: None,
            },
        )
        .await
        .expect("override");
        sqlx::query("UPDATE bookkeeping_transactions SET direction='income' WHERE id=?1")
            .bind(&row.id)
            .execute(&db)
            .await
            .expect("direction correction");

        // Gmail re-sync re-ingests the same message_id.
        let reingested = upsert_bookkeeping_transaction_from_ingest_inner(
            &db,
            input,
            "transaction.gmail_ingested",
            "x",
        )
        .await
        .expect("re-ingest");
        assert_eq!(reingested.id, row.id);
        assert_eq!(
            reingested.category_code.as_deref(),
            Some("transport"),
            "user category override must survive Gmail re-sync"
        );
        assert_eq!(
            reingested.subcategory_code.as_deref(),
            Some("transport_taxi")
        );
        assert_eq!(
            reingested.direction,
            BookkeepingDirection::Income,
            "user direction correction must survive re-sync"
        );
    }

    #[tokio::test]
    async fn line_items_round_trip_and_toggle_sum_mismatch_reason() {
        let db = pool().await;
        let row = create_bookkeeping_transaction_inner(
            &db,
            manual_input("Mart", 10_000, "2026-06-01", "food"),
        )
        .await
        .expect("create");

        // Items summing to 9_000 (4_000 + 2_500*2) ≠ 10_000 → mismatch reason.
        let items = set_bookkeeping_line_items_inner(
            &db,
            SetBookkeepingLineItemsInput {
                transaction_id: row.id.clone(),
                items: vec![
                    CreateBookkeepingLineItemInput {
                        name: "사과".to_string(),
                        amount_minor: 4_000,
                        quantity: Some(1),
                        category_code: None,
                    },
                    CreateBookkeepingLineItemInput {
                        name: "우유".to_string(),
                        amount_minor: 2_500,
                        quantity: Some(2),
                        category_code: None,
                    },
                ],
            },
        )
        .await
        .expect("set line items");
        assert_eq!(items.len(), 2);

        let after_mismatch = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("list")
            .into_iter()
            .find(|t| t.id == row.id)
            .expect("row");
        assert!(after_mismatch
            .review_reasons_json
            .contains("line_item_sum_mismatch"));

        // Replace with a matching single item (10_000) → reason cleared.
        set_bookkeeping_line_items_inner(
            &db,
            SetBookkeepingLineItemsInput {
                transaction_id: row.id.clone(),
                items: vec![CreateBookkeepingLineItemInput {
                    name: "합계".to_string(),
                    amount_minor: 10_000,
                    quantity: Some(1),
                    category_code: None,
                }],
            },
        )
        .await
        .expect("set matching line items");

        let after_match = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("list")
            .into_iter()
            .find(|t| t.id == row.id)
            .expect("row");
        assert!(
            !after_match
                .review_reasons_json
                .contains("line_item_sum_mismatch"),
            "mismatch reason cleared once items reconcile"
        );
        assert_eq!(
            list_bookkeeping_line_items_inner(&db, &row.id)
                .await
                .expect("items")
                .len(),
            1,
            "set replaces the prior line-item set"
        );
    }

    fn dup_input(
        spent_at: &str,
        amount_minor: i32,
        merchant: Option<&str>,
    ) -> FindBookkeepingDuplicateCandidatesInput {
        FindBookkeepingDuplicateCandidatesInput {
            project_id: None,
            spent_at: spent_at.to_string(),
            amount_minor,
            merchant: merchant.map(str::to_string),
            order_no: None,
            payment_no: None,
            source: None,
            source_ref: None,
            exclude_transaction_id: None,
        }
    }

    #[tokio::test]
    async fn find_duplicate_candidates_scores_strong_and_weak_signals() {
        let db = pool().await;
        let mut a = manual_input("쿠팡", 59_010, "2026-06-12", "shopping");
        a.source = BookkeepingSource::Gmail;
        a.source_ref = Some("msg-A".to_string());
        a.order_no = Some("ORD-1".to_string());
        let existing = create_bookkeeping_transaction_inner(&db, a)
            .await
            .expect("existing");

        // Exact source_ref → 1.0.
        let by_ref = find_bookkeeping_duplicate_candidates_inner(
            &db,
            FindBookkeepingDuplicateCandidatesInput {
                source: Some(BookkeepingSource::Gmail),
                source_ref: Some("msg-A".to_string()),
                ..dup_input("2026-06-12", 59_010, None)
            },
        )
        .await
        .expect("by ref");
        let hit = by_ref
            .iter()
            .find(|c| c.transaction.id == existing.id)
            .expect("source_ref hit");
        assert!((hit.score - 1.0).abs() < 1e-9);

        // Amount + same date + merchant overlap, no strong key → high but < 1.0.
        let by_weak = find_bookkeeping_duplicate_candidates_inner(
            &db,
            dup_input("2026-06-12", 59_010, Some("쿠팡 결제")),
        )
        .await
        .expect("by weak");
        let weak = by_weak
            .iter()
            .find(|c| c.transaction.id == existing.id)
            .expect("weak hit");
        assert!(
            weak.score >= 0.9 && weak.score < 1.0,
            "score={}",
            weak.score
        );

        // Amount only, date 2 days off → graded lower.
        let near =
            find_bookkeeping_duplicate_candidates_inner(&db, dup_input("2026-06-14", 59_010, None))
                .await
                .expect("near");
        let near_hit = near
            .iter()
            .find(|c| c.transaction.id == existing.id)
            .expect("near hit");
        assert!(near_hit.score >= 0.6 && near_hit.score < 0.8);

        // Excluding self yields no self-match.
        let excluded = find_bookkeeping_duplicate_candidates_inner(
            &db,
            FindBookkeepingDuplicateCandidatesInput {
                exclude_transaction_id: Some(existing.id.clone()),
                ..dup_input("2026-06-12", 59_010, Some("쿠팡"))
            },
        )
        .await
        .expect("excluded");
        assert!(!excluded.iter().any(|c| c.transaction.id == existing.id));
    }

    #[tokio::test]
    async fn mark_duplicate_sets_state_rejects_self_and_excludes_from_candidates() {
        let db = pool().await;
        let original = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("original");
        let dup = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A copy", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("dup");

        let marked = mark_bookkeeping_duplicate_inner(&db, &dup.id, &original.id)
            .await
            .expect("mark");
        assert_eq!(marked.review_status, BookkeepingReviewStatus::Ignored);
        assert_eq!(
            marked.duplicate_of_transaction_id.as_deref(),
            Some(original.id.as_str())
        );

        assert!(
            mark_bookkeeping_duplicate_inner(&db, &original.id, &original.id)
                .await
                .is_err(),
            "self-reference rejected"
        );
        assert!(
            mark_bookkeeping_duplicate_inner(&db, &dup.id, "does-not-exist")
                .await
                .is_err(),
            "unknown target rejected"
        );

        // No duplicate chains: dup is itself a duplicate, so it cannot be a mark target.
        let third = create_bookkeeping_transaction_inner(
            &db,
            manual_input("A copy 2", 1_000, "2026-06-01", "food"),
        )
        .await
        .expect("third");
        assert!(
            mark_bookkeeping_duplicate_inner(&db, &third.id, &dup.id)
                .await
                .is_err(),
            "cannot mark as duplicate-of a row that is itself a duplicate"
        );

        let audit = list_bookkeeping_audit_inner(&db, Some(dup.id.clone()))
            .await
            .expect("audit");
        assert!(audit
            .iter()
            .any(|a| a.action == "transaction.marked_duplicate"));

        // The already-duplicate row must not be suggested as a candidate for another row.
        let cands = find_bookkeeping_duplicate_candidates_inner(
            &db,
            FindBookkeepingDuplicateCandidatesInput {
                exclude_transaction_id: Some(original.id.clone()),
                ..dup_input("2026-06-01", 1_000, Some("A"))
            },
        )
        .await
        .expect("candidates");
        assert!(
            !cands.iter().any(|c| c.transaction.id == dup.id),
            "a row already marked duplicate is never suggested"
        );
    }

    #[tokio::test]
    async fn gmail_sync_advances_cursor_and_second_run_uses_after_query() {
        let db = pool().await;
        let project = crate::commands::projects::insert_project(
            &db,
            &CreateProjectInput {
                name: "Personal".to_string(),
                kind: ProjectKind::Personal,
                notion_backlog_db_id: None,
                notion_agenda_db_id: None,
            },
        )
        .await
        .expect("project");

        let mut candidates = std::collections::HashMap::new();
        candidates.insert(
            "ok-1".to_string(),
            GmailReceiptCandidate {
                message_id: "ok-1".to_string(),
                from: "receipts@coupang.test".to_string(),
                subject: "[쿠팡] 결제 영수증".to_string(),
                snippet: "쿠팡 결제금액 23,400원".to_string(),
                body_text: "상호: 쿠팡\n결제일: 2026.06.16\n결제금액 23,400원".to_string(),
                received_at: Some("2026-06-16T10:11:12Z".to_string()),
            },
        );
        let provider = FakeGmailReadProvider {
            labels: vec![GmailLabelInfo {
                id: "Label_42".to_string(),
                name: "가계부".to_string(),
            }],
            ids: vec!["ok-1".to_string()],
            candidates,
            searches: Mutex::new(Vec::new()),
        };

        let input = || SyncBookkeepingGmailReceiptsInput {
            project_id: project.id.clone(),
            label_ids: Vec::new(),
            label_names: vec!["가계부".to_string()],
            query: None,
            max_results: Some(10),
        };

        // First run: no cursor → no after: filter; persists cursor at the receipt date.
        let r1 = sync_bookkeeping_gmail_receipts_with_provider(&db, &provider, "tok", input())
            .await
            .expect("first sync");
        assert_eq!(r1.imported_count, 1);
        assert_eq!(r1.duplicate_count, 0);
        assert_eq!(r1.cursor_after.as_deref(), Some("2026-06-16"));
        let cursors = list_bookkeeping_sync_cursors_inner(&db)
            .await
            .expect("cursors");
        assert_eq!(cursors.len(), 1);
        assert_eq!(cursors[0].cursor_value, "2026-06-16");

        // Second run: cursor present → re-scan of the same message is a duplicate, and the search
        // query is now the cursor-derived after: filter.
        let r2 = sync_bookkeeping_gmail_receipts_with_provider(&db, &provider, "tok", input())
            .await
            .expect("second sync");
        assert_eq!(r2.imported_count, 0);
        assert_eq!(r2.duplicate_count, 1);

        let last_query = {
            let searches = provider.searches.lock().expect("searches");
            searches.last().expect("a search").query.clone()
        };
        // Cursor is 2026-06-16; the after: window is widened one day back for TZ skew.
        assert_eq!(last_query.as_deref(), Some("after:2026/06/15"));

        // Still one transaction row (dedup), and the latest job carries counts + cursors.
        let rows = list_bookkeeping_transactions_inner(&db, None, None)
            .await
            .expect("rows");
        assert_eq!(rows.len(), 1);
        let jobs = list_bookkeeping_sync_jobs_inner(&db).await.expect("jobs");
        let latest_success = jobs
            .iter()
            .find(|j| j.status == "succeeded")
            .expect("success job");
        assert_eq!(latest_success.cursor_after.as_deref(), Some("2026-06-16"));
        assert!(latest_success.scanned_count >= 1);
    }

    #[test]
    fn date_minus_one_day_handles_boundaries() {
        assert_eq!(
            date_minus_one_day("2026-06-16").as_deref(),
            Some("2026-06-15")
        );
        assert_eq!(
            date_minus_one_day("2026-06-01").as_deref(),
            Some("2026-05-31")
        );
        assert_eq!(
            date_minus_one_day("2026-01-01").as_deref(),
            Some("2025-12-31")
        );
        assert_eq!(
            date_minus_one_day("2024-03-01").as_deref(),
            Some("2024-02-29")
        ); // leap
        assert_eq!(
            date_minus_one_day("2026-03-01").as_deref(),
            Some("2026-02-28")
        );
        assert!(date_minus_one_day("nope").is_none());
    }
}
