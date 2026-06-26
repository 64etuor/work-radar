//! 가계부 외부 동기화 job/cursor 기록·조회 + 에러 메시지 새니타이즈.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    BookkeepingSource, BookkeepingSyncCursor, BookkeepingSyncJob, RecordBookkeepingSyncFailureInput,
};

use super::*;

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

pub(crate) async fn upsert_bookkeeping_sync_cursor_inner(
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

pub(crate) async fn bookkeeping_source_ref_exists(
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

pub(crate) async fn record_bookkeeping_sync_status_inner(
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
pub(crate) async fn record_bookkeeping_sync_job_inner(
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
