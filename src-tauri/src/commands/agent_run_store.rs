//! agent_runs / acceptances 테이블 데이터 접근 레이어(백로그 F). 모든 agent_runs SQL의 단일 소유자.
//! Approach A: 커맨드·런타임에서 verbatim 이전 — 동작 무변경. jobs.rs는 JobManager 런타임만 보유.

use crate::agent::{AgentError, AgentOutcome};
use crate::db::Db;
use crate::jobs::NewAgentRun;
use crate::models::{AgentRail, AgentRunView, AgentStatus, Engine, Sandbox};
use serde_json::json;

/// agent_runs 한 행(내부). i64 컬럼을 받아 AgentRunView(u32/f64)로 변환한다(specta i64 금지 가드).
#[derive(sqlx::FromRow)]
struct AgentRunRecord {
    id: String,
    project_id: Option<String>,
    engine: Engine,
    kind: String,
    rail: AgentRail,
    sandbox: Sandbox,
    status: AgentStatus,
    timeout_sec: i64,
    max_turns: i64,
    cost_cap_usd: f64,
    cost_tokens: Option<i64>,
    cost_usd: Option<f64>,
    repo_id: Option<String>,
    workdir: Option<String>,
    log_path: Option<String>,
    result: Option<String>,
    trigger: Option<String>,
    proposal: Option<String>,
    created_at: String,
    started_at: Option<String>,
    heartbeat_at: Option<String>,
    recovery_count: i64,
    finished_at: Option<String>,
    acked_at: Option<String>,
}

/// result JSON({detail|error})에서 사람이 읽을 상세를 뽑는다(jobs/agents 공통 — 단일 정의).
pub(crate) fn detail_from_result(result: Option<&str>) -> Option<String> {
    let raw = result?;
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("detail")
        .or_else(|| v.get("error"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

impl From<AgentRunRecord> for AgentRunView {
    fn from(r: AgentRunRecord) -> Self {
        let detail = detail_from_result(r.result.as_deref());
        AgentRunView {
            id: r.id,
            project_id: r.project_id,
            engine: r.engine,
            kind: r.kind,
            rail: r.rail,
            sandbox: r.sandbox,
            status: r.status,
            timeout_sec: r.timeout_sec.max(0) as u32,
            max_turns: r.max_turns.max(0) as u32,
            cost_cap_usd: r.cost_cap_usd,
            cost_tokens: r.cost_tokens.map(|t| t.max(0) as u32),
            cost_usd: r.cost_usd,
            repo_id: r.repo_id,
            workdir: r.workdir,
            log_path: r.log_path,
            detail,
            trigger: r.trigger,
            has_proposal: r.proposal.is_some(),
            created_at: r.created_at,
            started_at: r.started_at,
            heartbeat_at: r.heartbeat_at,
            recovery_count: r.recovery_count.max(0) as u32,
            finished_at: r.finished_at,
            acked_at: r.acked_at,
        }
    }
}

/// 잡을 agent_runs에 'proposed'로 INSERT(큐 진입). 이후 JobManager.spawn이 생애주기를 구동한다.
pub(crate) async fn insert_agent_run(db: &Db, r: &NewAgentRun) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO agent_runs \
         (id, project_id, engine, kind, rail, trigger, repo_id, workdir, sandbox, status, \
          timeout_sec, max_turns, cost_cap_usd, retry_key, retry_count, log_path) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&r.id)
    .bind(&r.project_id)
    .bind(r.engine)
    .bind(&r.kind)
    .bind(r.rail)
    .bind(&r.trigger)
    .bind(&r.repo_id)
    .bind(&r.workdir)
    .bind(r.sandbox)
    .bind(AgentStatus::Proposed)
    .bind(r.bounds.timeout.as_secs() as i64)
    .bind(r.bounds.max_turns as i64)
    .bind(r.bounds.cost_cap_usd)
    .bind(&r.retry_key)
    .bind(r.retry_count as i64)
    .bind(&r.log_path)
    .execute(db)
    .await?;
    Ok(())
}

/// Jobs 뷰용 — 최근 잡부터 (bounded 100건).
pub(crate) async fn fetch_agent_runs(db: &Db) -> Result<Vec<AgentRunView>, sqlx::Error> {
    let rows: Vec<AgentRunRecord> = sqlx::query_as(
        "SELECT id, project_id, engine, kind, rail, sandbox, status, timeout_sec, max_turns, \
         cost_cap_usd, cost_tokens, cost_usd, repo_id, workdir, log_path, result, trigger, proposal, \
         created_at, started_at, heartbeat_at, recovery_count, finished_at, acked_at \
         FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// 사용자가 결과 모달을 닫아 "확인 완료" 마킹. 이미 acked면 그대로 둔다(보존). NULL→datetime.
/// 활성/종료 무관 모든 잡에 허용한다 — 활성 잡은 표시 로직(`isActiveJobStatus`)이 계속 보이게
/// 하다가 finished 전환되는 순간 acked_at이 있으므로 바에서 자동으로 사라진다.
pub(crate) async fn ack_agent_run(db: &Db, run_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE agent_runs SET acked_at = COALESCE(acked_at, datetime('now')) WHERE id = ?1",
    )
    .bind(run_id)
    .execute(db)
    .await?;
    Ok(())
}

/// 잡 로그 tail(최대 16KB). log_path가 없거나 파일이 없으면 빈 문자열.
pub(crate) async fn fetch_log_tail(db: &Db, run_id: &str) -> Result<String, sqlx::Error> {
    let path: Option<(Option<String>,)> =
        sqlx::query_as("SELECT log_path FROM agent_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(db)
            .await?;
    let Some((Some(log_path),)) = path else {
        return Ok(String::new());
    };
    let Ok(bytes) = tokio::fs::read(&log_path).await else {
        return Ok(String::new());
    };
    const MAX: usize = 16 * 1024;
    let start = bytes.len().saturating_sub(MAX);
    Ok(String::from_utf8_lossy(&bytes[start..]).into_owned())
}

pub(crate) async fn mark_running(db: &Db, run_id: &str) {
    let _ = sqlx::query(
        "UPDATE agent_runs SET status=?, started_at=datetime('now'), heartbeat_at=datetime('now') \
         WHERE id = ? AND status=?",
    )
    .bind(AgentStatus::Running)
    .bind(run_id)
    .bind(AgentStatus::Proposed)
    .execute(db)
    .await;
}

pub(crate) async fn heartbeat(db: &Db, run_id: &str) {
    let _ =
        sqlx::query("UPDATE agent_runs SET heartbeat_at=datetime('now') WHERE id=?1 AND status=?2")
            .bind(run_id)
            .bind(AgentStatus::Running)
            .execute(db)
            .await;
}

/// 종료 전이(succeeded/awaiting_approval/failed/cancelled) + result/cost 영속.
/// `gated`=true(제안 레일 게이트 잡)이고 성공+proposal이 있으면 `succeeded`가 아니라
/// `awaiting_approval`로 멈춘다 — 사람 accept 전엔 어떤 외부 변경도 없다(INVARIANT #2).
pub(crate) async fn finalize(
    db: &Db,
    run_id: &str,
    res: Result<AgentOutcome, AgentError>,
    gated: bool,
) {
    let (status, result_json, cost_tokens, cost_usd, proposal): (
        AgentStatus,
        String,
        Option<i64>,
        Option<f64>,
        Option<String>,
    ) = match res {
        Ok(o) => (
            if gated && o.proposal.is_some() {
                AgentStatus::AwaitingApproval
            } else {
                AgentStatus::Succeeded
            },
            json!({ "detail": o.detail }).to_string(),
            o.cost_tokens.map(|t| t as i64),
            o.cost_usd,
            o.proposal,
        ),
        Err(AgentError::Cancelled) => (
            AgentStatus::Cancelled,
            json!({ "error": AgentError::Cancelled.to_string() }).to_string(),
            None,
            None,
            None,
        ),
        Err(e) => (
            AgentStatus::Failed,
            json!({ "error": e.to_string() }).to_string(),
            None,
            None,
            None,
        ),
    };
    let _ = sqlx::query(
        "UPDATE agent_runs SET status=?, result=?, proposal=?, cost_tokens=?, cost_usd=?, \
         finished_at=datetime('now') WHERE id = ?",
    )
    .bind(status)
    .bind(result_json)
    .bind(proposal)
    .bind(cost_tokens)
    .bind(cost_usd)
    .bind(run_id)
    .execute(db)
    .await;
}

/// App-start recovery: no in-memory kill token can exist for jobs left running
/// from a previous app process. Mark them failed with a clear recoverable
/// reason, and cancel queued proposed jobs that cannot be resumed safely.
pub(crate) async fn recover_interrupted_runs(db: &Db) -> Result<u64, sqlx::Error> {
    let running = sqlx::query(
        "UPDATE agent_runs SET status=?1, result=?2, finished_at=datetime('now'), \
         recovery_count=recovery_count+1 \
         WHERE status=?3",
    )
    .bind(AgentStatus::Failed)
    .bind(
        json!({ "error": "App restarted while job was running; marked recoverable failed." })
            .to_string(),
    )
    .bind(AgentStatus::Running)
    .execute(db)
    .await?
    .rows_affected();

    let proposed = sqlx::query(
        "UPDATE agent_runs SET status=?1, result=?2, finished_at=datetime('now'), \
         recovery_count=recovery_count+1 \
         WHERE status=?3",
    )
    .bind(AgentStatus::Cancelled)
    .bind(
        json!({ "error": "App restarted while job was queued; cancelled for consistency." })
            .to_string(),
    )
    .bind(AgentStatus::Proposed)
    .execute(db)
    .await?
    .rows_affected();

    Ok(running + proposed)
}

/// Runtime recovery sweep: running rows whose heartbeat has stopped are no
/// longer recoverable through the in-memory kill registry. Mark them failed so
/// restart-less zombie states do not stay unkillable/undeletable in the UI.
pub(crate) async fn recover_stale_heartbeats(
    db: &Db,
    timeout_seconds: u32,
) -> Result<u64, sqlx::Error> {
    let threshold = format!("-{} seconds", timeout_seconds.max(30));
    let res = sqlx::query(
        "UPDATE agent_runs SET status=?1, result=?2, finished_at=datetime('now'), \
         recovery_count=recovery_count+1 \
         WHERE status=?3 \
           AND COALESCE(heartbeat_at, started_at, created_at) < datetime('now', ?4)",
    )
    .bind(AgentStatus::Failed)
    .bind(
        json!({ "error": "Heartbeat timed out; forced cleanup marked this job recoverable failed." })
            .to_string(),
    )
    .bind(AgentStatus::Running)
    .bind(threshold)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// 큐 대기 중(proposed) 취소 마감.
pub(crate) async fn mark_cancelled_in_queue(db: &Db, run_id: &str) {
    let _ = sqlx::query(
        "UPDATE agent_runs SET status=?, result=?, finished_at=datetime('now') \
         WHERE id = ? AND status=?",
    )
    .bind(AgentStatus::Cancelled)
    .bind(json!({ "error": AgentError::Cancelled.to_string() }).to_string())
    .bind(run_id)
    .bind(AgentStatus::Proposed)
    .execute(db)
    .await;
}

// ── 커맨드 레이어가 위임하는 읽기/게이트 (agents/* 에서 이전) ─────────────────────────

/// 새 잡 id (기존 엔티티와 동일한 hex 형식). agent_runs는 id를 미리 알아야 한다
/// (log_path/worktree 경로 산정 + kill 레지스트리 등록 + 반환).
pub(crate) async fn new_run_id(db: &Db) -> Result<String, String> {
    let id: (String,) = sqlx::query_as("SELECT lower(hex(randomblob(16)))")
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id.0)
}

/// awaiting_approval 잡의 (status, trigger). accept 상태 가드 공유.
pub(crate) async fn run_status_trigger(
    db: &Db,
    run_id: &str,
) -> Result<(AgentStatus, Option<String>), String> {
    let row: Option<(AgentStatus, Option<String>)> =
        sqlx::query_as("SELECT status, trigger FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.ok_or_else(|| "잡을 찾을 수 없음".to_string())
}

/// 잡의 proposal 컬럼 raw 조회. 바깥 Option=행 존재 여부, 안쪽 Option=컬럼 NULL 여부
/// (커맨드가 "잡 없음"과 "아직 산출물 없음"을 구분해 에러 코드를 달리할 수 있도록 구조 보존).
pub(crate) async fn fetch_proposal(
    db: &Db,
    run_id: &str,
) -> Result<Option<Option<String>>, sqlx::Error> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT proposal FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|r| r.0))
}

/// 잡의 proposal JSON 원문. 없으면 Err(잡 없음 / 아직 산출물 없음).
pub(crate) async fn run_proposal_raw(db: &Db, run_id: &str) -> Result<String, String> {
    match fetch_proposal(db, run_id)
        .await
        .map_err(|e| e.to_string())?
    {
        None => Err("잡을 찾을 수 없음".to_string()),
        Some(None) => {
            Err("아직 proposal이 없습니다(잡이 끝나지 않았거나 산출물 없음).".to_string())
        }
        Some(Some(raw)) => Ok(raw),
    }
}

/// 잡의 project_id(없거나 NULL이면 None). batch enrich 검증이 잡 한정 신호를 재조회할 때 쓴다.
pub(crate) async fn fetch_run_project_id(
    db: &Db,
    run_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT project_id FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await?;
    Ok(row.and_then(|r| r.0))
}

/// retry_key 체인의 기존 triage 잡 수(재트리거 캡 판정 입력 — INVARIANT #5).
pub(crate) async fn count_triage_runs(db: &Db, retry_key: &str) -> Result<i64, sqlx::Error> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM agent_runs WHERE retry_key = ?1 AND kind = 'triage_ci'",
    )
    .bind(retry_key)
    .fetch_one(db)
    .await?;
    Ok(row.0)
}

/// 단일 잡 폴링용 (status, result, proposal) 읽기. 커맨드(agent_run_status)가 호출.
pub(crate) async fn fetch_run_status(
    db: &Db,
    run_id: &str,
) -> Result<Option<(AgentStatus, Option<String>, Option<String>)>, sqlx::Error> {
    sqlx::query_as("SELECT status, result, proposal FROM agent_runs WHERE id = ?1")
        .bind(run_id)
        .fetch_optional(db)
        .await
}

/// 공통 accept 마감: append-only acceptances 행 + 잡 succeeded(awaiting_approval에서만 전이).
/// **외부(Notion/GitHub)는 어떤 호출도 없다** — 로컬 기록일 뿐(INVARIANT #2). 특수 로컬 효과는 호출자가.
pub(crate) async fn record_acceptance(
    db: &Db,
    run_id: &str,
    target: &str,
    accepted_json: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO acceptances (id, agent_run_id, accepted_fields, target) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3)",
    )
    .bind(run_id)
    .bind(accepted_json)
    .bind(target)
    .execute(db)
    .await?;
    sqlx::query(
        "UPDATE agent_runs SET status = ?1, finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?2 AND status = ?3",
    )
    .bind(AgentStatus::Succeeded)
    .bind(run_id)
    .bind(AgentStatus::AwaitingApproval)
    .execute(db)
    .await?;
    Ok(())
}

/// Proposal reject: awaiting_approval 잡을 cancelled로 마감(외부 무변경). 영향 행수 반환
/// (0이면 awaiting_approval이 아니라 가드 실패 — 호출자가 검증 에러로 변환).
pub(crate) async fn reject_run(db: &Db, run_id: &str) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE agent_runs SET status = ?1, \
            result = json_object('error', '사용자가 제안을 폐기(reject)함'), \
            finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?2 AND status = ?3",
    )
    .bind(AgentStatus::Cancelled)
    .bind(run_id)
    .bind(AgentStatus::AwaitingApproval)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wr-arstore-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::init_db(&dir.join("t.db")).await.unwrap()
    }

    /// awaiting_approval 한 행을 직접 삽입(픽스처).
    async fn insert_awaiting(db: &Db, id: &str) {
        sqlx::query(
            "INSERT INTO agent_runs \
                (id, engine, kind, rail, sandbox, status, timeout_sec, max_turns, cost_cap_usd) \
             VALUES (?1, 'codex', 'draft_pr_selfcheck', 'suggestion', 'read_only', \
                     'awaiting_approval', 60, 8, 1.0)",
        )
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    }

    /// record_acceptance: awaiting_approval → succeeded + acceptances 1행. 외부 호출 없음(로컬).
    #[tokio::test]
    async fn record_acceptance_marks_succeeded_and_appends_row() {
        let db = fresh_db().await;
        insert_awaiting(&db, "r1").await;
        record_acceptance(&db, "r1", "pr_self_check", r#"{"summary":"x"}"#)
            .await
            .unwrap();
        let st: (AgentStatus,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, AgentStatus::Succeeded);
        let cnt: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM acceptances WHERE agent_run_id='r1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(cnt.0, 1);
    }

    /// record_acceptance는 awaiting_approval이 아니면 상태를 바꾸지 않는다(게이트 CAS — INVARIANT #2).
    #[tokio::test]
    async fn record_acceptance_no_op_when_not_awaiting() {
        let db = fresh_db().await;
        // proposed 상태로 삽입(status 컬럼 default).
        sqlx::query(
            "INSERT INTO agent_runs (id, engine, kind, rail, sandbox, timeout_sec, max_turns, cost_cap_usd) \
             VALUES ('r2','codex','k','suggestion','read_only',60,8,1.0)",
        )
        .execute(&db)
        .await
        .unwrap();
        record_acceptance(&db, "r2", "pr_self_check", "{}")
            .await
            .unwrap();
        let st: (AgentStatus,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r2'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            st.0,
            AgentStatus::Proposed,
            "게이트: awaiting_approval만 succeeded로 전이"
        );
    }

    /// reject_run: awaiting_approval → cancelled, 영향 행수 1. 비-awaiting이면 0(가드).
    #[tokio::test]
    async fn reject_run_cancels_only_awaiting() {
        let db = fresh_db().await;
        insert_awaiting(&db, "r3").await;
        let n = reject_run(&db, "r3").await.unwrap();
        assert_eq!(n, 1);
        let st: (AgentStatus,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r3'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, AgentStatus::Cancelled);
        // 두 번째 reject은 0행(이미 cancelled).
        let n2 = reject_run(&db, "r3").await.unwrap();
        assert_eq!(n2, 0);
    }

    #[tokio::test]
    async fn recover_interrupted_runs_marks_active_states_terminal() {
        let db = fresh_db().await;
        sqlx::query(
            "INSERT INTO agent_runs (id, engine, kind, rail, sandbox, status, timeout_sec, max_turns, cost_cap_usd) \
             VALUES \
             ('running1','codex','k','suggestion','read_only','running',60,8,1.0), \
             ('queued1','codex','k','suggestion','read_only','proposed',60,8,1.0), \
             ('done1','codex','k','suggestion','read_only','succeeded',60,8,1.0)",
        )
        .execute(&db)
        .await
        .unwrap();

        let n = recover_interrupted_runs(&db).await.unwrap();
        assert_eq!(n, 2);

        let rows: Vec<(String, AgentStatus, i64)> =
            sqlx::query_as("SELECT id, status, recovery_count FROM agent_runs ORDER BY id")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec![
                ("done1".to_string(), AgentStatus::Succeeded, 0),
                ("queued1".to_string(), AgentStatus::Cancelled, 1),
                ("running1".to_string(), AgentStatus::Failed, 1),
            ]
        );
    }
}
