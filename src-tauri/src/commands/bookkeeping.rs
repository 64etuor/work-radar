//! Local bookkeeping store + IPC commands.

use tauri::State;

use crate::bookkeeping::{parse_bookkeeping_email_receipt, BookkeepingEmailReceiptInput};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingAuditEntry, BookkeepingCategorySummary, BookkeepingMonthlySummary,
    BookkeepingReviewStatus, BookkeepingSource, BookkeepingSyncJob, BookkeepingTransaction,
    CreateBookkeepingTransactionInput, RecordBookkeepingSyncFailureInput,
};

const DEFAULT_CURRENCY: &str = "KRW";
const MAX_SYNC_ERROR_LEN: usize = 160;

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
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    list_bookkeeping_transactions_inner(db.inner(), status).await
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
pub async fn bookkeeping_monthly_summary(
    db: State<'_, Db>,
    month: String,
) -> Result<BookkeepingMonthlySummary, AppError> {
    bookkeeping_monthly_summary_inner(db.inner(), &month).await
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

    let mut tx = db.begin().await?;
    let created = sqlx::query_as::<_, BookkeepingTransaction>(
        "INSERT INTO bookkeeping_transactions \
         (id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
          spent_at, category, review_status, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'needs_review', ?10) \
         RETURNING id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
           spent_at, category, review_status, note, created_at, updated_at, reviewed_at",
    )
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

    let mut tx = db.begin().await?;
    let row = sqlx::query_as::<_, BookkeepingTransaction>(
        "INSERT INTO bookkeeping_transactions \
         (id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
          spent_at, category, review_status, note) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'needs_review', ?10) \
         ON CONFLICT(source, source_ref) WHERE source_ref IS NOT NULL DO UPDATE SET \
           project_id=excluded.project_id, \
           merchant=excluded.merchant, \
           description=COALESCE(excluded.description, bookkeeping_transactions.description), \
           amount_minor=excluded.amount_minor, \
           currency=excluded.currency, \
           spent_at=excluded.spent_at, \
           category=excluded.category, \
           note=COALESCE(excluded.note, bookkeeping_transactions.note), \
           updated_at=datetime('now') \
         RETURNING id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
           spent_at, category, review_status, note, created_at, updated_at, reviewed_at",
    )
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
                    raw_error_message: format!(
                        "{} {} {} {}",
                        err.code(),
                        input.from,
                        input.snippet,
                        input.body_text
                    ),
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
        },
        "transaction.gmail_ingested",
        "Gmail 영수증이 리뷰큐에 추가됨",
    )
    .await?;
    Ok(Some(row))
}

pub(crate) async fn list_bookkeeping_transactions_inner(
    db: &Db,
    status: Option<BookkeepingReviewStatus>,
) -> Result<Vec<BookkeepingTransaction>, AppError> {
    let rows = sqlx::query_as::<_, BookkeepingTransaction>(
        "SELECT id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
           spent_at, category, review_status, note, created_at, updated_at, reviewed_at \
         FROM bookkeeping_transactions \
         WHERE (?1 IS NULL OR review_status = ?1) \
         ORDER BY spent_at DESC, updated_at DESC, id DESC \
         LIMIT 200",
    )
    .bind(status)
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
    let row = sqlx::query_as::<_, BookkeepingTransaction>(
        "UPDATE bookkeeping_transactions SET \
           review_status=?2, \
           reviewed_at=CASE WHEN ?2='needs_review' THEN NULL ELSE datetime('now') END, \
           updated_at=datetime('now') \
         WHERE id=?1 \
         RETURNING id, project_id, source, source_ref, merchant, description, amount_minor, currency, \
           spent_at, category, review_status, note, created_at, updated_at, reviewed_at",
    )
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

pub(crate) async fn bookkeeping_monthly_summary_inner(
    db: &Db,
    month: &str,
) -> Result<BookkeepingMonthlySummary, AppError> {
    let (start, end) = month_bounds(month)?;
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT category, COALESCE(SUM(amount_minor), 0), COUNT(*) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2 AND review_status != 'ignored' \
         GROUP BY category \
         ORDER BY COALESCE(SUM(amount_minor), 0) DESC, category ASC",
    )
    .bind(&start)
    .bind(&end)
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
    let total_amount_minor = categories
        .iter()
        .map(|c| c.amount_minor as i64)
        .sum::<i64>()
        .min(i32::MAX as i64) as i32;

    let (needs_review, approved, ignored): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN review_status='needs_review' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN review_status='approved' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN review_status='ignored' THEN 1 ELSE 0 END), 0) \
         FROM bookkeeping_transactions \
         WHERE spent_at >= ?1 AND spent_at < ?2",
    )
    .bind(&start)
    .bind(&end)
    .fetch_one(db)
    .await?;

    Ok(BookkeepingMonthlySummary {
        month: month.to_string(),
        total_amount_minor,
        needs_review_count: needs_review.max(0).min(u32::MAX as i64) as u32,
        approved_count: approved.max(0).min(u32::MAX as i64) as u32,
        ignored_count: ignored.max(0).min(u32::MAX as i64) as u32,
        categories,
    })
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
    let message = sanitize_sync_error_message(&input.raw_error_message);
    let mut tx = db.begin().await?;
    let job = sqlx::query_as::<_, BookkeepingSyncJob>(
        "INSERT INTO bookkeeping_sync_jobs \
         (id, source, status, started_at, finished_at, sanitized_error_code, sanitized_error_message) \
         VALUES (lower(hex(randomblob(16))), ?1, 'failed', datetime('now'), datetime('now'), ?2, ?3) \
         RETURNING id, source, status, started_at, finished_at, sanitized_error_code, \
           sanitized_error_message, created_at, updated_at",
    )
    .bind(input.source)
    .bind(&code)
    .bind(&message)
    .fetch_one(&mut *tx)
    .await?;

    insert_audit_log_tx(
        &mut tx,
        "sync_job",
        &job.id,
        "sync.failed",
        "가계부 sync job 실패가 기록됨",
        serde_json::json!({ "source": input.source, "code": code }),
    )
    .await?;
    tx.commit().await?;
    Ok(job)
}

pub(crate) async fn list_bookkeeping_sync_jobs_inner(
    db: &Db,
) -> Result<Vec<BookkeepingSyncJob>, AppError> {
    let rows = sqlx::query_as::<_, BookkeepingSyncJob>(
        "SELECT id, source, status, started_at, finished_at, sanitized_error_code, \
           sanitized_error_message, created_at, updated_at \
         FROM bookkeeping_sync_jobs \
         ORDER BY updated_at DESC, id DESC \
         LIMIT 50",
    )
    .fetch_all(db)
    .await?;
    Ok(rows)
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
fn month_bounds(month: &str) -> Result<(String, String), AppError> {
    if month.len() != 7 || month.as_bytes()[4] != b'-' {
        return Err(AppError::validation(
            "bookkeeping.month",
            "월은 YYYY-MM 형식이어야 합니다",
        ));
    }
    let year: i32 = month[..4]
        .parse()
        .map_err(|_| AppError::validation("bookkeeping.month", "월은 YYYY-MM 형식이어야 합니다"))?;
    let mon: u32 = month[5..7]
        .parse()
        .map_err(|_| AppError::validation("bookkeeping.month", "월은 YYYY-MM 형식이어야 합니다"))?;
    if !(1..=12).contains(&mon) {
        return Err(AppError::validation(
            "bookkeeping.month",
            "월은 01~12 범위여야 합니다",
        ));
    }
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
    use crate::models::{
        BookkeepingReviewStatus, BookkeepingSource, CreateBookkeepingTransactionInput,
        RecordBookkeepingSyncFailureInput,
    };

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

        let summary = bookkeeping_monthly_summary_inner(&db, "2026-06")
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

        let rows = list_bookkeeping_transactions_inner(&db, None)
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
}
