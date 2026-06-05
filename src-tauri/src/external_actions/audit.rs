//! external_action_audit: append-only 감사. detail은 비밀-free(service/bytes만).

use crate::db::Db;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ActionAuditEntry {
    pub id: i32, // specta i64 금지 — i32 매핑(레포 관례)
    pub action_id: String,
    pub event: String,
    pub detail: Option<String>,
    pub created_at: String,
}

pub(crate) async fn audit(
    pool: &Db,
    action_id: &str,
    event: &str,
    detail: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query("INSERT INTO external_action_audit (action_id, event, detail) VALUES (?, ?, ?)")
        .bind(action_id)
        .bind(event)
        .bind(detail)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn list_audit_core(pool: &Db) -> Result<Vec<ActionAuditEntry>, AppError> {
    let rows = sqlx::query_as::<_, ActionAuditEntry>(
        "SELECT id, action_id, event, detail, created_at \
         FROM external_action_audit ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn audit_appends_and_lists_newest_first() {
        let pool = fresh_db().await;
        audit(&pool, "act1", "enqueued", Some("service=github"))
            .await
            .unwrap();
        audit(&pool, "act1", "approved", None).await.unwrap();
        let rows = list_audit_core(&pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].event, "approved"); // newest first
        assert_eq!(rows[1].event, "enqueued");
    }
}
