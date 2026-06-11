//! Per-project Control Room snapshot. Runs the bounded, read-only `boule snapshot
//! --repo <path> --json` CLI over a DB-resolved local repo path and parses its JSON
//! into [`ControlRoomSnapshot`]. The repo path is ALWAYS resolved from the DB (never
//! renderer-supplied — INVARIANT, plan §6) and the CLI never writes governance events
//! (INVARIANT #1, structural).
#![allow(clippy::result_large_err)]

use crate::db::Db;
use crate::error::AppError;
use crate::governance::snapshot::{parse_control_room_snapshot, ControlRoomSnapshot, CoveredRepo};
use crate::governance::ticker::{
    resolve_boule_cli_entrypoint, resolve_node_bin, resolve_project_repo_row,
};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

/// Bounded ceiling for one read-only snapshot fold. The CLI is a one-shot read; this only
/// guards against a hung child (no unbounded wait — plan §6 "no unbounded timer").
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(30);

/// Runs `boule snapshot` for a repo and returns its stdout (the snapshot JSON). Abstracted
/// so the orchestration is unit-testable without spawning a real `node` process.
#[async_trait]
pub trait SnapshotCommandRunner: Send + Sync {
    /// `live` mirrors the project's ticker LIVE opt-in so the snapshot's readiness verdict
    /// matches what a real tick would gate on (dashboard == tick verdict invariant).
    async fn run_snapshot_command(&self, repo_path: &Path, live: bool) -> Result<String, AppError>;
}

/// Real runner: spawns `node --experimental-strip-types <boule.ts> snapshot --repo <p> --json`.
pub struct RealSnapshotCommandRunner {
    node_bin: PathBuf,
    cli_entrypoint: PathBuf,
}

impl RealSnapshotCommandRunner {
    pub async fn resolve() -> Result<Self, AppError> {
        let node_bin = resolve_node_bin().await.ok_or_else(|| {
            AppError::terminal("governance.node_not_found", "node binary not found")
        })?;
        let cli_entrypoint = resolve_boule_cli_entrypoint().ok_or_else(|| {
            AppError::terminal(
                "governance.boule_cli_not_found",
                "boule CLI entrypoint not found; set BOULE_CLI_ENTRYPOINT or WORK_RADAR_GOVERNANCE_DIR",
            )
        })?;
        Ok(Self {
            node_bin,
            cli_entrypoint,
        })
    }
}

#[async_trait]
impl SnapshotCommandRunner for RealSnapshotCommandRunner {
    async fn run_snapshot_command(&self, repo_path: &Path, live: bool) -> Result<String, AppError> {
        let mut command = Command::new(&self.node_bin);
        command
            .arg("--experimental-strip-types")
            .arg(&self.cli_entrypoint)
            .arg("snapshot")
            .arg("--repo")
            .arg(repo_path)
            .arg("--json");
        // Same per-project LIVE injection as the tick runner — the Control Room readiness
        // strip must show the verdict a real tick would compute. live=false does not unset
        // any operator shell env (global CLI fallback wins there).
        if live {
            command
                .env("BOULE_CONDUCTOR_MODE", "live")
                .env("BOULE_OBSERVER_MODE", "live");
        }
        let child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output();
        let output = tokio::time::timeout(SNAPSHOT_TIMEOUT, child)
            .await
            .map_err(|_| {
                AppError::terminal("governance.snapshot_timeout", "boule snapshot timed out")
            })?
            .map_err(|e| AppError::terminal("governance.snapshot_spawn_failed", e.to_string()))?;
        if !output.status.success() {
            // Bounded diagnostic: exit code + a truncated stderr tail (the CLI's own
            // message; never an external network body).
            let stderr = String::from_utf8_lossy(&output.stderr);
            let tail: String = stderr.trim().chars().take(300).collect();
            return Err(AppError::terminal(
                "governance.snapshot_failed",
                format!("exit {}: {tail}", output.status.code().unwrap_or(-1)),
            ));
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

/// Default production runner: resolves the real `node`/CLI per call (cheap; mirrors ticker).
struct SystemSnapshotCommandRunner;

#[async_trait]
impl SnapshotCommandRunner for SystemSnapshotCommandRunner {
    async fn run_snapshot_command(&self, repo_path: &Path, live: bool) -> Result<String, AppError> {
        RealSnapshotCommandRunner::resolve()
            .await?
            .run_snapshot_command(repo_path, live)
            .await
    }
}

/// Fold a project's `.boule/workspace` events into a live Control Room snapshot.
pub async fn get_project_control_room_snapshot(
    db: &Db,
    project_id: &str,
) -> Result<ControlRoomSnapshot, AppError> {
    get_project_control_room_snapshot_with_runner(db, project_id, SystemSnapshotCommandRunner).await
}

pub async fn get_project_control_room_snapshot_with_runner<R: SnapshotCommandRunner>(
    db: &Db,
    project_id: &str,
    runner: R,
) -> Result<ControlRoomSnapshot, AppError> {
    // A project with no enabled local repo (e.g. a Notion-only / GitHub-only project) simply
    // has no `.boule/workspace` to fold — that is an EMPTY snapshot, not an error. Surfacing a
    // raw `ticker.repo_not_found` here would re-introduce the broken-on-live failure T4b fixes
    // (plan §6). Unknown-project and any other error still propagate.
    let repo = match resolve_project_repo_row(db, project_id).await {
        Ok(row) => row,
        Err(err) if err.code == "ticker.repo_not_found" => {
            return Ok(ControlRoomSnapshot::default())
        }
        Err(err) => return Err(err),
    };
    let live = crate::governance::ticker::current_live_enabled(db, project_id).await?;
    let stdout = runner
        .run_snapshot_command(Path::new(&repo.local_path), live)
        .await?;
    let mut snap = parse_control_room_snapshot(&stdout)?;
    snap.covered_repo = Some(resolve_covered_repo(db, project_id, repo).await?);
    Ok(snap)
}

/// 멀티레포 프로젝트 coverage 표시 — 접힌 레포의 식별 + 프로젝트의 enabled 로컬 레포 총수.
async fn resolve_covered_repo(
    db: &Db,
    project_id: &str,
    repo: crate::governance::ticker::ProjectRepoRow,
) -> Result<CoveredRepo, AppError> {
    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM repos \
         WHERE project_id = ?1 AND provider = 'local' AND enabled = 1 \
           AND local_path IS NOT NULL AND local_path != ''",
    )
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let name = Path::new(&repo.local_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo.local_path.clone());
    Ok(CoveredRepo {
        repo_id: repo.id,
        name,
        local_path: repo.local_path,
        enabled_local_total: total.max(1) as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("work-radar-control-room-test-{nanos}-{seq}.db"))
    }

    async fn test_db() -> Db {
        init_db(&temp_db_path()).await.expect("init test db")
    }

    async fn seed_project(db: &Db, project_id: &str) {
        sqlx::query(
            "INSERT INTO projects (id, name, kind, credential_ref) VALUES (?1, 'CR', 'personal', 'cred')",
        )
        .bind(project_id)
        .execute(db)
        .await
        .expect("seed project");
    }

    async fn seed_local_repo(db: &Db, project_id: &str, repo_id: &str, path: &str) {
        sqlx::query(
            "INSERT INTO repos (id, project_id, provider, local_path, default_branch, enabled) \
             VALUES (?1, ?2, 'local', ?3, 'main', 1)",
        )
        .bind(repo_id)
        .bind(project_id)
        .bind(path)
        .execute(db)
        .await
        .expect("seed repo");
    }

    struct FakeRunner {
        calls: Arc<Mutex<Vec<(PathBuf, bool)>>>,
        result: Result<String, AppError>,
    }

    impl FakeRunner {
        fn ok(stdout: &str) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                result: Ok(stdout.to_string()),
            }
        }

        fn err(code: &str) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                result: Err(AppError::terminal(code, "boom")),
            }
        }
    }

    #[async_trait]
    impl SnapshotCommandRunner for FakeRunner {
        async fn run_snapshot_command(
            &self,
            repo_path: &Path,
            live: bool,
        ) -> Result<String, AppError> {
            self.calls
                .lock()
                .expect("calls lock")
                .push((repo_path.to_path_buf(), live));
            self.result.clone()
        }
    }

    const VALID_SNAPSHOT: &str = r#"{"generatedAt":"2026-06-09T00:00:00Z","tasks":[{"taskId":"t1","title":"T","phase":"active"}],"plans":[],"specs":[],"sessions":[],"handoffs":[],"orchestrator":{"tasks":[],"plans":[],"sessions":[]}}"#;

    #[tokio::test]
    async fn folds_resolved_repo_path_into_snapshot() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/repo-under-test").await;
        let runner = FakeRunner::ok(VALID_SNAPSHOT);

        let snap = get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .expect("snapshot");

        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.generated_at.as_deref(), Some("2026-06-09T00:00:00Z"));
        // coverage 식별: 접힌 레포의 id/이름(경로 마지막 세그먼트)/총수.
        let covered = snap.covered_repo.expect("covered repo populated");
        assert_eq!(covered.repo_id, "r1");
        assert_eq!(covered.name, "repo-under-test");
        assert_eq!(covered.local_path, "/tmp/repo-under-test");
        assert_eq!(covered.enabled_local_total, 1);
    }

    /// 멀티레포 프로젝트: 첫 enabled 로컬 레포(created_at, id 순)만 접고, 총수로 형제 존재를 알린다.
    #[tokio::test]
    async fn multi_repo_project_covers_first_repo_and_reports_total() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/first-repo").await;
        seed_local_repo(&db, "p1", "r2", "/tmp/second-repo").await;
        let runner = FakeRunner::ok(VALID_SNAPSHOT);
        let calls = runner.calls.clone();

        let snap = get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .expect("snapshot");

        // 같은 created_at(초 단위)에서는 id 순 — r1이 선정.
        assert_eq!(
            calls.lock().expect("calls lock")[0].0,
            PathBuf::from("/tmp/first-repo")
        );
        let covered = snap.covered_repo.expect("covered repo populated");
        assert_eq!(covered.repo_id, "r1");
        assert_eq!(covered.enabled_local_total, 2, "형제 레포 존재가 드러난다");
    }

    /// disabled 레포는 선정에서도 총수에서도 빠진다 (enabled=1 술어 잠금).
    #[tokio::test]
    async fn disabled_repo_excluded_from_coverage_total() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/enabled-repo").await;
        sqlx::query(
            "INSERT INTO repos (id, project_id, provider, local_path, default_branch, enabled) \
             VALUES ('r2', 'p1', 'local', '/tmp/disabled-repo', 'main', 0)",
        )
        .execute(&db)
        .await
        .expect("seed disabled repo");
        let runner = FakeRunner::ok(VALID_SNAPSHOT);

        let snap = get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .expect("snapshot");

        let covered = snap.covered_repo.expect("covered repo populated");
        assert_eq!(covered.repo_id, "r1");
        assert_eq!(
            covered.enabled_local_total, 1,
            "disabled 레포는 총수 미포함"
        );
    }

    #[tokio::test]
    async fn passes_db_resolved_repo_path_to_runner_not_renderer() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/the-only-repo").await;
        let runner = FakeRunner::ok(VALID_SNAPSHOT);
        let calls = runner.calls.clone();

        get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .expect("snapshot");

        let recorded = calls.lock().expect("calls lock");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].0, PathBuf::from("/tmp/the-only-repo"));
        assert!(!recorded[0].1, "no ticker row ⇒ live defaults to false");
    }

    #[tokio::test]
    async fn project_without_local_repo_yields_empty_snapshot_without_running() {
        let db = test_db().await;
        seed_project(&db, "p1").await; // no repo row (e.g. Notion-only project)
        let runner = FakeRunner::ok(VALID_SNAPSHOT);
        let calls = runner.calls.clone();

        let snap = get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .expect("empty snapshot, not an error");

        assert_eq!(snap, ControlRoomSnapshot::default());
        assert!(snap.tasks.is_empty() && snap.generated_at.is_none());
        assert!(
            snap.covered_repo.is_none(),
            "레포 없음 → coverage 칩 숨김 계약"
        );
        // Never shelled out — no local repo to fold.
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn unknown_project_still_errors() {
        let db = test_db().await;
        // No project seeded at all → resolve_project_repo_path's ensure_project_exists errors.
        let runner = FakeRunner::ok(VALID_SNAPSHOT);
        let calls = runner.calls.clone();

        let err = get_project_control_room_snapshot_with_runner(&db, "ghost", runner)
            .await
            .unwrap_err();

        assert_ne!(err.code, "ticker.repo_not_found"); // a real error, not the empty-snapshot path
        assert!(calls.lock().expect("calls lock").is_empty());
    }

    #[tokio::test]
    async fn live_opt_in_flows_into_snapshot_runner() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/repo").await;
        crate::governance::ticker::set_project_tick_live_core(&db, "p1", true)
            .await
            .expect("set live");
        let runner = FakeRunner::ok(VALID_SNAPSHOT);
        let calls = runner.calls.clone();

        get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .expect("snapshot");

        assert!(calls.lock().expect("calls lock")[0].1, "live flag injected");
    }

    #[tokio::test]
    async fn runner_error_propagates() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/repo").await;
        let runner = FakeRunner::err("governance.snapshot_failed");

        let err = get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .unwrap_err();

        assert_eq!(err.code, "governance.snapshot_failed");
    }

    #[tokio::test]
    async fn malformed_runner_output_is_terminal_parse_error() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", "/tmp/repo").await;
        let runner = FakeRunner::ok("{ not json");
        let calls = runner.calls.clone();

        let err = get_project_control_room_snapshot_with_runner(&db, "p1", runner)
            .await
            .unwrap_err();

        assert_eq!(err.code, "governance.parse_failed");
        assert_eq!(calls.lock().expect("calls lock").len(), 1); // ran, then failed to parse
    }
}
