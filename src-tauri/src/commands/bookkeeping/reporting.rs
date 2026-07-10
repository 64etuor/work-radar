//! 가계부 월간 요약·카테고리 추이·현금흐름·계정 대사 리포팅.

use std::collections::{BTreeMap, BTreeSet};

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingCashflowInput, BookkeepingCashflowRow, BookkeepingCategorySummary,
    BookkeepingCategoryTrendInput, BookkeepingCategoryTrendRow, BookkeepingCurrencySummary,
    BookkeepingMonthlySummary, BookkeepingReconcileAccountInput, BookkeepingReconcileAccountResult,
};

use super::*;

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
pub async fn bookkeeping_category_trend(
    db: State<'_, Db>,
    input: BookkeepingCategoryTrendInput,
) -> Result<Vec<BookkeepingCategoryTrendRow>, AppError> {
    bookkeeping_category_trend_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_cashflow(
    db: State<'_, Db>,
    input: BookkeepingCashflowInput,
) -> Result<Vec<BookkeepingCashflowRow>, AppError> {
    bookkeeping_cashflow_inner(db.inner(), input).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_reconcile_account(
    db: State<'_, Db>,
    input: BookkeepingReconcileAccountInput,
) -> Result<BookkeepingReconcileAccountResult, AppError> {
    bookkeeping_reconcile_account_inner(db.inner(), input).await
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

    let currency_rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT currency, \
           COALESCE(SUM(CASE WHEN direction='expense' THEN amount_minor ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN direction='income' THEN amount_minor ELSE 0 END), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 AND review_status != 'ignored' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3) \
         GROUP BY currency \
         ORDER BY currency ASC",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let by_currency = currency_rows
        .into_iter()
        .map(|(currency, expense, income)| {
            let expense_minor = expense.max(0).min(i32::MAX as i64) as i32;
            let income_minor = income.max(0).min(i32::MAX as i64) as i32;
            BookkeepingCurrencySummary {
                currency,
                expense_minor,
                income_minor,
                net_minor: (income - expense).clamp(i32::MIN as i64, i32::MAX as i64) as i32,
            }
        })
        .collect();

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
        by_currency,
    })
}

pub(crate) async fn bookkeeping_category_trend_inner(
    db: &Db,
    input: BookkeepingCategoryTrendInput,
) -> Result<Vec<BookkeepingCategoryTrendRow>, AppError> {
    let project_id = clean_optional(input.project_id.as_deref());
    let months = bounded_months(&input.from_month, &input.to_month)?;
    let (start, _) = month_bounds(months.first().expect("bounded_months is non-empty"))?;
    let (_, end) = month_bounds(months.last().expect("bounded_months is non-empty"))?;
    let category_filter = clean_optional(input.category_code.as_deref());

    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT substr(spent_at, 1, 7), COALESCE(category_code, category), COALESCE(SUM(amount_minor), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 \
           AND review_status != 'ignored' \
           AND direction = 'expense' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3) \
           AND (?4 IS NULL OR COALESCE(category_code, category) = ?4) \
         GROUP BY substr(spent_at, 1, 7), COALESCE(category_code, category)",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id.as_deref())
    .bind(category_filter.as_deref())
    .fetch_all(db)
    .await?;

    let mut categories = BTreeSet::new();
    let mut by_key = BTreeMap::new();
    for (month, category_code, amount) in rows {
        categories.insert(category_code.clone());
        by_key.insert(
            (month, category_code),
            amount.max(0).min(i32::MAX as i64) as i32,
        );
    }
    if let Some(category_code) = category_filter {
        categories.insert(category_code);
    }

    let mut out = Vec::new();
    for month in months {
        for category_code in &categories {
            let label = category_label(db, category_code).await?;
            let expense_minor = by_key
                .get(&(month.clone(), category_code.clone()))
                .copied()
                .unwrap_or(0);
            out.push(BookkeepingCategoryTrendRow {
                month: month.clone(),
                category_code: category_code.clone(),
                label,
                expense_minor,
            });
        }
    }
    Ok(out)
}

pub(crate) async fn bookkeeping_cashflow_inner(
    db: &Db,
    input: BookkeepingCashflowInput,
) -> Result<Vec<BookkeepingCashflowRow>, AppError> {
    let project_id = clean_optional(input.project_id.as_deref());
    let months = bounded_months(&input.from_month, &input.to_month)?;
    let (start, _) = month_bounds(months.first().expect("bounded_months is non-empty"))?;
    let (_, end) = month_bounds(months.last().expect("bounded_months is non-empty"))?;

    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT substr(spent_at, 1, 7), \
           COALESCE(SUM(CASE WHEN direction = 'income' THEN amount_minor ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN direction = 'expense' THEN amount_minor ELSE 0 END), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 \
           AND review_status != 'ignored' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3) \
         GROUP BY substr(spent_at, 1, 7)",
    )
    .bind(&start)
    .bind(&end)
    .bind(project_id.as_deref())
    .fetch_all(db)
    .await?;

    let by_month = rows
        .into_iter()
        .map(|(month, income, expense)| {
            let income_minor = income.max(0).min(i32::MAX as i64) as i32;
            let expense_minor = expense.max(0).min(i32::MAX as i64) as i32;
            (month, (income_minor, expense_minor))
        })
        .collect::<BTreeMap<_, _>>();

    Ok(months
        .into_iter()
        .map(|month| {
            let (income_minor, expense_minor) = by_month.get(&month).copied().unwrap_or((0, 0));
            BookkeepingCashflowRow {
                month,
                income_minor,
                expense_minor,
                net_minor: income_minor - expense_minor,
            }
        })
        .collect())
}

pub(crate) async fn bookkeeping_reconcile_account_inner(
    db: &Db,
    input: BookkeepingReconcileAccountInput,
) -> Result<BookkeepingReconcileAccountResult, AppError> {
    let project_id = clean_optional(input.project_id.as_deref());
    if let Some(project_id) = project_id.as_deref() {
        ensure_project_exists(db, project_id, "bookkeeping.budget.project_not_found").await?;
    }
    let account = clean_required(&input.account, "bookkeeping.reconcile.account")?;
    validate_date(&input.statement_date)?;
    let currency = clean_currency_or_default(db, input.currency.as_deref().unwrap_or("")).await?;
    let note = clean_optional(input.note.as_deref());

    let (income, expense): (i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN direction='income' THEN amount_minor ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN direction='expense' THEN amount_minor ELSE 0 END), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at <= ?1 \
           AND review_status != 'ignored' \
           AND deleted_at IS NULL \
           AND account = ?2 \
           AND currency = ?3 \
           AND (?4 IS NULL OR project_id = ?4)",
    )
    .bind(&input.statement_date)
    .bind(&account)
    .bind(&currency)
    .bind(project_id.as_deref())
    .fetch_one(db)
    .await?;
    let computed_balance = (income - expense).clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let difference = input
        .statement_balance_minor
        .saturating_sub(computed_balance);
    let matched = difference == 0;

    let row: (String, Option<String>) = sqlx::query_as(
        "INSERT INTO bookkeeping_reconciliations \
         (id, project_id, account, statement_date, statement_balance_minor, currency, reconciled_at, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, \
           CASE WHEN ?6 THEN datetime('now') ELSE NULL END, ?7) \
         RETURNING id, reconciled_at",
    )
    .bind(project_id.as_deref())
    .bind(&account)
    .bind(&input.statement_date)
    .bind(input.statement_balance_minor)
    .bind(&currency)
    .bind(matched)
    .bind(note.as_deref())
    .fetch_one(db)
    .await?;

    Ok(BookkeepingReconcileAccountResult {
        id: row.0,
        computed_balance_minor: computed_balance,
        statement_balance_minor: input.statement_balance_minor,
        difference_minor: difference,
        matched,
        unmatched_count: if matched { 0 } else { 1 },
        reconciled_at: row.1,
    })
}
