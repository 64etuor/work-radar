//! 가계부 정기지출 정의 + 월별 occurrence 생성/조회/전기.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingExpenseKind, BookkeepingRecurringExpense, BookkeepingRecurringExpenseStatus,
    BookkeepingRecurringOccurrence, BookkeepingRecurringOccurrenceStatus, BookkeepingTransaction,
    CreateBookkeepingRecurringExpenseInput,
};

use super::*;

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

pub(crate) async fn create_bookkeeping_recurring_expense_inner(
    db: &Db,
    input: CreateBookkeepingRecurringExpenseInput,
) -> Result<BookkeepingRecurringExpense, AppError> {
    let name = clean_required(&input.name, "bookkeeping.recurring.name")?;
    let merchant = clean_optional(input.merchant.as_deref());
    let category = clean_required(&input.category, "bookkeeping.category")?;
    let currency = clean_currency_or_default(db, &input.currency).await?;
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
    let rules = sqlx::query_as::<_, BookkeepingRecurringExpense>(&format!(
        "SELECT {RECURRING_EXPENSE_RETURNING_COLUMNS} \
         FROM bookkeeping_recurring_expenses \
         WHERE status = 'active' \
           AND start_month <= ?1 \
           AND (end_month IS NULL OR end_month >= ?1) \
           AND (?2 IS NULL OR project_id = ?2)"
    ))
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
    let result = sqlx::query(
        "UPDATE bookkeeping_recurring_occurrences SET \
           status=?2, transaction_id=CASE WHEN ?2='planned' THEN NULL ELSE transaction_id END, \
           updated_at=datetime('now') \
         WHERE id=?1 AND status != 'posted'",
    )
    .bind(&id)
    .bind(status)
    .execute(db)
    .await?;
    let sql = recurring_occurrence_select_sql("WHERE o.id = ?1");
    let occurrence = sqlx::query_as::<_, BookkeepingRecurringOccurrence>(&sql)
        .bind(&id)
        .fetch_one(db)
        .await?;
    if result.rows_affected() == 0
        && occurrence.status == BookkeepingRecurringOccurrenceStatus::Posted
    {
        return Err(AppError::validation(
            "bookkeeping.recurring.posted",
            "이미 전표 처리된 고정비는 예정 또는 건너뜀으로 되돌릴 수 없습니다",
        ));
    }
    Ok(occurrence)
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
fn due_date_for_month(month: &str, schedule_day: i32) -> Result<String, AppError> {
    let (year, mon) = validate_month(month)?;
    let last_day = last_day_of_month(year, mon);
    let day = schedule_day.clamp(1, last_day as i32) as u32;
    Ok(format!("{year:04}-{mon:02}-{day:02}"))
}
