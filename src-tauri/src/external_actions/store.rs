//! external_actions 상태머신. 제안자→enqueue(awaiting_approval), 사용자→approve/reject.
//! approve만 Acceptance를 mint하고 커넥터에 dispatch한다(INVARIANT #2).

use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::{audit, Acceptance, ExternalAction};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub id: String,
    pub kind: String,
    pub project_ref: Option<String>,
    pub preview: Option<String>,
    pub origin: String,
    pub status: String,
    pub created_at: String,
}

/// 제안 1건을 awaiting_approval로 enqueue. payload는 검증된 JSON 문자열(호출자 책임).
/// 반환=새 action id. enqueued 감사 기록.
// Phase 0는 IPC로 노출하지 않는다(제안자는 Phase 1 MCP 서버). 테스트에선 사용 → not(test) dead_code 허용.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn enqueue(
    pool: &Db,
    action: &ExternalAction,
    project_ref: Option<&str>,
    preview: Option<&str>,
    origin: &str,
) -> Result<String, AppError> {
    let payload = serde_json::to_string(action)
        .map_err(|e| AppError::unexpected("external_action.serialize", e.to_string()))?;
    let id: String = sqlx::query_scalar(
        "INSERT INTO external_actions (id, kind, project_ref, payload, preview, origin, status) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'awaiting_approval') \
         RETURNING id",
    )
    .bind(action.kind_str())
    .bind(project_ref)
    .bind(payload)
    .bind(preview)
    .bind(origin)
    .fetch_one(pool)
    .await?;
    audit::audit(pool, &id, "enqueued", Some(action.kind_str())).await?;
    Ok(id)
}

/// 승인 대기 큐(오래된 것 먼저 = FIFO). payload/result는 노출 안 함(메타만).
pub(crate) async fn list_pending(pool: &Db) -> Result<Vec<PendingAction>, AppError> {
    let rows = sqlx::query_as::<_, PendingAction>(
        "SELECT id, kind, project_ref, preview, origin, status, created_at \
         FROM external_actions WHERE status = 'awaiting_approval' ORDER BY created_at ASC, id ASC",
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
    async fn enqueue_then_list_pending() {
        let pool = fresh_db().await;
        let action = ExternalAction::Noop {
            note: "hello".into(),
        };
        let id = enqueue(&pool, &action, Some("proj1"), Some("noop hello"), "mcp:test")
            .await
            .unwrap();
        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].kind, "noop");
        assert_eq!(pending[0].origin, "mcp:test");
        // 감사에 enqueued 1건
        let aud = audit::list_audit_core(&pool).await.unwrap();
        assert_eq!(aud.len(), 1);
        assert_eq!(aud[0].event, "enqueued");
    }
}
