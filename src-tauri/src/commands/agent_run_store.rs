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
    finished_at: Option<String>,
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
            finished_at: r.finished_at,
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
         created_at, started_at, finished_at \
         FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT 100",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
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
        "UPDATE agent_runs SET status=?, started_at=datetime('now') \
         WHERE id = ? AND status=?",
    )
    .bind(AgentStatus::Running)
    .bind(run_id)
    .bind(AgentStatus::Proposed)
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

/// 잡의 proposal JSON 원문. 없으면 Err(아직 산출물 없음).
pub(crate) async fn run_proposal_raw(db: &Db, run_id: &str) -> Result<String, String> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT proposal FROM agent_runs WHERE id = ?1")
            .bind(run_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.ok_or("잡을 찾을 수 없음")?
        .0
        .ok_or_else(|| "아직 proposal이 없습니다(잡이 끝나지 않았거나 산출물 없음).".to_string())
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
