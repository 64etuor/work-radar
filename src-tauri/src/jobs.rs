//! 잡 큐 매니저 (Phase 7). agent_runs(0001)에 영속(INVARIANT #7: SQLite = 잡의 SSOT)하고,
//! 동시성(Semaphore)·timeout·kill switch(CancellationToken)를 강제한다(INVARIANT #5).
//!
//! 생애주기: insert(proposed) → permit 획득 → running → succeeded | failed | cancelled.
//!  - 제네릭 timeout/kill은 여기서 `tokio::select!`로 감싼다(어느 엔진이든 보장; 드롭 시 kill_on_drop).
//!  - 엔진 전용 bound(codex max_turns/cost_cap)는 러너 내부에서 강제(초과 → Err → 여기서 failed 마감).
//!  - 큐 대기 중(proposed) 취소도 지원: permit 획득 전 취소되면 running 없이 cancelled.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentError, AgentOutcome, AgentRunner, Bounds};
use crate::db::Db;
use crate::models::{AgentRail, AgentRunView, AgentStatus, Engine, Sandbox};

/// 새 잡 INSERT 입력. status는 항상 'proposed'(큐 진입)로 시작한다.
pub struct NewAgentRun {
    pub id: String,
    pub project_id: Option<String>,
    pub engine: Engine,
    pub kind: String,
    pub rail: AgentRail,
    pub sandbox: Sandbox,
    pub repo_id: Option<String>,
    pub workdir: Option<String>,
    /// trigger JSON ({ signalId, prUrl, ... }) — 없으면 None.
    pub trigger: Option<String>,
    pub bounds: Bounds,
    pub log_path: String,
}

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

/// result JSON({detail|error})에서 사람이 읽을 상세를 뽑는다.
fn detail_from_result(result: &Option<String>) -> Option<String> {
    let raw = result.as_ref()?;
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("detail")
        .or_else(|| v.get("error"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

impl From<AgentRunRecord> for AgentRunView {
    fn from(r: AgentRunRecord) -> Self {
        let detail = detail_from_result(&r.result);
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
pub async fn insert_agent_run(db: &Db, r: &NewAgentRun) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO agent_runs \
         (id, project_id, engine, kind, rail, trigger, repo_id, workdir, sandbox, status, \
          timeout_sec, max_turns, cost_cap_usd, log_path) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)",
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
    .bind(r.bounds.timeout.as_secs() as i64)
    .bind(r.bounds.max_turns as i64)
    .bind(r.bounds.cost_cap_usd)
    .bind(&r.log_path)
    .execute(db)
    .await?;
    Ok(())
}

/// Jobs 뷰용 — 최근 잡부터 (bounded 100건).
pub async fn fetch_agent_runs(db: &Db) -> Result<Vec<AgentRunView>, sqlx::Error> {
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
pub async fn fetch_log_tail(db: &Db, run_id: &str) -> Result<String, sqlx::Error> {
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

async fn mark_running(db: &Db, run_id: &str) {
    let _ = sqlx::query(
        "UPDATE agent_runs SET status='running', started_at=datetime('now') \
         WHERE id = ? AND status='proposed'",
    )
    .bind(run_id)
    .execute(db)
    .await;
}

/// 종료 전이(succeeded/awaiting_approval/failed/cancelled) + result/cost 영속.
/// `gated`=true(제안 레일 게이트 잡)이고 성공+proposal이 있으면 `succeeded`가 아니라
/// `awaiting_approval`로 멈춘다 — 사람 accept 전엔 어떤 외부 변경도 없다(INVARIANT #2).
async fn finalize(db: &Db, run_id: &str, res: Result<AgentOutcome, AgentError>, gated: bool) {
    let (status, result_json, cost_tokens, cost_usd, proposal): (
        &str,
        String,
        Option<i64>,
        Option<f64>,
        Option<String>,
    ) = match res {
        Ok(o) => (
            if gated && o.proposal.is_some() {
                "awaiting_approval"
            } else {
                "succeeded"
            },
            json!({ "detail": o.detail }).to_string(),
            o.cost_tokens.map(|t| t as i64),
            o.cost_usd,
            o.proposal,
        ),
        Err(AgentError::Cancelled) => (
            "cancelled",
            json!({ "error": AgentError::Cancelled.to_string() }).to_string(),
            None,
            None,
            None,
        ),
        Err(e) => (
            "failed",
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
async fn mark_cancelled_in_queue(db: &Db, run_id: &str) {
    let _ = sqlx::query(
        "UPDATE agent_runs SET status='cancelled', result=?, finished_at=datetime('now') \
         WHERE id = ? AND status='proposed'",
    )
    .bind(json!({ "error": AgentError::Cancelled.to_string() }).to_string())
    .bind(run_id)
    .execute(db)
    .await;
}

/// 잡 큐 매니저 (Tauri managed state). 동시성·kill 레지스트리·codex 경로를 보유한다.
pub struct JobManager {
    /// 동시 실행 한도(Phase 7 = 1). 대기 잡은 proposed로 큐에 머문다.
    sem: Arc<Semaphore>,
    /// 실행/대기 중 잡의 kill 토큰. 종료 시 자기 자신을 제거한다.
    registry: Arc<Mutex<HashMap<String, CancellationToken>>>,
    /// 해석된 codex 바이너리 경로(없으면 자동화 비활성 — graceful degrade).
    pub codex_bin: Option<PathBuf>,
    /// 코드 잡 worktree 생성 루트.
    pub worktree_root: PathBuf,
    /// 잡 로그 디렉터리.
    pub logs_dir: PathBuf,
}

impl JobManager {
    pub fn new(
        codex_bin: Option<PathBuf>,
        worktree_root: PathBuf,
        logs_dir: PathBuf,
        concurrency: usize,
    ) -> Self {
        std::fs::create_dir_all(&worktree_root).ok();
        std::fs::create_dir_all(&logs_dir).ok();
        Self {
            sem: Arc::new(Semaphore::new(concurrency.max(1))),
            registry: Arc::new(Mutex::new(HashMap::new())),
            codex_bin,
            worktree_root,
            logs_dir,
        }
    }

    /// run_id의 로그 파일 경로.
    pub fn log_path(&self, run_id: &str) -> PathBuf {
        self.logs_dir.join(format!("{run_id}.log"))
    }

    /// 잡을 큐에 올리고 백그라운드 태스크로 구동한다(논블로킹). 호출 전 INSERT(proposed) 완료 가정.
    /// 동시성 게이트 → running 전이 → timeout/kill로 감싼 실행 → 종료 전이.
    /// `gated`=true면 성공+proposal 잡이 `awaiting_approval`로 멈춘다(Acceptance 게이트, INVARIANT #2).
    pub fn spawn<R>(&self, db: Db, run_id: String, bounds: Bounds, runner: R, gated: bool)
    where
        R: AgentRunner + 'static,
    {
        let sem = self.sem.clone();
        let registry = self.registry.clone();
        let log_path = self.log_path(&run_id);
        let cancel = CancellationToken::new();
        // 큐 대기 중에도 kill 가능하도록 spawn 전에 등록한다.
        registry
            .lock()
            .unwrap()
            .insert(run_id.clone(), cancel.clone());

        tokio::spawn(async move {
            // 동시성 게이트. 대기 중 취소되면 running 없이 cancelled.
            let _permit = tokio::select! {
                p = sem.acquire_owned() => match p {
                    Ok(p) => p,
                    Err(_) => { registry.lock().unwrap().remove(&run_id); return; }
                },
                _ = cancel.cancelled() => {
                    mark_cancelled_in_queue(&db, &run_id).await;
                    registry.lock().unwrap().remove(&run_id);
                    return;
                }
            };

            mark_running(&db, &run_id).await;

            // 제네릭 bound: timeout/kill을 select!로 강제(드롭 시 kill_on_drop으로 자식 종료).
            let outcome = tokio::select! {
                r = runner.run(bounds, cancel.clone(), log_path.clone()) => r,
                _ = tokio::time::sleep(bounds.timeout) => Err(AgentError::Timeout),
                _ = cancel.cancelled() => Err(AgentError::Cancelled),
            };

            finalize(&db, &run_id, outcome, gated).await;
            registry.lock().unwrap().remove(&run_id);
        });
    }

    /// 잡 kill switch. 실행/대기 중이면 취소 신호를 보낸다(true). 이미 끝났으면 false.
    pub fn kill(&self, run_id: &str) -> bool {
        if let Some(token) = self.registry.lock().unwrap().get(run_id) {
            token.cancel();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::EchoRunner;
    use std::time::Duration;

    /// proposal을 돌려주는 가짜 러너(게이트 검증용 — 실 codex 없이 awaiting_approval 전이 확인).
    struct ProposalRunner {
        proposal: String,
    }
    impl AgentRunner for ProposalRunner {
        fn engine(&self) -> Engine {
            Engine::Codex
        }
        async fn run(
            &self,
            _bounds: Bounds,
            _cancel: CancellationToken,
            log_path: PathBuf,
        ) -> Result<AgentOutcome, AgentError> {
            // 로그 파일은 만들어 둔다(read_agent_log 일관성).
            let _ = tokio::fs::write(&log_path, b"proposal job\n").await;
            Ok(AgentOutcome {
                detail: "proposal ready".into(),
                proposal: Some(self.proposal.clone()),
                ..Default::default()
            })
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("wr-jobs-{tag}-{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    async fn fresh_db() -> Db {
        let dir = temp_dir("db");
        crate::db::init_db(&dir.join("t.db")).await.unwrap()
    }

    fn manager(dir: &std::path::Path) -> JobManager {
        JobManager::new(None, dir.join("wt"), dir.join("logs"), 1)
    }

    async fn insert_echo(db: &Db, jm: &JobManager, id: &str) {
        insert_agent_run(
            db,
            &NewAgentRun {
                id: id.to_string(),
                project_id: None,
                engine: Engine::Codex,
                kind: "echo".into(),
                rail: AgentRail::Suggestion,
                sandbox: Sandbox::ReadOnly,
                repo_id: None,
                workdir: None,
                trigger: None,
                bounds: Bounds {
                    timeout: Duration::from_secs(10),
                    max_turns: 1,
                    cost_cap_usd: 1.0,
                },
                log_path: jm.log_path(id).to_string_lossy().into_owned(),
            },
        )
        .await
        .unwrap();
    }

    /// 잡이 terminal 상태가 될 때까지 폴링(테스트 한정 bounded wait).
    async fn wait_terminal(db: &Db, id: &str, max: Duration) -> String {
        let start = std::time::Instant::now();
        loop {
            let row: (String,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id = ?")
                .bind(id)
                .fetch_one(db)
                .await
                .unwrap();
            if matches!(
                row.0.as_str(),
                "succeeded" | "failed" | "cancelled" | "awaiting_approval"
            ) {
                return row.0;
            }
            if start.elapsed() > max {
                panic!("job {id} did not finish in time (status={})", row.0);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn echo_job_succeeds_and_persists_log() {
        let dir = temp_dir("ok");
        let db = fresh_db().await;
        let jm = manager(&dir);
        insert_echo(&db, &jm, "j1").await;
        jm.spawn(
            db.clone(),
            "j1".into(),
            Bounds {
                timeout: Duration::from_secs(10),
                max_turns: 1,
                cost_cap_usd: 1.0,
            },
            EchoRunner {
                seconds: 0,
                message: "spine-ok".into(),
            },
            false,
        );
        let status = wait_terminal(&db, "j1", Duration::from_secs(8)).await;
        assert_eq!(status, "succeeded");
        let tail = fetch_log_tail(&db, "j1").await.unwrap();
        assert!(tail.contains("spine-ok"), "log tail: {tail:?}");
        // 뷰 도출 + 영속 확인.
        let runs = fetch_agent_runs(&db).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, AgentStatus::Succeeded);
    }

    #[tokio::test]
    async fn echo_job_timeout_kills_and_fails() {
        let dir = temp_dir("to");
        let db = fresh_db().await;
        let jm = manager(&dir);
        insert_echo(&db, &jm, "j2").await;
        // seconds=30이지만 timeout=1s → JobManager가 kill → failed.
        jm.spawn(
            db.clone(),
            "j2".into(),
            Bounds {
                timeout: Duration::from_secs(1),
                max_turns: 1,
                cost_cap_usd: 1.0,
            },
            EchoRunner {
                seconds: 30,
                message: "long".into(),
            },
            false,
        );
        let status = wait_terminal(&db, "j2", Duration::from_secs(8)).await;
        assert_eq!(status, "failed");
        let runs = fetch_agent_runs(&db).await.unwrap();
        let detail = runs[0].detail.clone().unwrap_or_default();
        assert!(detail.contains("timeout"), "detail: {detail}");
    }

    #[tokio::test]
    async fn gated_job_with_proposal_awaits_approval() {
        let dir = temp_dir("gate");
        let db = fresh_db().await;
        let jm = manager(&dir);
        // 게이트 잡으로 INSERT(echo 입력 헬퍼 재사용 — bounds만 동일하면 됨).
        insert_echo(&db, &jm, "g1").await;
        jm.spawn(
            db.clone(),
            "g1".into(),
            Bounds {
                timeout: Duration::from_secs(10),
                max_turns: 8,
                cost_cap_usd: 1.0,
            },
            ProposalRunner {
                proposal: r#"{"summary":"draft"}"#.into(),
            },
            true, // gated → 성공+proposal이면 awaiting_approval로 멈춘다.
        );
        let status = wait_terminal(&db, "g1", Duration::from_secs(8)).await;
        assert_eq!(status, "awaiting_approval");
        // proposal이 영속되고 뷰가 has_proposal로 노출한다.
        let runs = fetch_agent_runs(&db).await.unwrap();
        assert_eq!(runs[0].status, AgentStatus::AwaitingApproval);
        assert!(runs[0].has_proposal);
        let stored: (Option<String>,) =
            sqlx::query_as("SELECT proposal FROM agent_runs WHERE id = 'g1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(stored.0.unwrap().contains("draft"));
    }

    #[tokio::test]
    async fn kill_running_job_marks_cancelled() {
        let dir = temp_dir("kill");
        let db = fresh_db().await;
        let jm = manager(&dir);
        insert_echo(&db, &jm, "j3").await;
        jm.spawn(
            db.clone(),
            "j3".into(),
            Bounds {
                timeout: Duration::from_secs(30),
                max_turns: 1,
                cost_cap_usd: 1.0,
            },
            EchoRunner {
                seconds: 30,
                message: "killme".into(),
            },
            false,
        );
        // 실행 진입까지 잠깐 양보 후 kill.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(jm.kill("j3"), "kill should find the running job");
        let status = wait_terminal(&db, "j3", Duration::from_secs(8)).await;
        assert_eq!(status, "cancelled");
    }
}
