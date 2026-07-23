use crate::db::Db;
use crate::error::AppError;
use crate::models::{BookkeepingRecurringExpense, BookkeepingRecurringExpenseStatus};

use super::{clean_required, RECURRING_EXPENSE_RETURNING_COLUMNS};

pub(crate) async fn set_bookkeeping_recurring_expense_status_inner(
    db: &Db,
    id: &str,
    status: BookkeepingRecurringExpenseStatus,
) -> Result<BookkeepingRecurringExpense, AppError> {
    let id = clean_required(id, "bookkeeping.recurring.expense_id")?;
    let sql = format!(
        "UPDATE bookkeeping_recurring_expenses SET status=?2, updated_at=datetime('now') \
         WHERE id=?1 RETURNING {RECURRING_EXPENSE_RETURNING_COLUMNS}"
    );
    Ok(sqlx::query_as::<_, BookkeepingRecurringExpense>(&sql)
        .bind(id)
        .bind(status)
        .fetch_one(db)
        .await?)
}
