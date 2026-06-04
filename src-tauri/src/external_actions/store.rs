//! external_actions 상태머신. 제안자→enqueue(awaiting_approval), 사용자→approve/reject.
//! approve만 Acceptance를 mint하고 커넥터에 dispatch한다(INVARIANT #2).

use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::{audit, Acceptance, ExecOutcome, ExternalAction, ExternalConnector};
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

/// 승인: awaiting_approval → executing(CAS 가드) → 커넥터 dispatch → succeeded|failed.
/// **Acceptance는 여기서만 mint** — 커넥터 execute에 전달. 모든 전이를 감사.
/// 반환=실행 결과 status 문자열("succeeded"|"failed"). CAS 실패(이미 결정됨) 시 검증 에러.
pub(crate) async fn approve<C: ExternalConnector>(
    pool: &Db,
    action_id: &str,
    connector: &C,
) -> Result<String, AppError> {
    // CAS: awaiting_approval에서만 executing으로. 0행이면 이미 결정된 액션 → 가드.
    let moved = sqlx::query(
        "UPDATE external_actions SET status = 'executing', decided_at = datetime('now') \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(action_id)
    .execute(pool)
    .await?
    .rows_affected();
    if moved == 0 {
        return Err(AppError::validation(
            "external_action.not_pending",
            "승인 대기 상태가 아닌 액션입니다",
        ));
    }
    audit::audit(pool, action_id, "approved", None).await?;

    // payload 역직렬화 → 커넥터 실행(여기서 Acceptance mint).
    let payload: String = sqlx::query_scalar("SELECT payload FROM external_actions WHERE id = ?1")
        .bind(action_id)
        .fetch_one(pool)
        .await?;
    let action: ExternalAction = serde_json::from_str(&payload)
        .map_err(|e| AppError::unexpected("external_action.deserialize", e.to_string()))?;
    let gate = Acceptance::mint(action_id.to_string());

    match connector.execute(&action, &gate).await {
        Ok(outcome) => {
            let result = serde_json::to_string(&outcome).ok();
            sqlx::query(
                "UPDATE external_actions SET status = 'succeeded', result = ?2 WHERE id = ?1",
            )
            .bind(action_id)
            .bind(result)
            .execute(pool)
            .await?;
            let detail = outcome
                .bytes
                .map(|b| format!("bytes={b}"))
                .unwrap_or_default();
            audit::audit(pool, action_id, "executed", Some(&detail)).await?;
            Ok("succeeded".into())
        }
        Err(e) => {
            sqlx::query("UPDATE external_actions SET status = 'failed' WHERE id = ?1")
                .bind(action_id)
                .execute(pool)
                .await?;
            audit::audit(pool, action_id, "failed", None).await?;
            // 실패는 액션 상태로 surface하되 호출 자체는 Ok(상태머신 진행). 에러는 audit로.
            let _ = e;
            Ok("failed".into())
        }
    }
}

/// 거절: awaiting_approval → rejected(CAS). 외부 무변경. 0행이면 가드 에러.
pub(crate) async fn reject(pool: &Db, action_id: &str) -> Result<(), AppError> {
    let moved = sqlx::query(
        "UPDATE external_actions SET status = 'rejected', decided_at = datetime('now') \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(action_id)
    .execute(pool)
    .await?
    .rows_affected();
    if moved == 0 {
        return Err(AppError::validation(
            "external_action.not_pending",
            "승인 대기 상태가 아닌 액션입니다",
        ));
    }
    audit::audit(pool, action_id, "rejected", None).await?;
    Ok(())
}

/// 단건 상태 폴링(MCP wr_action_status용). 없으면 None.
pub(crate) async fn status(pool: &Db, action_id: &str) -> Result<Option<String>, AppError> {
    let s: Option<String> = sqlx::query_scalar("SELECT status FROM external_actions WHERE id = ?1")
        .bind(action_id)
        .fetch_optional(pool)
        .await?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    struct MockConnector {
        outcome: ExecOutcome,
    }
    impl ExternalConnector for MockConnector {
        async fn execute(
            &self,
            _action: &ExternalAction,
            _gate: &Acceptance,
        ) -> Result<ExecOutcome, AppError> {
            Ok(self.outcome.clone())
        }
    }

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

    #[tokio::test]
    async fn approve_dispatches_and_records_audit() {
        let pool = fresh_db().await;
        let id = enqueue(
            &pool,
            &ExternalAction::Noop { note: "x".into() },
            None,
            None,
            "mcp:t",
        )
        .await
        .unwrap();
        let conn = MockConnector {
            outcome: ExecOutcome {
                external_ref: Some("pr/1".into()),
                bytes: Some(12),
            },
        };
        let res = approve(&pool, &id, &conn).await.unwrap();
        assert_eq!(res, "succeeded");
        assert_eq!(
            status(&pool, &id).await.unwrap().as_deref(),
            Some("succeeded")
        );
        // 더 이상 대기 큐에 없음
        assert!(list_pending(&pool).await.unwrap().is_empty());
        // 감사: enqueued, approved, executed
        let events: Vec<String> = audit::list_audit_core(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.event)
            .collect();
        assert!(events.contains(&"executed".to_string()));
        assert!(events.contains(&"approved".to_string()));
    }

    #[tokio::test]
    async fn double_approve_is_guarded() {
        let pool = fresh_db().await;
        let id = enqueue(
            &pool,
            &ExternalAction::Noop { note: "x".into() },
            None,
            None,
            "mcp:t",
        )
        .await
        .unwrap();
        let conn = MockConnector {
            outcome: ExecOutcome::default(),
        };
        approve(&pool, &id, &conn).await.unwrap();
        // 두 번째 승인은 CAS 가드로 거부
        assert!(approve(&pool, &id, &conn).await.is_err());
    }

    #[tokio::test]
    async fn reject_marks_rejected_no_dispatch() {
        let pool = fresh_db().await;
        let id = enqueue(
            &pool,
            &ExternalAction::Noop { note: "x".into() },
            None,
            None,
            "mcp:t",
        )
        .await
        .unwrap();
        reject(&pool, &id).await.unwrap();
        assert_eq!(
            status(&pool, &id).await.unwrap().as_deref(),
            Some("rejected")
        );
        assert!(approve(
            &pool,
            &id,
            &MockConnector {
                outcome: ExecOutcome::default()
            }
        )
        .await
        .is_err());
    }
}
