//! App-bound ticker scheduler for Boule auto ticks.
//!
//! This is the operator clock: it lives only inside the Tauri app process and stops when the app
//! exits. It does not add a governance daemon or loop inside `boule`; each due row delegates to the
//! T1 `tick_project_now_with_runner` path, which owns DB-resolved repo paths, no-overlap locking,
//! bounded process execution, and attention persistence.

use crate::db::Db;
use crate::error::AppError;
use crate::governance::ticker::{
    record_auto_tick_dispatch_failure, tick_project_now_with_runner, RealTickCommandRunner,
    TickCommandRunner, TickerRunConfig,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::FromRow;
use std::time::Duration;
use tokio::time::MissedTickBehavior;

/// Fixed base wake interval. One bounded due-scan runs per wake; missed wakes are delayed, not
/// replayed, so laptop sleep cannot create catch-up scans.
pub const BASE_WAKE_INTERVAL: Duration = Duration::from_secs(30);

/// Floor for per-project intervals. Smaller stored values are treated as this floor so a malformed
/// or overly aggressive setting cannot busy-spin the app-bound scheduler.
pub const MIN_INTERVAL_SEC: i32 = 30;

#[derive(Debug, Clone, FromRow)]
struct DueTickerRow {
    project_id: String,
    interval_sec: i32,
}

pub trait TickerClock: Send + Sync + 'static {
    fn now_string(&self) -> String;
}

#[derive(Debug, Clone, Copy)]
pub struct SystemTickerClock;

impl TickerClock for SystemTickerClock {
    fn now_string(&self) -> String {
        crate::scheduler::utc_now_string()
    }
}

/// One bounded scan: select currently due, enabled, non-attention, non-running ticker rows and
/// trigger at most one T1 tick per row. `next_due_at` moves forward from `now`, never from its old
/// value, which suppresses catch-up storms after sleep/resume.
pub async fn run_due_scan<R>(
    db: &Db,
    runner: R,
    config: TickerRunConfig,
    now: &str,
) -> Result<usize, AppError>
where
    R: TickCommandRunner + Clone,
{
    let due = due_rows(db, now).await?;
    let mut fired = 0usize;
    for row in due {
        let interval_sec = clamp_interval(row.interval_sec);
        advance_next_due(db, &row.project_id, now, interval_sec).await?;
        match tick_project_now_with_runner(db, &row.project_id, runner.clone(), config).await {
            Ok(result) => {
                if !result.skipped {
                    fired = fired.saturating_add(1);
                }
            }
            Err(e) => {
                tracing::warn!(
                    code = "ticker_scheduler.tick_failed",
                    project_id = %row.project_id,
                    error = %e,
                    "auto tick failed during due scan"
                );
                // Persist the failure on the row so it counts toward bounded escalation
                // instead of silently retrying at every interval forever. Best-effort: a
                // second DB error must not abort the rest of the scan.
                if let Err(persist_err) =
                    record_auto_tick_dispatch_failure(db, &row.project_id, &e).await
                {
                    tracing::warn!(
                        code = "ticker_scheduler.failure_record_failed",
                        project_id = %row.project_id,
                        error = %persist_err,
                        "could not persist auto tick dispatch failure"
                    );
                }
            }
        }
    }
    Ok(fired)
}

/// Live heartbeat of the app-bound scheduler, written once per wake. `None` means the scheduler
/// has never woken on this database (or the feature predates this row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TickerSchedulerStatus {
    pub last_wake_at: String,
    pub scan_ok: bool,
    pub runner_ok: bool,
    pub runner_error: Option<String>,
    pub fired: i32,
    /// Age of the heartbeat in seconds, computed inside SQLite (single clock — no renderer
    /// clock-skew). Stale ≫ [`BASE_WAKE_INTERVAL`] means the scheduler task is dead.
    /// i32 (not i64): specta forbids BigInt-style types in bindings; ±68 years is plenty.
    pub seconds_since_wake: i32,
}

/// Upsert the single heartbeat row. Failures are surfaced to the caller, which logs and keeps
/// the loop alive (the heartbeat must never kill the scheduler it reports on).
pub async fn record_scheduler_heartbeat(
    db: &Db,
    now: &str,
    scan_ok: bool,
    runner_ok: bool,
    runner_error: Option<&str>,
    fired: usize,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO ticker_scheduler_status (id, last_wake_at, scan_ok, runner_ok, runner_error, fired) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET last_wake_at = excluded.last_wake_at, \
             scan_ok = excluded.scan_ok, runner_ok = excluded.runner_ok, \
             runner_error = excluded.runner_error, fired = excluded.fired",
    )
    .bind(now)
    .bind(scan_ok)
    .bind(runner_ok)
    .bind(runner_error)
    .bind(fired as i64)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn get_ticker_scheduler_status_core(
    db: &Db,
) -> Result<Option<TickerSchedulerStatus>, AppError> {
    Ok(sqlx::query_as::<_, TickerSchedulerStatus>(
        "SELECT last_wake_at, scan_ok, runner_ok, runner_error, fired, \
             CAST(MAX(0, strftime('%s', 'now') - strftime('%s', last_wake_at)) AS INTEGER) \
                 AS seconds_since_wake \
         FROM ticker_scheduler_status WHERE id = 1",
    )
    .fetch_optional(db)
    .await?)
}

/// auto-ticking 사용 여부 probe. `tick_enabled` 행이 하나도 없으면 runner resolve 자체를
/// 건너뛴다 — due 여부와 무관하게 "기능이 켜져 있는가"만 본다(작가 환경 관측성 보존:
/// 행이 있으면 due가 아니어도 매 wake resolve → runner_ok가 정직하게 유지된다).
async fn any_enabled_rows(db: &Db) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM project_ticker WHERE tick_enabled = 1)",
    )
    .fetch_one(db)
    .await
}

async fn due_rows(db: &Db, now: &str) -> Result<Vec<DueTickerRow>, sqlx::Error> {
    sqlx::query_as::<_, DueTickerRow>(
        "SELECT project_id, interval_sec \
         FROM project_ticker \
         WHERE tick_enabled = 1 \
           AND in_progress = 0 \
           AND attention_required = 0 \
           AND interval_sec IS NOT NULL \
           AND (next_due_at IS NULL OR next_due_at <= ?1) \
         ORDER BY next_due_at IS NULL, next_due_at, project_id",
    )
    .bind(now)
    .fetch_all(db)
    .await
}

async fn advance_next_due(
    db: &Db,
    project_id: &str,
    now: &str,
    interval_sec: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE project_ticker \
         SET next_due_at = datetime(?2, '+' || ?3 || ' seconds') \
         WHERE project_id = ?1",
    )
    .bind(project_id)
    .bind(now)
    .bind(interval_sec)
    .execute(db)
    .await?;
    Ok(())
}

fn clamp_interval(interval_sec: i32) -> i32 {
    interval_sec.max(MIN_INTERVAL_SEC)
}

/// Spawn the app-bound ticker scheduler on Tauri's managed async runtime. The scheduler stays
/// alive even when the Boule runner is unavailable at boot: it re-resolves on every wake
/// (self-healing — e.g. node installed after launch) and records the failure in the heartbeat
/// row instead of silently disabling auto-ticking until the next app start.
pub fn spawn_loop(db: Db) {
    tauri::async_runtime::spawn(async move {
        run_loop(db, TickerRunConfig::default(), SystemTickerClock).await;
    });
}

async fn run_loop<C>(db: Db, config: TickerRunConfig, clock: C)
where
    C: TickerClock,
{
    let mut ticker = tokio::time::interval(BASE_WAKE_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Resolved once and cached; while unavailable we retry every wake. A runner that breaks
    // AFTER caching surfaces per-row as spawn_failed and escalates via consecutive_failures.
    let mut runner: Option<RealTickCommandRunner> = None;
    loop {
        ticker.tick().await;
        let now = clock.now_string();
        // Runner resolve는 auto-ticking이 실제로 사용 중일 때만(tick_enabled 행 ≥1).
        // Boule CLI가 없는 머신(일반 설치)에서 무조건 resolve하면 쓰지도 않는 기능이
        // 매 wake마다 warn + runner_ok=false(Control Room "scheduler ✕")를 만든다.
        // 활성 행이 생기는 순간부터는 기존 매-wake resolve 동작 그대로.
        match any_enabled_rows(&db).await {
            Ok(true) => {}
            Ok(false) => {
                record_heartbeat_best_effort(&db, &now, true, true, None, 0).await;
                continue;
            }
            Err(e) => {
                tracing::warn!(
                    code = "ticker_scheduler.scan_failed",
                    error = %e,
                    "enabled-row probe failed"
                );
                record_heartbeat_best_effort(&db, &now, false, true, None, 0).await;
                continue;
            }
        }
        let active_runner = match &runner {
            Some(cached) => cached.clone(),
            None => match RealTickCommandRunner::resolve().await {
                Ok(resolved) => {
                    runner = Some(resolved.clone());
                    resolved
                }
                Err(e) => {
                    tracing::warn!(
                        code = "ticker_scheduler.runner_unavailable",
                        error = %e,
                        "Boule runner unavailable; auto ticks paused, retrying next wake"
                    );
                    record_heartbeat_best_effort(&db, &now, false, false, Some(&e.to_string()), 0)
                        .await;
                    continue;
                }
            },
        };
        match run_due_scan(&db, active_runner, config, &now).await {
            Ok(fired) => {
                if fired > 0 {
                    tracing::info!(
                        code = "ticker_scheduler.scan",
                        fired,
                        "auto ticker due scan fired projects"
                    );
                }
                record_heartbeat_best_effort(&db, &now, true, true, None, fired).await;
            }
            Err(e) => {
                tracing::warn!(
                    code = "ticker_scheduler.scan_failed",
                    error = %e,
                    "auto ticker due scan failed"
                );
                // `fired` is a display-only per-wake count; a mid-scan DB error may
                // undercount ticks that already fired this wake (scan_ok=false flags it).
                record_heartbeat_best_effort(&db, &now, false, true, None, 0).await;
            }
        }
    }
}

/// The heartbeat reports on the scheduler — it must never kill it. Log and continue.
async fn record_heartbeat_best_effort(
    db: &Db,
    now: &str,
    scan_ok: bool,
    runner_ok: bool,
    runner_error: Option<&str>,
    fired: usize,
) {
    if let Err(e) =
        record_scheduler_heartbeat(db, now, scan_ok, runner_ok, runner_error, fired).await
    {
        tracing::warn!(
            code = "ticker_scheduler.heartbeat_failed",
            error = %e,
            "could not persist scheduler heartbeat"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_db, Db};
    use crate::governance::ticker::{
        TickCommandOutput, TickCommandRequest, TickCommandRunner, TickStatusOutcome, TickerError,
        TickerRunConfig,
    };
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("work-radar-ticker-scheduler-test-{nanos}-{seq}.db"))
    }

    async fn test_db() -> Db {
        init_db(&temp_db_path()).await.expect("init test db")
    }

    async fn seed_project(db: &Db, project_id: &str) {
        sqlx::query(
            "INSERT INTO projects (id, name, kind, credential_ref) VALUES (?1, 'Ticker', 'personal', 'cred')",
        )
        .bind(project_id)
        .execute(db)
        .await
        .expect("seed project");
        sqlx::query(
            "INSERT INTO repos (id, project_id, provider, local_path, default_branch, enabled) \
             VALUES (?1, ?2, 'local', ?3, 'main', 1)",
        )
        .bind(format!("repo-{project_id}"))
        .bind(project_id)
        .bind(format!("/tmp/{project_id}"))
        .execute(db)
        .await
        .expect("seed repo");
    }

    async fn seed_ticker(
        db: &Db,
        project_id: &str,
        enabled: bool,
        interval_sec: Option<i32>,
        next_due_at: Option<&str>,
        in_progress: bool,
        attention_required: bool,
    ) {
        sqlx::query(
            "INSERT INTO project_ticker \
             (project_id, tick_enabled, interval_sec, next_due_at, in_progress, attention_required) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(project_id)
        .bind(enabled)
        .bind(interval_sec)
        .bind(next_due_at)
        .bind(in_progress)
        .bind(attention_required)
        .execute(db)
        .await
        .expect("seed ticker");
    }

    #[derive(Clone)]
    struct RecordingRunner {
        calls: Arc<Mutex<Vec<TickCommandRequest>>>,
    }

    impl RecordingRunner {
        fn new() -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.lock().expect("calls lock").len()
        }
    }

    #[async_trait]
    impl TickCommandRunner for RecordingRunner {
        async fn run_tick_command(
            &self,
            request: TickCommandRequest,
        ) -> Result<TickCommandOutput, TickerError> {
            self.calls.lock().expect("calls lock").push(request);
            Ok(TickCommandOutput {
                exit_code: 0,
                stdout: r#"{"outcome":"advanced","conducted":1,"specsAccepted":0,"plansAccepted":0,"haltedPlans":[],"stalledCount":0,"blockers":[],"warnings":[]}"#.into(),
            })
        }
    }

    async fn next_due(db: &Db, project_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT next_due_at FROM project_ticker WHERE project_id = ?1")
            .bind(project_id)
            .fetch_one(db)
            .await
            .expect("next_due_at")
    }

    #[tokio::test]
    async fn any_enabled_rows_false_on_fresh_db_and_disabled_rows() {
        let db = test_db().await;
        assert!(
            !any_enabled_rows(&db).await.expect("probe fresh db"),
            "빈 DB = auto-ticking 미사용 → runner resolve 스킵 대상"
        );
        seed_project(&db, "p-off").await;
        seed_ticker(&db, "p-off", false, Some(120), None, false, false).await;
        assert!(
            !any_enabled_rows(&db).await.expect("probe disabled row"),
            "tick_enabled=0만 있으면 여전히 미사용"
        );
    }

    #[tokio::test]
    async fn any_enabled_rows_true_even_when_not_due() {
        let db = test_db().await;
        seed_project(&db, "p-on").await;
        // next_due_at이 먼 미래(=due 아님)여도 기능이 켜져 있으면 true —
        // runner 관측성(runner_ok)은 due 여부와 무관하게 유지되어야 한다.
        seed_ticker(
            &db,
            "p-on",
            true,
            Some(120),
            Some("2999-01-01T00:00:00Z"),
            false,
            false,
        )
        .await;
        assert!(any_enabled_rows(&db).await.expect("probe enabled row"));
    }

    #[tokio::test]
    async fn due_enabled_row_fires_once_and_advances_next_due() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(120),
            Some("2026-06-09 09:59:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 1);
        assert_eq!(runner.call_count(), 1);
        assert_eq!(
            next_due(&db, "p1").await.as_deref(),
            Some("2026-06-09 10:02:00")
        );
    }

    #[tokio::test]
    async fn not_due_row_does_not_fire() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(120),
            Some("2026-06-09 10:01:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 0);
        assert_eq!(runner.call_count(), 0);
        assert_eq!(
            next_due(&db, "p1").await.as_deref(),
            Some("2026-06-09 10:01:00")
        );
    }

    #[tokio::test]
    async fn disabled_row_does_not_fire() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            false,
            Some(120),
            Some("2026-06-09 09:59:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 0);
        assert_eq!(runner.call_count(), 0);
    }

    #[tokio::test]
    async fn null_interval_row_does_not_auto_fire() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            None,
            Some("2026-06-09 09:59:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 0);
        assert_eq!(runner.call_count(), 0);
    }

    #[tokio::test]
    async fn attention_required_row_is_suppressed() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(120),
            Some("2026-06-09 09:59:00"),
            false,
            true,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 0);
        assert_eq!(runner.call_count(), 0);
    }

    #[tokio::test]
    async fn in_progress_row_is_skipped() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(120),
            Some("2026-06-09 09:59:00"),
            true,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 0);
        assert_eq!(runner.call_count(), 0);
    }

    #[tokio::test]
    async fn overdue_by_many_intervals_fires_once_and_moves_next_due_forward_from_now() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(60),
            Some("2026-06-09 01:00:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 1);
        assert_eq!(runner.call_count(), 1);
        assert_eq!(
            next_due(&db, "p1").await.as_deref(),
            Some("2026-06-09 10:01:00")
        );
    }

    #[tokio::test]
    async fn sub_floor_interval_is_clamped() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(1),
            Some("2026-06-09 09:59:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:00:00",
        )
        .await
        .expect("scan");

        assert_eq!(fired, 1);
        assert_eq!(runner.call_count(), 1);
        assert_eq!(
            next_due(&db, "p1").await.as_deref(),
            Some("2026-06-09 10:00:30")
        );
    }

    #[tokio::test]
    async fn scheduler_does_not_write_governance_events_or_autonomy_level() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_ticker(
            &db,
            "p1",
            true,
            Some(120),
            Some("2026-06-09 09:59:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        run_due_scan(&db, runner, TickerRunConfig::fast(), "2026-06-09 10:00:00")
            .await
            .expect("scan");

        let governance_tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE '%governance%'",
        )
        .fetch_all(&db)
        .await
        .expect("query sqlite master");
        assert!(governance_tables.is_empty());

        let ticker_sql: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_ticker'",
        )
        .fetch_one(&db)
        .await
        .expect("ticker sql");
        assert!(!ticker_sql.contains("autonomy"));

        let outcome: Option<TickStatusOutcome> =
            sqlx::query_scalar("SELECT last_outcome FROM project_ticker WHERE project_id = 'p1'")
                .fetch_one(&db)
                .await
                .expect("last outcome");
        assert_eq!(outcome, Some(TickStatusOutcome::Advanced));
    }

    #[tokio::test]
    async fn heartbeat_upserts_single_row_and_status_reads_back() {
        let db = test_db().await;

        assert_eq!(
            get_ticker_scheduler_status_core(&db).await.expect("status"),
            None,
            "no heartbeat yet"
        );

        record_scheduler_heartbeat(&db, "2026-06-01 09:59:00", false, false, Some("no node"), 0)
            .await
            .expect("first heartbeat");
        record_scheduler_heartbeat(&db, "2026-06-01 10:00:00", true, true, None, 2)
            .await
            .expect("second heartbeat");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ticker_scheduler_status")
            .fetch_one(&db)
            .await
            .expect("count");
        assert_eq!(count, 1, "single-row upsert");

        let status = get_ticker_scheduler_status_core(&db)
            .await
            .expect("status")
            .expect("row present");
        assert_eq!(status.last_wake_at, "2026-06-01 10:00:00");
        assert!(status.scan_ok && status.runner_ok);
        assert_eq!(status.runner_error, None);
        assert_eq!(status.fired, 2);
        assert!(
            status.seconds_since_wake > 60,
            "age from a timestamp days in the past must be large, got {}",
            status.seconds_since_wake
        );
    }

    /// A due row whose dispatch errs (here: no local repo to resolve) must count toward bounded
    /// escalation and eventually drop out of the due-scan — not silently retry forever.
    #[tokio::test]
    async fn dispatch_error_escalates_and_row_leaves_due_scan() {
        let db = test_db().await;
        // Project WITHOUT a repo row: resolve_project_repo_path fails inside the tick path.
        sqlx::query(
            "INSERT INTO projects (id, name, kind, credential_ref) VALUES ('p1', 'NoRepo', 'personal', 'cred')",
        )
        .execute(&db)
        .await
        .expect("seed project");
        seed_ticker(
            &db,
            "p1",
            true,
            Some(60),
            Some("2026-06-09 09:00:00"),
            false,
            false,
        )
        .await;
        let runner = RecordingRunner::new();

        let scan_times = [
            "2026-06-09 10:00:00",
            "2026-06-09 10:02:00",
            "2026-06-09 10:04:00",
        ];
        for now in scan_times {
            let fired = run_due_scan(&db, runner.clone(), TickerRunConfig::fast(), now)
                .await
                .expect("scan");
            assert_eq!(fired, 0);
        }
        assert_eq!(runner.call_count(), 0, "tick command never spawned");

        let (failures, attention): (i32, bool) = sqlx::query_as(
            "SELECT consecutive_failures, attention_required FROM project_ticker WHERE project_id = 'p1'",
        )
        .fetch_one(&db)
        .await
        .expect("row");
        assert_eq!(failures, 3);
        assert!(attention, "escalated to attention at the threshold");

        // With attention raised the row is no longer selected — bounded retry proven.
        let fired = run_due_scan(
            &db,
            runner.clone(),
            TickerRunConfig::fast(),
            "2026-06-09 10:06:00",
        )
        .await
        .expect("scan");
        assert_eq!(fired, 0);
        let (failures_after, _): (i32, bool) = sqlx::query_as(
            "SELECT consecutive_failures, attention_required FROM project_ticker WHERE project_id = 'p1'",
        )
        .fetch_one(&db)
        .await
        .expect("row");
        assert_eq!(failures_after, 3, "no further attempts recorded");
    }
}
