//! 가계부 고정비 — MoneyManager 미러 전용(2026-07-23 사용자 결정).
//!
//! 규칙의 정본은 MoneyManager 백업(REPEATTRANSACTION)이며 `mmbak_recurring.rs`가
//! 임포트마다 미러한다. 앱/MCP에는 **생성·수정 표면이 없다** — 읽기(목록)와
//! 월별 납부 현황 파생만 노출한다.
//!
//! "월 수입/지출 반영"은 occurrence 같은 저장 상태 없이 파생한다: 규칙과 같은 달의
//! 임포트 거래를 (merchant·금액) 매칭해 납부 여부를 계산하고, 미납 합계만 전망으로
//! 더한다 — MM 실거래가 이미 거래 합계에 있으므로 이중집계가 없다.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingRecurringExpense, BookkeepingRecurringMonthRow, BookkeepingRecurringMonthStatus,
};

use super::*;

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
pub async fn bookkeeping_recurring_month_status(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<BookkeepingRecurringMonthStatus, AppError> {
    bookkeeping_recurring_month_status_inner(db.inner(), &month, project_id.as_deref()).await
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

/// 활성이고 해당 월 범위에 드는 규칙마다, 같은 달 임포트 거래를 매칭해 납부 여부를 판정한다.
///
/// 매칭 규칙(결정적, 저장 없음): 지출 방향·비삭제·비무시 거래 중
/// `금액·통화 == 규칙 금액·통화` **그리고** `merchant == 규칙 merchant 또는 규칙 name`.
/// MM이 반복 규칙에서 만든 실거래는 PAYEE/금액이 규칙과 동일하게 임포트되므로 이걸로 충분하다.
/// 규칙이 프로젝트 스코프면 같은 프로젝트 거래만 매칭한다(전체 뷰 cross-project 오염 방지).
/// 같은 (merchant, 금액) 규칙이 둘이면 같은 거래에 둘 다 매칭될 수 있다 — 허용 트레이드오프
/// (MM 원본에서 규칙을 구분하는 것 외에 로컬 판별 근거가 없다).
/// 합계는 minor 단위 단순 합 — KRW 단일 통화 가정(월 요약 net과 동일한 기존 한계).
pub(crate) async fn bookkeeping_recurring_month_status_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<BookkeepingRecurringMonthStatus, AppError> {
    let (start, end) = month_bounds(month)?;
    type Row = (
        String,
        String,
        Option<String>,
        i32,
        String,
        String,
        i32,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT e.id, e.name, e.merchant, e.amount_minor, e.currency, e.category, \
                e.schedule_day, t.id, t.spent_at \
         FROM bookkeeping_recurring_expenses e \
         LEFT JOIN bookkeeping_transactions t ON t.id = ( \
             SELECT t2.id FROM bookkeeping_transactions t2 \
             WHERE t2.spent_at >= ?1 AND t2.spent_at < ?2 \
               AND t2.direction = 'expense' \
               AND t2.deleted_at IS NULL \
               AND t2.review_status != 'ignored' \
               AND t2.amount_minor = e.amount_minor \
               AND t2.currency = e.currency \
               AND (t2.merchant = e.merchant OR t2.merchant = e.name) \
               AND (e.project_id IS NULL OR t2.project_id = e.project_id) \
               AND (?4 IS NULL OR t2.project_id = ?4) \
             ORDER BY t2.spent_at ASC, t2.id ASC LIMIT 1) \
         WHERE e.status = 'active' AND e.start_month <= ?3 \
           AND (e.end_month IS NULL OR e.end_month >= ?3) \
           AND (?4 IS NULL OR e.project_id = ?4) \
         ORDER BY e.schedule_day ASC, e.name ASC, e.id ASC",
    )
    .bind(&start)
    .bind(&end)
    .bind(month)
    .bind(project_id)
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    let mut planned: i64 = 0;
    let mut paid: i64 = 0;
    for (
        rule_id,
        name,
        merchant,
        amount_minor,
        currency,
        category,
        schedule_day,
        tx_id,
        spent_at,
    ) in rows
    {
        let due_date = due_date_for_month(month, schedule_day)?;
        let is_paid = tx_id.is_some();
        planned += i64::from(amount_minor);
        if is_paid {
            paid += i64::from(amount_minor);
        }
        out.push(BookkeepingRecurringMonthRow {
            rule_id,
            name,
            merchant,
            amount_minor,
            currency,
            category,
            schedule_day,
            due_date,
            paid: is_paid,
            matched_transaction_id: tx_id,
            matched_spent_at: spent_at,
        });
    }
    let clamp = |v: i64| v.clamp(0, i32::MAX as i64) as i32;
    Ok(BookkeepingRecurringMonthStatus {
        month: month.to_string(),
        rows: out,
        planned_total_minor: clamp(planned),
        paid_total_minor: clamp(paid),
        remaining_total_minor: clamp(planned - paid),
    })
}

#[allow(clippy::result_large_err)]
fn due_date_for_month(month: &str, schedule_day: i32) -> Result<String, AppError> {
    let (year, mon) = validate_month(month)?;
    let last_day = last_day_of_month(year, mon);
    let day = schedule_day.clamp(1, last_day as i32) as u32;
    Ok(format!("{year:04}-{mon:02}-{day:02}"))
}

/// 테스트 픽스처 전용 — 프로덕션 생성 표면은 없다(모듈 doc 참조). mmbak 미러의
/// manual-스코프 방어 테스트가 `source='manual'` 행을 만들 때만 쓴다.
#[cfg(test)]
pub(crate) async fn create_bookkeeping_recurring_expense_inner(
    db: &Db,
    input: crate::models::CreateBookkeepingRecurringExpenseInput,
) -> Result<BookkeepingRecurringExpense, AppError> {
    let name = clean_required(&input.name, "bookkeeping.recurring.name")?;
    let merchant = clean_optional(input.merchant.as_deref());
    let category = clean_required(&input.category, "bookkeeping.category")?;
    let currency = clean_currency_or_default(db, &input.currency).await?;
    validate_month(&input.start_month)?;
    if input.amount_minor <= 0 {
        return Err(AppError::validation(
            "bookkeeping.amount",
            "금액은 0보다 커야 합니다",
        ));
    }
    let insert_sql = format!(
        "INSERT INTO bookkeeping_recurring_expenses \
         (id, project_id, name, merchant, amount_minor, currency, category, payment_method_kind, \
          payment_method_label, payment_method_last4, expense_kind, schedule_day, start_month, \
          end_month, status, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'active', ?14) \
         RETURNING {RECURRING_EXPENSE_RETURNING_COLUMNS}"
    );
    Ok(
        sqlx::query_as::<_, BookkeepingRecurringExpense>(&insert_sql)
            .bind(input.project_id.as_deref())
            .bind(&name)
            .bind(merchant.as_deref())
            .bind(input.amount_minor)
            .bind(&currency)
            .bind(&category)
            .bind(input.payment_method_kind)
            .bind(input.payment_method_label.as_deref())
            .bind(input.payment_method_last4.as_deref())
            .bind(input.expense_kind)
            .bind(input.schedule_day)
            .bind(&input.start_month)
            .bind(input.end_month.as_deref())
            .bind(input.note.as_deref())
            .fetch_one(db)
            .await?,
    )
}
