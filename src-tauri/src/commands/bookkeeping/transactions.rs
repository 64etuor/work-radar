//! 가계부 거래 CRUD + 일괄/소프트삭제/휴지통 IPC 커맨드와 inner.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingBulkItemResult, BookkeepingReviewStatus, BookkeepingSource, BookkeepingTransaction,
    CreateBookkeepingTransactionInput, OverrideBookkeepingCategoryInput,
    UpdateBookkeepingTransactionInput,
};

use super::*;

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
    order_by: Option<String>,
    from_date: Option<String>,
    to_date: Option<String>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    list_bookkeeping_transactions_ordered_inner(
        db.inner(),
        status,
        project_id.as_deref(),
        order_by.as_deref(),
        from_date.as_deref(),
        to_date.as_deref(),
    )
    .await
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
    // `note` is app-note-wins (existing-first COALESCE): a note the user wrote/edited in the app
    // must survive re-ingest, and a source memo (mmbak ZDATA 등) only fills a NULL note — a
    // CHANGED source memo never overwrites a stored note. gmail passes note=None (byte-identical
    // under either order); OCR re-ingest likewise can no longer clobber a stored note.
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
           note=COALESCE(bookkeeping_transactions.note, excluded.note), \
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

/// Ingest **insert-if-absent**: 호출자-권위 코드(caller-authoritative codes)를 존재 여부와
/// **원자적으로** 싣는 경로. `ON CONFLICT(source, source_ref) DO NOTHING` + RETURNING —
/// `Some(row)`는 이 호출이 실제로 삽입했을 때만 돌아온다. 행이 이미 있으면(동시 임포트
/// 레이스 포함) 아무것도 쓰지 않는다 — 명시 코드가 conflict COALESCE 경로로 새어들어
/// 사람이 고른 (대분류, sub 없음) 아래에 소스 sub 코드를 채우는 창을 SQL 레벨에서 없앤다.
/// 기존 행 갱신은 호출자가 별도로 공유 upsert(명시 코드 없이)를 타야 한다. gmail이
/// 의존하는 공유 upsert SQL은 건드리지 않는다.
pub(crate) async fn insert_bookkeeping_transaction_from_ingest_if_absent_inner(
    db: &Db,
    input: CreateBookkeepingTransactionInput,
    audit_action: &str,
    audit_summary: &str,
) -> Result<Option<BookkeepingTransaction>, AppError> {
    let Some(source_ref) = clean_optional(input.source_ref.as_deref()) else {
        return Err(AppError::validation(
            "bookkeeping.source_ref",
            "insert-if-absent 경로는 source_ref가 필요합니다",
        ));
    };
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
    let description = clean_optional(input.description.as_deref());
    let note = clean_optional(input.note.as_deref());
    let payment_method_label = clean_optional(input.payment_method_label.as_deref());
    let payment_method_last4 = clean_payment_last4(input.payment_method_last4.as_deref())?;
    let mut jf = prepare_judgment_fields(&input)?;
    apply_category_resolution(db, &mut jf, &category, &merchant).await?;

    let mut tx = db.begin().await?;
    let insert_sql = format!(
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
         ON CONFLICT(source, source_ref) WHERE source_ref IS NOT NULL DO NOTHING \
         RETURNING {TRANSACTION_RETURNING_COLUMNS}"
    );
    let row = sqlx::query_as::<_, BookkeepingTransaction>(&insert_sql)
        .bind(input.project_id.as_deref())
        .bind(input.source)
        .bind(&source_ref)
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
        .fetch_optional(&mut *tx)
        .await?;

    let Some(row) = row else {
        // conflict → DO NOTHING: 아무것도 안 썼으니 감사 기록도 없다.
        return Ok(None);
    };
    insert_audit_log_tx(
        &mut tx,
        "transaction",
        &row.id,
        audit_action,
        audit_summary,
        serde_json::json!({
            "source": input.source,
            "reviewStatus": row.review_status,
            "hasSourceRef": true
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(Some(row))
}

/// `(source, source_ref)`로 기존 행 id를 찾는다. insert-if-absent가 conflict로 `None`을 반환했을 때
/// "이미 있음"을 호출자에게 알려주기 위한 조회 — 소프트 삭제된 행도 unique 인덱스를 점유하므로
/// 함께 잡는다(그래야 "왜 안 들어갔는지"가 설명된다).
pub(crate) async fn find_transaction_id_by_source_ref(
    db: &Db,
    source: BookkeepingSource,
    source_ref: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM bookkeeping_transactions WHERE source = ?1 AND source_ref = ?2",
    )
    .bind(source)
    .bind(source_ref)
    .fetch_optional(db)
    .await?)
}

pub(crate) async fn list_bookkeeping_transactions_inner(
    db: &Db,
    status: Option<BookkeepingReviewStatus>,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    list_bookkeeping_transactions_ordered_inner(db, status, project_id, None, None, None).await
}

pub(crate) async fn list_bookkeeping_transactions_ordered_inner(
    db: &Db,
    status: Option<BookkeepingReviewStatus>,
    project_id: Option<&str>,
    order_by: Option<&str>,
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    if let Some(from) = from_date {
        validate_date(from)?;
    }
    if let Some(to) = to_date {
        validate_date(to)?;
    }
    let order_clause = match order_by.map(str::trim).filter(|v| !v.is_empty()) {
        None => "spent_at DESC, updated_at DESC, id DESC",
        Some("confidence_asc") => {
            "COALESCE(confidence, 1.0) ASC, spent_at DESC, updated_at DESC, id DESC"
        }
        Some(_) => {
            return Err(AppError::validation(
                "bookkeeping.order_by",
                "지원하지 않는 정렬입니다",
            ));
        }
    };
    let list_sql = format!(
        "SELECT {TRANSACTION_RETURNING_COLUMNS} \
         FROM bookkeeping_transactions \
         WHERE (?1 IS NULL OR review_status = ?1) \
           AND (?2 IS NULL OR project_id = ?2) \
           AND (?3 IS NULL OR spent_at >= ?3) \
           AND (?4 IS NULL OR spent_at <= ?4) \
           AND deleted_at IS NULL \
         ORDER BY {order_clause} \
         LIMIT 200"
    );
    let rows = sqlx::query_as::<_, BookkeepingTransaction>(&list_sql)
        .bind(status)
        .bind(project_id)
        .bind(from_date)
        .bind(to_date)
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
/// best-effort 벌크 실행기: id마다 (트림 후) `op`를 호출하고 그 `Result`만 건별
/// `BookkeepingBulkItemResult`로 분류한다. 한 항목 실패가 나머지를 중단시키지 않는다.
/// 변이 로직(검증/tx/감사)은 각 `op`가 위임받은 단일 inner에 그대로 머문다.
async fn run_bookkeeping_bulk<'a, F, Fut, T>(
    ids: &'a [String],
    mut op: F,
) -> Vec<BookkeepingBulkItemResult>
where
    F: FnMut(&'a str) -> Fut,
    Fut: std::future::Future<Output = Result<T, AppError>>,
{
    let mut out = Vec::with_capacity(ids.len());
    for raw in ids {
        let id = raw.trim();
        let result = match op(id).await {
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

pub(crate) async fn bulk_update_bookkeeping_review_status_inner(
    db: &Db,
    ids: &[String],
    status: BookkeepingReviewStatus,
) -> Vec<BookkeepingBulkItemResult> {
    run_bookkeeping_bulk(ids, |id| {
        update_bookkeeping_review_status_inner(db, id, status)
    })
    .await
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
    run_bookkeeping_bulk(ids, |id| {
        override_bookkeeping_category_inner(
            db,
            OverrideBookkeepingCategoryInput {
                transaction_id: id.to_string(),
                category_code: category_code.map(str::to_string),
                subcategory_code: subcategory_code.map(str::to_string),
                reason: reason.map(str::to_string),
            },
        )
    })
    .await
}

/// 벌크 소프트 삭제. 기존 삭제 inner가 검증, tx, 감사 기록을 소유하므로 항목별로 재사용한다.
pub(crate) async fn bulk_delete_bookkeeping_transactions_inner(
    db: &Db,
    ids: &[String],
) -> Vec<BookkeepingBulkItemResult> {
    run_bookkeeping_bulk(ids, |id| delete_bookkeeping_transaction_inner(db, id)).await
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
