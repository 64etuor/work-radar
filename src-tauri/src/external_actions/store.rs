//! external_actions 상태머신. 제안자→enqueue(awaiting_approval), 사용자→approve/reject.
//! approve만 Acceptance를 mint하고 커넥터에 dispatch한다(INVARIANT #2).

// ⚠️ 의도적 backward import(external_actions→commands). HumanApproval을 여기 gate 레이어로
// 옮기지 말 것: 발급자가 `pub(in crate::external_actions)`가 되면 gate가 스스로 사람-승인 토큰을
// 위조할 수 있어 wall이 약해진다. 토큰은 사람-IPC(commands)에만 두고, store는 "받아 통과"만 한다.
use crate::commands::approval_grant::HumanApproval;
use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::{audit, Acceptance, ExternalAction, ExternalConnector};
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
/// 반환=새 action id. enqueued 감사 기록. (MCP `wr_propose_noop`가 비-test에서 호출 → 실사용 심볼.)
pub(crate) async fn enqueue(
    pool: &Db,
    action: &ExternalAction,
    project_ref: Option<&str>,
    preview: Option<&str>,
    origin: &str,
) -> Result<String, AppError> {
    enqueue_with_idempotency(pool, action, project_ref, preview, origin, None).await
}

/// enqueue + 멱등 키. `idempotency_key`가 Some이고 동일 키의 **활성**(awaiting_approval|executing)
/// 제안이 이미 있으면 새로 만들지 않고 그 id를 반환한다(중복 pending/이중 승인 방지). 터미널 도달
/// 후 같은 키 재제안은 새 행으로 허용(부분 유니크 인덱스 0042). key=None이면 dedup 없음(기존 동작).
/// Phase 2~5 MCP write 툴의 재시도 안전성을 위한 seam — Phase 1 noop 경로는 None으로 호출한다.
///
/// **호출자 계약:** 키는 제안 *내용*에서 파생한 **안정적**(stable) 값이어야 한다 — 같은 외부 쓰기의
/// 재시도가 같은 키를 내야 dedup이 동작한다. 시도마다 새 UUID를 주면 dedup이 절대 걸리지 않는다.
/// (MCP GitHub write 툴이 비-test에서 호출 → 실사용 심볼.)
pub(crate) async fn enqueue_with_idempotency(
    pool: &Db,
    action: &ExternalAction,
    project_ref: Option<&str>,
    preview: Option<&str>,
    origin: &str,
    idempotency_key: Option<&str>,
) -> Result<String, AppError> {
    let payload = serde_json::to_string(action)
        .map_err(|e| AppError::unexpected("external_action.serialize", e.to_string()))?;

    // dedup + 동시 동일-키 경쟁(부분 유니크 인덱스 0042 위반)을 bounded 루프로 흡수한다. 각 시도:
    // 활성 동일 키가 있으면 그 id 반환(멱등); 없으면 INSERT; 유니크 위반이면 다음 바퀴가
    // (a) 경쟁 승자에 dedup, 또는 (b) 승자가 그새 터미널로 빠졌으면 새 행 INSERT로 해소한다.
    // (이전 구현은 (b)에서 raw 유니크 에러를 노출 — 정당한 재제안인데 불투명 실패였다. #2 수정.)
    const MAX_TRIES: u32 = 3;
    for _ in 0..MAX_TRIES {
        if let Some(key) = idempotency_key {
            if let Some(id) = active_action_for_key(pool, key).await? {
                return Ok(id);
            }
        }
        match insert_external_action(
            pool,
            action,
            &payload,
            project_ref,
            preview,
            origin,
            idempotency_key,
        )
        .await
        {
            Ok(id) => {
                audit::audit(pool, &id, "enqueued", Some(action.kind_str())).await?;
                return Ok(id);
            }
            // 동시 동일-키 경쟁 → 다음 바퀴가 dedup/재삽입으로 해소. key=None이면 위반 불가.
            Err(e) if idempotency_key.is_some() && is_unique_violation(&e) => continue,
            Err(e) => return Err(e.into()),
        }
    }
    // 지속 경쟁(드묾): 마지막으로 활성 키를 한 번 더 확인해 멱등 반환, 아니면 retryable로 노출.
    if let Some(key) = idempotency_key {
        if let Some(id) = active_action_for_key(pool, key).await? {
            return Ok(id);
        }
    }
    Err(AppError::transient(
        "external_action.enqueue_contended",
        "동시 제안 경쟁으로 enqueue를 마치지 못했습니다(재시도 가능)",
    ))
}

/// sqlx 에러가 유니크 제약 위반인지(부분 유니크 인덱스 경쟁 판정).
fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .is_some_and(|d| d.is_unique_violation())
}

/// external_actions 1행 INSERT(상태 awaiting_approval). 유니크 위반은 호출자가 경쟁으로 처리.
async fn insert_external_action(
    pool: &Db,
    action: &ExternalAction,
    payload: &str,
    project_ref: Option<&str>,
    preview: Option<&str>,
    origin: &str,
    idempotency_key: Option<&str>,
) -> Result<String, sqlx::Error> {
    sqlx::query_scalar(
        "INSERT INTO external_actions \
         (id, kind, project_ref, payload, preview, origin, status, idempotency_key) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'awaiting_approval', ?6) \
         RETURNING id",
    )
    .bind(action.kind_str())
    .bind(project_ref)
    .bind(payload)
    .bind(preview)
    .bind(origin)
    .bind(idempotency_key)
    .fetch_one(pool)
    .await
}

/// 활성(awaiting_approval|executing) 동일 idempotency_key 액션 id(있으면). dedup 조회 전용.
async fn active_action_for_key(pool: &Db, key: &str) -> Result<Option<String>, AppError> {
    let id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM external_actions \
         WHERE idempotency_key = ?1 AND status IN ('awaiting_approval', 'executing') \
         LIMIT 1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;
    Ok(id)
}

/// 승인 대기 응답 상한. Phase 2~5 자동 proposer가 늘어도 MCP/FE 단일 응답이 무한히 커지지 않게
/// 막는 안전 상한(사람-게이트 큐는 통상 이보다 작다). FIFO라 상한 초과 시 잘리는 건 **가장 최근 제안**.
const PENDING_LIMIT: i64 = 200;

/// 승인 대기 큐(오래된 것 먼저 = FIFO). payload/result는 노출 안 함(메타만). IPC 표면 backward-compat용
/// 얇은 래퍼 — truncation 신호가 필요한 호출자(MCP 폴링 에이전트)는 `list_pending_with_total`을 쓴다.
pub(crate) async fn list_pending(pool: &Db) -> Result<Vec<PendingAction>, AppError> {
    Ok(list_pending_with_total(pool).await?.0)
}

/// `list_pending` + 전체 대기 건수. 반환=(상한까지의 행, 상한 적용 전 전체 건수). 호출자가
/// `total > rows.len()`로 **truncation을 명시 신호**할 수 있게 한다(#7: LIMIT이 가장 최근 제안을
/// 무신호로 숨기던 문제 — 폴링 에이전트가 "더 있음"을 알 수 있게).
pub(crate) async fn list_pending_with_total(
    pool: &Db,
) -> Result<(Vec<PendingAction>, u32), AppError> {
    let rows = sqlx::query_as::<_, PendingAction>(
        "SELECT id, kind, project_ref, preview, origin, status, created_at \
         FROM external_actions WHERE status = 'awaiting_approval' \
         ORDER BY created_at ASC, id ASC LIMIT ?1",
    )
    .bind(PENDING_LIMIT)
    .fetch_all(pool)
    .await?;
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM external_actions WHERE status = 'awaiting_approval'",
    )
    .fetch_one(pool)
    .await?;
    // 상한 도달 시 PII-free 카운트만 경고 — FIFO라 잘리는 건 가장 최근 제안. 무신호 truncation 방지.
    if total > PENDING_LIMIT {
        tracing::warn!(
            shown = rows.len(),
            total,
            "external_actions pending queue exceeds LIMIT; newest proposals truncated from this response"
        );
    }
    Ok((rows, total as u32))
}

/// 승인: awaiting_approval → executing(CAS 가드) → 커넥터 dispatch → succeeded|failed.
/// **Acceptance는 여기서만 mint** — 커넥터 execute에 전달. 모든 전이를 감사.
/// 반환=실행 결과 status 문자열("succeeded"|"failed"). CAS 실패(이미 결정됨) 시 검증 에러.
///
/// `_grant: &HumanApproval` = 사람 승인 IPC만 발급하는 증거 토큰(type-wall). 제안 생성자
/// 모듈(`crate::mcp` 등)은 토큰을 만들 수 없어 이 함수 호출이 컴파일 불가 — 사람 게이트 우회 봉쇄.
pub(crate) async fn approve<C: ExternalConnector>(
    pool: &Db,
    action_id: &str,
    connector: &C,
    _grant: &HumanApproval,
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
            // **불변(#3/#10): 완료된 외부 mutation은 절대 'failed'로 보고되지 않는다.**
            // ① 상태 플립 *전에* "executed"(external_ref 포함)를 durable하게 감사한다 — 이후 상태
            //    UPDATE가 실패하거나 동시 reaper가 이 행을 건드려도, 감사에 "쓰기 발생"이 남아
            //    reaper가 failed가 아니라 succeeded로 reconcile할 수 있다.
            let detail = match (&outcome.external_ref, outcome.bytes) {
                (Some(r), Some(b)) => format!("ref={r},bytes={b}"),
                (Some(r), None) => format!("ref={r}"),
                (None, Some(b)) => format!("bytes={b}"),
                (None, None) => String::new(),
            };
            audit::audit(pool, action_id, "executed", Some(&detail)).await?;
            // ② 상태-가드 finalize: executing에서만 succeeded로. 0행이면 동시 reaper가 그새 이
            //    행을 뒤집은 것 — 쓰기는 이미 성공했으므로 succeeded를 강제(reconcile)한다.
            let moved = sqlx::query(
                "UPDATE external_actions SET status = 'succeeded', result = ?2 \
                 WHERE id = ?1 AND status = 'executing'",
            )
            .bind(action_id)
            .bind(&result)
            .execute(pool)
            .await?
            .rows_affected();
            if moved == 0 {
                sqlx::query(
                    "UPDATE external_actions SET status = 'succeeded', result = ?2 WHERE id = ?1",
                )
                .bind(action_id)
                .bind(&result)
                .execute(pool)
                .await?;
                audit::audit(
                    pool,
                    action_id,
                    "reconciled",
                    Some("write_succeeded_after_reap"),
                )
                .await?;
            }
            Ok("succeeded".into())
        }
        Err(e) => {
            // 상태-가드 failure: executing에서만 failed로. 0행이면 reaper가 이미 failed로 처리한
            // 것(둘 다 failed에 동의) — 덮어쓰지 않는다(reconcile된 succeeded를 클로버하지 않게).
            sqlx::query(
                "UPDATE external_actions SET status = 'failed' \
                 WHERE id = ?1 AND status = 'executing'",
            )
            .bind(action_id)
            .execute(pool)
            .await?;
            // 실패 사유를 감사에 보존하되 **PII-free**: AppError.code만(예: "github.rate_limited").
            // message/payload 본문은 절대 넣지 않는다(로그 PII 금지 INVARIANT). 실패는 액션
            // 상태로 surface하되 호출 자체는 Ok(상태머신 진행) — IPC 반환 "failed"를 FE가 노출.
            audit::audit(pool, action_id, "failed", Some(&format!("code={}", e.code))).await?;
            Ok("failed".into())
        }
    }
}

/// 거절: awaiting_approval → rejected(CAS). 외부 무변경. 0행이면 가드 에러.
/// `_grant: &HumanApproval` = approve와 동일한 사람-게이트 type-wall(제안 모듈은 호출 불가).
pub(crate) async fn reject(
    pool: &Db,
    action_id: &str,
    _grant: &HumanApproval,
) -> Result<(), AppError> {
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

/// `executing`이 lease(`STALE_EXECUTING_SECS`)보다 오래된 액션만 좀비로 본다. 그보다 최근이면
/// 동시 형제 프로세스(공유 dev DB / 더블런치)의 **genuinely-live** 액션일 수 있어 reaper가 건드리지
/// 않는다(#10). 쓰기는 bounded retry로 초 단위에 끝나므로 이 lease는 매우 여유 있다.
const STALE_EXECUTING_SECS: i64 = 300;

/// 시동 시 crash-orphan 회수. `executing` 좀비를 정리하되 두 가지를 지킨다:
///
/// - **#3 reconcile:** 이미 "executed" 감사가 있는 행은 외부 쓰기가 성공한 것 → `failed`가 아니라
///   `succeeded`로 reconcile한다(완료된 mutation을 절대 실패로 보고하지 않는다는 불변).
/// - **#10 lease 가드:** `decided_at`(없으면 `created_at`)이 lease 안에 있는 행은 동시 형제
///   프로세스의 live 액션일 수 있어 건드리지 않는다(공유 dev DB / 더블런치).
///
/// 나머지(오래된 mid-execution 크래시)만 `failed`. 상태 전이는 모두 `status='executing'` 가드로
/// 동시 finalize와 클로버하지 않는다. 부수효과로 부분 유니크 인덱스(0042)에서 idempotency_key가 풀려
/// 좀비가 키를 영구히 잠그는 일을 막는다. 반환=회수(failed+reconciled)된 액션 수. 외부 호출 0.
pub(crate) async fn recover_interrupted_actions(pool: &Db) -> Result<u64, AppError> {
    recover_interrupted_actions_inner(pool, STALE_EXECUTING_SECS).await
}

/// lease 임계값을 받는 테스트 가능 코어. `stale_secs` 이전에 decided/created된 `executing` 행만 대상.
async fn recover_interrupted_actions_inner(pool: &Db, stale_secs: i64) -> Result<u64, AppError> {
    let threshold = format!("-{} seconds", stale_secs.max(1));
    // lease를 넘긴 stale executing 행 id만 수집(최근 = 형제 live일 수 있어 제외).
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM external_actions \
         WHERE status = 'executing' \
           AND COALESCE(decided_at, created_at) < datetime('now', ?1)",
    )
    .bind(&threshold)
    .fetch_all(pool)
    .await?;

    let mut handled = 0u64;
    for id in &ids {
        // 외부 쓰기가 실제로 끝났는지 = "executed" 감사 유무. 있으면 finalize만 못 박힌 것이니
        // succeeded로 reconcile(완료된 쓰기를 실패로 보고하지 않음). 없으면 진짜 mid-execution 크래시.
        let executed: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM external_action_audit WHERE action_id = ?1 AND event = 'executed' LIMIT 1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        let (target, event, detail) = if executed.is_some() {
            ("succeeded", "reconciled", "write_succeeded_before_crash")
        } else {
            ("failed", "failed", "recovered=app_restart_mid_execution")
        };
        // 상태 전이는 'executing' 가드로 동시 finalize와 클로버하지 않는다 — 0행이면 그새 finalize가
        // 끝낸 것이니 건드리지 않고 감사도 남기지 않는다.
        let moved = sqlx::query(
            "UPDATE external_actions SET status = ?2 WHERE id = ?1 AND status = 'executing'",
        )
        .bind(id)
        .bind(target)
        .execute(pool)
        .await?
        .rows_affected();
        if moved > 0 {
            audit::audit(pool, id, event, Some(detail)).await?;
            handled += 1;
        }
    }
    Ok(handled)
}

/// 단건 상태 폴링(MCP wr_action_status용). 없으면 None.
pub(crate) async fn status(pool: &Db, action_id: &str) -> Result<Option<String>, AppError> {
    let s: Option<String> = sqlx::query_scalar("SELECT status FROM external_actions WHERE id = ?1")
        .bind(action_id)
        .fetch_optional(pool)
        .await?;
    Ok(s)
}

/// 액션의 `project_ref`(=credential_ref) 조회 — 커넥터가 토큰을 **그 프로젝트로만** resolve하기
/// 위해 사용(전역 토큰 금지, 개인/업무 격리). 행/값 없으면 None. `Acceptance::action_id()`로 호출.
/// (라우터가 비-test 빌드에서 호출하므로 dead_code allow 불필요 — 실사용 심볼.)
pub(crate) async fn project_ref_for(
    pool: &Db,
    action_id: &str,
) -> Result<Option<String>, AppError> {
    let r: Option<Option<String>> =
        sqlx::query_scalar("SELECT project_ref FROM external_actions WHERE id = ?1")
            .bind(action_id)
            .fetch_optional(pool)
            .await?;
    Ok(r.flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::approval_grant::HumanApproval;
    use crate::commands::shared::test_support::fresh_db;
    use crate::external_actions::ExecOutcome;

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

    /// 커넥터 실패를 시뮬레이트 — approve의 Err 분기(상태=failed, audit=failed)를 검증.
    struct FailingConnector;
    impl ExternalConnector for FailingConnector {
        async fn execute(
            &self,
            _action: &ExternalAction,
            _gate: &Acceptance,
        ) -> Result<ExecOutcome, AppError> {
            Err(AppError::terminal(
                "external_action.test_fail",
                "커넥터 실패",
            ))
        }
    }

    #[tokio::test]
    async fn enqueue_then_list_pending() {
        let pool = fresh_db().await;
        let action = ExternalAction::Noop {
            note: "hello".into(),
        };
        let id = enqueue(
            &pool,
            &action,
            Some("proj1"),
            Some("noop hello"),
            "mcp:test",
        )
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
        let res = approve(&pool, &id, &conn, &HumanApproval::for_test())
            .await
            .unwrap();
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
        approve(&pool, &id, &conn, &HumanApproval::for_test())
            .await
            .unwrap();
        // 두 번째 승인은 CAS 가드로 거부
        assert!(approve(&pool, &id, &conn, &HumanApproval::for_test())
            .await
            .is_err());
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
        reject(&pool, &id, &HumanApproval::for_test())
            .await
            .unwrap();
        assert_eq!(
            status(&pool, &id).await.unwrap().as_deref(),
            Some("rejected")
        );
        assert!(approve(
            &pool,
            &id,
            &MockConnector {
                outcome: ExecOutcome::default()
            },
            &HumanApproval::for_test()
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn approve_with_failing_connector_marks_failed() {
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
        // 커넥터가 Err를 반환해도 approve 자체는 상태머신을 진행(Ok("failed")).
        let res = approve(&pool, &id, &FailingConnector, &HumanApproval::for_test())
            .await
            .unwrap();
        assert_eq!(res, "failed");
        assert_eq!(status(&pool, &id).await.unwrap().as_deref(), Some("failed"));
        // 실패한 액션은 더 이상 대기 큐에 없음.
        assert!(list_pending(&pool).await.unwrap().is_empty());
        // 감사에 failed 1건 + 실패 사유 code를 PII-free로 보존(message 본문 아님).
        let aud = audit::list_audit_core(&pool).await.unwrap();
        let failed = aud
            .iter()
            .find(|a| a.event == "failed")
            .expect("failed audit entry");
        assert_eq!(
            failed.detail.as_deref(),
            Some("code=external_action.test_fail")
        );
    }

    #[tokio::test]
    async fn recover_interrupted_actions_marks_executing_failed_and_frees_key() {
        let pool = fresh_db().await;
        let action = ExternalAction::Noop { note: "x".into() };
        // 'executing' 좀비를 직접 만든다(크래시 시뮬레이션): enqueue 후 수동으로 executing 전이.
        // decided_at을 lease 밖(과거)으로 백데이트 = 이전 프로세스의 진짜 crash-orphan 모사.
        let id = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k1"))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE external_actions SET status = 'executing', \
             decided_at = datetime('now', '-1 hour') WHERE id = ?1",
        )
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
        // 회수 전: 같은 키는 활성(executing)이라 dedup으로 잠겨 있다.
        assert_eq!(
            active_action_for_key(&pool, "k1").await.unwrap().as_deref(),
            Some(id.as_str())
        );

        let n = recover_interrupted_actions(&pool).await.unwrap();
        assert_eq!(n, 1);
        assert_eq!(status(&pool, &id).await.unwrap().as_deref(), Some("failed"));
        // 회수 후: 키가 풀려 같은 키로 새 제안이 가능(좀비가 키를 영구 잠그지 않음).
        assert_eq!(active_action_for_key(&pool, "k1").await.unwrap(), None);
        let id2 = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k1"))
            .await
            .unwrap();
        assert_ne!(id, id2);
        // 회수가 failed 감사를 남긴다(사유 detail 포함).
        let aud = audit::list_audit_core(&pool).await.unwrap();
        let failed = aud
            .iter()
            .find(|a| a.event == "failed" && a.action_id == id)
            .expect("recovery failed audit");
        assert_eq!(
            failed.detail.as_deref(),
            Some("recovered=app_restart_mid_execution")
        );
    }

    #[tokio::test]
    async fn nonexistent_id_is_guarded() {
        let pool = fresh_db().await;
        let conn = MockConnector {
            outcome: ExecOutcome::default(),
        };
        // approve/reject는 CAS 0행 → 검증 에러. status는 행 없음 → Ok(None).
        assert!(
            approve(&pool, "no-such-id", &conn, &HumanApproval::for_test())
                .await
                .is_err()
        );
        assert!(reject(&pool, "no-such-id", &HumanApproval::for_test())
            .await
            .is_err());
        assert_eq!(status(&pool, "no-such-id").await.unwrap(), None);
    }

    #[tokio::test]
    async fn idempotent_enqueue_dedups_active_proposal() {
        let pool = fresh_db().await;
        let action = ExternalAction::Noop { note: "x".into() };
        let id1 = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k1"))
            .await
            .unwrap();
        // 동일 키 재제안 → 새 행 없이 같은 id 반환(멱등).
        let id2 = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k1"))
            .await
            .unwrap();
        assert_eq!(id1, id2);
        // 대기 큐엔 1건만, enqueued 감사도 1건만(두 번째는 enqueue 안 함).
        assert_eq!(list_pending(&pool).await.unwrap().len(), 1);
        let enqueued = audit::list_audit_core(&pool)
            .await
            .unwrap()
            .into_iter()
            .filter(|a| a.event == "enqueued")
            .count();
        assert_eq!(enqueued, 1);
        // 다른 키는 별도 행.
        let id3 = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k2"))
            .await
            .unwrap();
        assert_ne!(id1, id3);
        assert_eq!(list_pending(&pool).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn idempotency_key_reusable_after_terminal() {
        let pool = fresh_db().await;
        let action = ExternalAction::Noop { note: "x".into() };
        let id1 = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k1"))
            .await
            .unwrap();
        // 거절로 터미널 도달 → 같은 키가 부분 유니크 인덱스에서 빠진다.
        reject(&pool, &id1, &HumanApproval::for_test())
            .await
            .unwrap();
        // 같은 키 재제안은 이제 새 행으로 허용(정당한 재시도 막지 않음).
        let id2 = enqueue_with_idempotency(&pool, &action, None, None, "mcp:t", Some("k1"))
            .await
            .unwrap();
        assert_ne!(id1, id2);
        assert_eq!(
            status(&pool, &id2).await.unwrap().as_deref(),
            Some("awaiting_approval")
        );
    }

    /// 커넥터가 외부 쓰기에 성공했지만, finalize 직전 동시 reaper가 이 행을 'failed'로 뒤집은 상황.
    /// approve는 상태-가드 UPDATE가 0행임을 감지하고 succeeded로 **reconcile**한다 — 완료된 외부
    /// mutation은 절대 failed로 보고되지 않는다(#3/#10 불변).
    struct ReapDuringExecConnector {
        pool: Db,
    }
    impl ExternalConnector for ReapDuringExecConnector {
        async fn execute(
            &self,
            _action: &ExternalAction,
            gate: &Acceptance,
        ) -> Result<ExecOutcome, AppError> {
            // 외부 쓰기는 성공. 그 사이 동시 reaper(형제 프로세스 등)가 이 executing 행을 뒤집음.
            sqlx::query("UPDATE external_actions SET status = 'failed' WHERE id = ?1")
                .bind(gate.action_id())
                .execute(&self.pool)
                .await
                .unwrap();
            Ok(ExecOutcome {
                external_ref: Some("ext/ref/1".into()),
                bytes: Some(3),
            })
        }
    }

    #[tokio::test]
    async fn approve_reconciles_succeeded_when_row_flipped_during_execution() {
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
        let conn = ReapDuringExecConnector { pool: pool.clone() };
        let res = approve(&pool, &id, &conn, &HumanApproval::for_test())
            .await
            .unwrap();
        // 행이 그새 failed로 뒤집혔어도 최종 결과는 succeeded(reconcile).
        assert_eq!(res, "succeeded");
        assert_eq!(
            status(&pool, &id).await.unwrap().as_deref(),
            Some("succeeded")
        );
        // 감사: executed(상태 플립 전) + reconciled 둘 다 존재. failed는 없다.
        let events: Vec<String> = audit::list_audit_core(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.event)
            .collect();
        assert!(events.contains(&"executed".to_string()));
        assert!(events.contains(&"reconciled".to_string()));
        assert!(
            !events.contains(&"failed".to_string()),
            "완료된 외부 쓰기는 failed로 기록되지 않는다"
        );
    }

    #[tokio::test]
    async fn reaper_reconciles_executed_zombie_to_succeeded() {
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
        // executing 좀비 + lease 밖(과거) + 이미 "executed" 감사(외부 쓰기 성공 후 finalize 못 박힘).
        sqlx::query(
            "UPDATE external_actions SET status = 'executing', \
             decided_at = datetime('now', '-1 hour') WHERE id = ?1",
        )
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
        audit::audit(&pool, &id, "executed", Some("ref=ext/1"))
            .await
            .unwrap();

        let n = recover_interrupted_actions(&pool).await.unwrap();
        assert_eq!(n, 1);
        // failed가 아니라 succeeded로 reconcile.
        assert_eq!(
            status(&pool, &id).await.unwrap().as_deref(),
            Some("succeeded")
        );
        let events: Vec<String> = audit::list_audit_core(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.event)
            .collect();
        assert!(events.contains(&"reconciled".to_string()));
        assert!(!events.contains(&"failed".to_string()));
    }

    #[tokio::test]
    async fn reaper_skips_recent_executing_lease_guard() {
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
        // 방금 executing으로 전이(decided_at=now) = 동시 형제 프로세스의 live 액션일 수 있음.
        sqlx::query(
            "UPDATE external_actions SET status = 'executing', \
             decided_at = datetime('now') WHERE id = ?1",
        )
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
        // lease(300s) 안이라 reaper가 건드리지 않는다.
        let n = recover_interrupted_actions(&pool).await.unwrap();
        assert_eq!(n, 0);
        assert_eq!(
            status(&pool, &id).await.unwrap().as_deref(),
            Some("executing")
        );
    }

    #[tokio::test]
    async fn list_pending_with_total_signals_truncation() {
        let pool = fresh_db().await;
        // 상한(200)을 1건 초과 — 전체 201, 반환 행은 200으로 capped, total로 truncation 신호 가능.
        for i in 0..(PENDING_LIMIT + 1) {
            sqlx::query(
                "INSERT INTO external_actions (id, kind, payload, origin, status) \
                 VALUES (lower(hex(randomblob(16))), 'noop', '{}', ?1, 'awaiting_approval')",
            )
            .bind(format!("mcp:bulk:{i}"))
            .execute(&pool)
            .await
            .unwrap();
        }
        let (rows, total) = list_pending_with_total(&pool).await.unwrap();
        assert_eq!(rows.len(), PENDING_LIMIT as usize, "행은 상한까지만");
        assert_eq!(
            total,
            (PENDING_LIMIT + 1) as u32,
            "total은 상한 적용 전 전체"
        );
        assert!(
            total as usize > rows.len(),
            "truncated 신호 = total > 반환 행 수"
        );
    }
}
