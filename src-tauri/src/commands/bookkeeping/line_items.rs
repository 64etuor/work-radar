//! 가계부 거래 라인아이템 조회/저장 + 합계 불일치 처리.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingLineItem, CreateBookkeepingLineItemInput, SetBookkeepingLineItemsInput,
};

use super::*;

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

pub(crate) const LINE_ITEM_SUM_MISMATCH_CODE: &str = "line_item_sum_mismatch";

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

/// Add or clear the `line_item_sum_mismatch` review reason on a transaction, preserving any other
/// reasons. Malformed prior JSON degrades to an empty reason list (never panics).
pub(crate) async fn update_sum_mismatch_reason_tx(
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
