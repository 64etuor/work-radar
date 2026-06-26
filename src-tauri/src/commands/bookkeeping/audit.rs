//! 가계부 감사 로그 조회 + 트랜잭션 내 감사 기록.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::BookkeepingAuditEntry;

#[tauri::command]
#[specta::specta]
pub async fn list_bookkeeping_audit(
    db: State<'_, Db>,
    entity_id: Option<String>,
) -> Result<Vec<BookkeepingAuditEntry>, AppError> {
    list_bookkeeping_audit_inner(db.inner(), entity_id).await
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

pub(crate) async fn insert_audit_log_tx(
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
