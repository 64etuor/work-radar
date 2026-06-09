//! App-bound ticker scheduler for Boule auto ticks.
//!
//! This is the operator clock: it lives only inside the Tauri app process and stops when the app
//! exits. It does not add a governance daemon or loop inside `boule`; each due row delegates to the
//! T1 `tick_project_now_with_runner` path, which owns DB-resolved repo paths, no-overlap locking,
//! bounded process execution, and attention persistence.

use crate::db::Db;
use crate::error::AppError;
use crate::governance::ticker::{
    tick_project_now_with_runner, RealTickCommandRunner, TickCommandRunner, TickerRunConfig,
};
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
            }
        }
    }
    Ok(fired)
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

/// Spawn the app-bound ticker scheduler on Tauri's managed async runtime. If the real Boule runner
/// cannot be resolved, the app stays up and auto-ticking is disabled until the next app start.
pub fn spawn_loop(db: Db) {
    tauri::async_runtime::spawn(async move {
        let runner = match RealTickCommandRunner::resolve().await {
            Ok(runner) => runner,
            Err(e) => {
                tracing::warn!(
                    code = "ticker_scheduler.runner_unavailable",
                    error = %e,
                    "ticker scheduler disabled: Boule runner unavailable"
                );
                return;
            }
        };
        spawn_loop_with_runner(db, runner, TickerRunConfig::default(), SystemTickerClock);
    });
}

pub fn spawn_loop_with_runner<R, C>(db: Db, runner: R, config: TickerRunConfig, clock: C)
where
    R: TickCommandRunner + Clone + 'static,
    C: TickerClock,
{
    tauri::async_runtime::spawn(async move {
        run_loop(db, runner, config, clock).await;
    });
}

async fn run_loop<R, C>(db: Db, runner: R, config: TickerRunConfig, clock: C)
where
    R: TickCommandRunner + Clone,
    C: TickerClock,
{
    let mut ticker = tokio::time::interval(BASE_WAKE_INTERVAL);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let now = clock.now_string();
        match run_due_scan(&db, runner.clone(), config, &now).await {
            Ok(fired) if fired > 0 => {
                tracing::info!(
                    code = "ticker_scheduler.scan",
                    fired,
                    "auto ticker due scan fired projects"
                );
            }
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    code = "ticker_scheduler.scan_failed",
                    error = %e,
                    "auto ticker due scan failed"
                );
            }
        }
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
}
