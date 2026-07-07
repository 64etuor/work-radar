//! 가계부 예산 설정/조회/삭제 + 집행률·롤오버 상태 계산.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingBudget, BookkeepingBudgetPlanRow, BookkeepingBudgetStatus, SetBookkeepingBudgetInput,
};

use super::*;

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

/// 예산 탭 데이터 — 상위 카테고리별 한도(미설정 포함)·집행·롤오버를 서버에서 합쳐 반환.
#[tauri::command]
#[specta::specta]
pub async fn bookkeeping_budget_planner(
    db: State<'_, Db>,
    month: String,
    project_id: Option<String>,
) -> Result<Vec<BookkeepingBudgetPlanRow>, AppError> {
    bookkeeping_budget_planner_inner(db.inner(), &month, project_id.as_deref()).await
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
        ensure_project_exists(db, project_id, "bookkeeping.budget.project_not_found").await?;
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

pub(crate) async fn bookkeeping_budget_planner_inner(
    db: &Db,
    month: &str,
    project_id: Option<&str>,
) -> Result<Vec<BookkeepingBudgetPlanRow>, AppError> {
    validate_month(month)?;
    let project_id = clean_optional(project_id);

    let (current_month_start, current_month_end) = month_bounds(month)?;
    // 상위 카테고리 그룹 지출 — 예산 매칭(`spent_for_budget_category`)과 동일하게
    // COALESCE(category_code, category)로 버킷한다.
    let current = grouped_expense_by_category(
        db,
        &current_month_start,
        &current_month_end,
        project_id.as_deref(),
    )
    .await?;

    // 행 집합 = (당월 예산 있는 카테고리) ∪ (당월 지출).
    let budgets = list_bookkeeping_budgets_inner(db, month, project_id.as_deref()).await?;
    let mut codes: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    codes.extend(current.iter().map(|(code, _)| code.clone()));
    codes.extend(budgets.iter().map(|b| b.category_code.clone()));

    let current_map: std::collections::HashMap<&str, i64> =
        current.iter().map(|(c, v)| (c.as_str(), *v)).collect();
    let budget_map: std::collections::HashMap<&str, &BookkeepingBudget> = budgets
        .iter()
        .map(|b| (b.category_code.as_str(), b))
        .collect();

    let mut rows = Vec::with_capacity(codes.len());
    for code in codes {
        let budget = budget_map.get(code.as_str()).copied();
        let spent = current_map
            .get(code.as_str())
            .copied()
            .unwrap_or(0)
            .max(0)
            .min(i32::MAX as i64) as i32;

        let (has_budget, budget_id, limit_minor, rollover, rollover_in, remaining, pct, currency) =
            if let Some(budget) = budget {
                let rollover_in = if budget.rollover {
                    rollover_in_for_budget(db, &budget.month, project_id.as_deref(), &code).await?
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
                (
                    true,
                    Some(budget.id.clone()),
                    Some(budget.limit_minor),
                    budget.rollover,
                    rollover_in,
                    remaining,
                    pct,
                    budget.currency.clone(),
                )
            } else {
                // 예산 미설정 — 잔여/집행률은 의미 없으므로 0.
                (
                    false,
                    None,
                    None,
                    false,
                    0,
                    0,
                    0.0,
                    DEFAULT_CURRENCY.to_string(),
                )
            };

        let label = category_label(db, &code).await?;
        rows.push(BookkeepingBudgetPlanRow {
            category_code: code,
            label,
            has_budget,
            budget_id,
            limit_minor,
            rollover,
            spent_minor: spent,
            rollover_in_minor: rollover_in,
            remaining_minor: remaining,
            pct,
            currency,
        });
    }

    // 미설정(지출만)보다 설정된 예산을 위로, 그 안에서 집행률 높은 순 → 코드 순.
    rows.sort_by(|a, b| {
        b.has_budget
            .cmp(&a.has_budget)
            .then_with(|| {
                b.pct
                    .partial_cmp(&a.pct)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| b.spent_minor.cmp(&a.spent_minor))
            .then_with(|| a.category_code.cmp(&b.category_code))
    });
    Ok(rows)
}

/// 상위 카테고리 버킷별 지출 합 — expense·비ignored·비deleted, [start, end) 범위.
/// 반환 순서는 무의미(호출부가 map/set으로 소비).
async fn grouped_expense_by_category(
    db: &Db,
    start: &str,
    end: &str,
    project_id: Option<&str>,
) -> Result<Vec<(String, i64)>, AppError> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT COALESCE(category_code, category) AS code, COALESCE(SUM(amount_minor), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 \
           AND review_status != 'ignored' \
           AND direction = 'expense' \
           AND deleted_at IS NULL \
           AND (?3 IS NULL OR project_id = ?3) \
         GROUP BY code",
    )
    .bind(start)
    .bind(end)
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(rows)
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

pub(crate) async fn category_label(db: &Db, category_code: &str) -> Result<String, AppError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT label FROM bookkeeping_category_taxonomy WHERE code = ?1")
            .bind(category_code)
            .fetch_optional(db)
            .await?;
    Ok(row
        .map(|(label,)| label)
        .unwrap_or_else(|| category_code.to_string()))
}
