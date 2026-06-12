#![allow(clippy::result_large_err)]

use crate::db::Db;
use crate::error::AppError;
use crate::governance::boule_config::{get_boule_config_core, BouleAutonomyLevel};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::sqlite::SqliteRow;
use sqlx::{FromRow, Row};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

const DEFAULT_MAX_STEPS: i32 = 1;
const DEFAULT_TICK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const AUX_TIMEOUT: Duration = Duration::from_secs(20);

/// Back-to-back infra-class failures (spawn/timeout/parse/readiness/infra) tolerated before the
/// row raises `attention_required` and drops out of the auto due-scan. Bounded retry: without
/// this, an infra failure would silently re-run at every interval forever.
pub const MAX_CONSECUTIVE_INFRA_FAILURES: i32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, sqlx::Type)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum TickStatusOutcome {
    Advanced,
    Idle,
    InFlight,
    HaltedDecision,
    NeedsHuman,
    Stalled,
    ReadinessFailed,
    InfraFailed,
    Busy,
    Timeout,
    SpawnFailed,
    ParseFailed,
    /// The app died mid-tick (in_progress lock left set). Boot reconciliation marks the orphaned
    /// row with this so the stuck lock is released (the in-process runner cannot survive an app
    /// exit, so any in_progress=1 at startup is necessarily stale). NOT a governance decision/stall,
    /// so it does NOT set attention_required — the operator simply re-ticks (or the scheduler will).
    Interrupted,
}

impl TickStatusOutcome {
    fn requires_attention(self) -> bool {
        matches!(
            self,
            Self::HaltedDecision | Self::NeedsHuman | Self::Stalled
        )
    }

    fn is_success(self, exit_code: i32) -> bool {
        exit_code == 0 && matches!(self, Self::Advanced | Self::Idle | Self::InFlight)
    }

    /// Infra-class failures: the tick did not produce a governance verdict (CLI missing, hung,
    /// unparsable, or readiness/preflight not met). These escalate to `attention_required` only
    /// after [`MAX_CONSECUTIVE_INFRA_FAILURES`] in a row.
    fn is_infra_failure(self) -> bool {
        matches!(
            self,
            Self::SpawnFailed
                | Self::Timeout
                | Self::ParseFailed
                | Self::ReadinessFailed
                | Self::InfraFailed
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTickStatus {
    pub project_id: String,
    pub tick_enabled: bool,
    pub interval_sec: Option<i32>,
    pub max_steps: i32,
    pub next_due_at: Option<String>,
    pub in_progress: bool,
    pub last_started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_outcome: Option<TickStatusOutcome>,
    pub last_exit_code: Option<i32>,
    pub last_report_json: Option<String>,
    pub attention_required: bool,
    pub consecutive_failures: i32,
    /// Per-project operator opt-in: inject BOULE_CONDUCTOR_MODE/OBSERVER_MODE=live into
    /// this project's spawned boule tick/snapshot. 0 = stub adapter (nothing spawns).
    pub live_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTickerStatusRow {
    pub project_id: String,
    pub project_name: String,
    pub tick_enabled: bool,
    pub interval_sec: Option<i32>,
    pub max_steps: i32,
    pub next_due_at: Option<String>,
    pub in_progress: bool,
    pub last_started_at: Option<String>,
    pub last_finished_at: Option<String>,
    pub last_outcome: Option<TickStatusOutcome>,
    pub last_exit_code: Option<i32>,
    pub attention_required: bool,
    pub consecutive_failures: i32,
    pub live_enabled: bool,
    pub autonomy_level: Option<BouleAutonomyLevel>,
}

impl ProjectTickerStatusRow {
    fn from_raw(
        raw: ProjectTickerStatusRawRow,
        autonomy_level: Option<BouleAutonomyLevel>,
    ) -> Self {
        Self {
            project_id: raw.project_id,
            project_name: raw.project_name,
            tick_enabled: raw.tick_enabled,
            interval_sec: raw.interval_sec,
            max_steps: raw.max_steps,
            next_due_at: raw.next_due_at,
            in_progress: raw.in_progress,
            last_started_at: raw.last_started_at,
            last_finished_at: raw.last_finished_at,
            last_outcome: raw.last_outcome,
            last_exit_code: raw.last_exit_code,
            attention_required: raw.attention_required,
            consecutive_failures: raw.consecutive_failures,
            live_enabled: raw.live_enabled,
            autonomy_level,
        }
    }
}

#[derive(Debug, Clone)]
struct ProjectTickerStatusRawRow {
    project_id: String,
    project_name: String,
    tick_enabled: bool,
    interval_sec: Option<i32>,
    max_steps: i32,
    next_due_at: Option<String>,
    in_progress: bool,
    last_started_at: Option<String>,
    last_finished_at: Option<String>,
    last_outcome: Option<TickStatusOutcome>,
    last_exit_code: Option<i32>,
    attention_required: bool,
    consecutive_failures: i32,
    live_enabled: bool,
}

impl<'r> FromRow<'r, SqliteRow> for ProjectTickerStatusRawRow {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            project_id: row.try_get("project_id")?,
            project_name: row.try_get("project_name")?,
            tick_enabled: row.try_get("tick_enabled")?,
            interval_sec: row.try_get("interval_sec")?,
            max_steps: row.try_get("max_steps")?,
            next_due_at: row.try_get("next_due_at")?,
            in_progress: row.try_get("in_progress")?,
            last_started_at: row.try_get("last_started_at")?,
            last_finished_at: row.try_get("last_finished_at")?,
            last_outcome: row.try_get("last_outcome")?,
            last_exit_code: row.try_get("last_exit_code")?,
            attention_required: row.try_get("attention_required")?,
            consecutive_failures: row.try_get("consecutive_failures")?,
            live_enabled: row.try_get("live_enabled")?,
        })
    }
}

impl ProjectTickStatus {
    fn default_for(project_id: &str) -> Self {
        Self {
            project_id: project_id.into(),
            tick_enabled: false,
            interval_sec: None,
            max_steps: DEFAULT_MAX_STEPS,
            next_due_at: None,
            in_progress: false,
            last_started_at: None,
            last_finished_at: None,
            last_outcome: None,
            last_exit_code: None,
            last_report_json: None,
            attention_required: false,
            consecutive_failures: 0,
            live_enabled: false,
        }
    }
}

impl<'r> FromRow<'r, SqliteRow> for ProjectTickStatus {
    fn from_row(row: &'r SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            project_id: row.try_get("project_id")?,
            tick_enabled: row.try_get("tick_enabled")?,
            interval_sec: row.try_get("interval_sec")?,
            max_steps: row.try_get("max_steps")?,
            next_due_at: row.try_get("next_due_at")?,
            in_progress: row.try_get("in_progress")?,
            last_started_at: row.try_get("last_started_at")?,
            last_finished_at: row.try_get("last_finished_at")?,
            last_outcome: row.try_get("last_outcome")?,
            last_exit_code: row.try_get("last_exit_code")?,
            last_report_json: row.try_get("last_report_json")?,
            attention_required: row.try_get("attention_required")?,
            consecutive_failures: row.try_get("consecutive_failures")?,
            live_enabled: row.try_get("live_enabled")?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub outcome: TickStatusOutcome,
    pub conducted: i32,
    pub specs_accepted: i32,
    pub plans_accepted: i32,
    pub halted_plans: Vec<String>,
    pub stalled_count: i32,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TickProjectNowResult {
    pub status: ProjectTickStatus,
    pub outcome: TickStatusOutcome,
    pub success: bool,
    pub skipped: bool,
    pub exit_code: Option<i32>,
    pub report: Option<TickReport>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TickCommandRequest {
    pub repo_path: PathBuf,
    pub max_steps: i32,
    /// Operator LIVE opt-in for this project (DB project_ticker.live_enabled): when true the
    /// runner injects BOULE_CONDUCTOR_MODE/OBSERVER_MODE=live into the spawned child.
    pub live: bool,
}

#[derive(Debug, Clone)]
pub struct TickCommandOutput {
    pub exit_code: i32,
    pub stdout: String,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum TickerError {
    #[error("ticker command unavailable: {0}")]
    Unavailable(String),
    #[error("ticker command spawn failed: {0}")]
    Spawn(String),
}

#[async_trait]
pub trait TickCommandRunner: Send + Sync {
    async fn run_tick_command(
        &self,
        request: TickCommandRequest,
    ) -> Result<TickCommandOutput, TickerError>;
}

#[derive(Debug, Clone, Copy)]
pub struct TickerRunConfig {
    pub timeout: Duration,
}

impl TickerRunConfig {
    #[cfg(test)]
    pub fn fast() -> Self {
        Self {
            timeout: Duration::from_millis(50),
        }
    }
}

impl Default for TickerRunConfig {
    fn default() -> Self {
        Self {
            timeout: DEFAULT_TICK_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RealTickCommandRunner {
    node_bin: PathBuf,
    cli_entrypoint: PathBuf,
}

impl RealTickCommandRunner {
    pub async fn resolve() -> Result<Self, TickerError> {
        let node_bin = resolve_node_bin()
            .await
            .ok_or_else(|| TickerError::Unavailable("node binary not found".into()))?;
        let cli_entrypoint = resolve_boule_cli_entrypoint().ok_or_else(|| {
            TickerError::Unavailable(
                "boule CLI entrypoint not found; set BOULE_CLI_ENTRYPOINT or WORK_RADAR_GOVERNANCE_DIR"
                    .into(),
            )
        })?;
        Ok(Self {
            node_bin,
            cli_entrypoint,
        })
    }
}

#[async_trait]
impl TickCommandRunner for RealTickCommandRunner {
    async fn run_tick_command(
        &self,
        request: TickCommandRequest,
    ) -> Result<TickCommandOutput, TickerError> {
        let mut command = Command::new(&self.node_bin);
        command
            .arg("--experimental-strip-types")
            .arg(&self.cli_entrypoint)
            .arg("tick")
            .arg("--repo")
            .arg(&request.repo_path)
            .arg("--max-steps")
            .arg(request.max_steps.to_string())
            .arg("--json");
        // Per-project LIVE opt-in (DB) → child env. Shell env stays a global fallback for
        // CLI/cron; live=false deliberately does NOT unset it (operator env wins there).
        if request.live {
            command
                .env("BOULE_CONDUCTOR_MODE", "live")
                .env("BOULE_OBSERVER_MODE", "live");
        }
        let output = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| TickerError::Spawn(e.to_string()))?;
        Ok(TickCommandOutput {
            exit_code: output.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        })
    }
}

pub async fn tick_project_now(db: &Db, project_id: &str) -> Result<TickProjectNowResult, AppError> {
    tick_project_now_with_runner(
        db,
        project_id,
        SystemTickCommandRunner,
        TickerRunConfig::default(),
    )
    .await
}

#[derive(Debug, Clone, Copy)]
struct SystemTickCommandRunner;

#[async_trait]
impl TickCommandRunner for SystemTickCommandRunner {
    async fn run_tick_command(
        &self,
        request: TickCommandRequest,
    ) -> Result<TickCommandOutput, TickerError> {
        RealTickCommandRunner::resolve()
            .await?
            .run_tick_command(request)
            .await
    }
}

pub async fn tick_project_now_with_runner<R>(
    db: &Db,
    project_id: &str,
    runner: R,
    config: TickerRunConfig,
) -> Result<TickProjectNowResult, AppError>
where
    R: TickCommandRunner,
{
    let repo_path = resolve_project_repo_path(db, project_id).await?;
    ensure_ticker_row(db, project_id).await?;
    let locked = acquire_in_progress(db, project_id).await?;
    if !locked {
        let status = get_project_tick_status_core(db, project_id).await?;
        return Ok(TickProjectNowResult {
            status,
            outcome: TickStatusOutcome::Busy,
            success: false,
            skipped: true,
            exit_code: None,
            report: None,
            error: Some("tick already in progress".into()),
        });
    }

    let max_steps = current_max_steps(db, project_id).await?;
    let live = current_live_enabled(db, project_id).await?;
    let request = TickCommandRequest {
        repo_path,
        max_steps,
        live,
    };
    let command_result =
        tokio::time::timeout(config.timeout, runner.run_tick_command(request)).await;

    let finalized = match command_result {
        Ok(Ok(output)) => classify_command_output(&output),
        Ok(Err(err)) => FinalizedTick {
            outcome: TickStatusOutcome::SpawnFailed,
            exit_code: None,
            report_json: Some(error_report_json("spawn_failed", &err.to_string())),
            report: None,
            error: Some(err.to_string()),
        },
        Err(_) => FinalizedTick {
            outcome: TickStatusOutcome::Timeout,
            exit_code: None,
            report_json: Some(error_report_json("timeout", "ticker command timed out")),
            report: None,
            error: Some("ticker command timed out and was killed".into()),
        },
    };

    persist_finalized_tick(db, project_id, &finalized).await?;
    let status = get_project_tick_status_core(db, project_id).await?;
    Ok(TickProjectNowResult {
        success: finalized
            .exit_code
            .is_some_and(|code| finalized.outcome.is_success(code)),
        skipped: false,
        exit_code: finalized.exit_code,
        report: finalized.report,
        error: finalized.error,
        outcome: finalized.outcome,
        status,
    })
}

pub async fn get_project_tick_status_core(
    db: &Db,
    project_id: &str,
) -> Result<ProjectTickStatus, AppError> {
    ensure_project_exists(db, project_id).await?;
    let status = sqlx::query_as::<_, ProjectTickStatus>(
        "SELECT project_id, tick_enabled, interval_sec, max_steps, next_due_at, in_progress, \
         last_started_at, last_finished_at, last_outcome, last_exit_code, last_report_json, \
         attention_required, consecutive_failures, live_enabled \
         FROM project_ticker WHERE project_id = ?1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    Ok(status.unwrap_or_else(|| ProjectTickStatus::default_for(project_id)))
}

pub async fn list_project_tick_status_core(
    db: &Db,
) -> Result<Vec<ProjectTickerStatusRow>, AppError> {
    let rows = sqlx::query_as::<_, ProjectTickerStatusRawRow>(
        "SELECT \
             p.id AS project_id, \
             p.name AS project_name, \
             COALESCE(t.tick_enabled, 0) AS tick_enabled, \
             t.interval_sec AS interval_sec, \
             COALESCE(t.max_steps, ?1) AS max_steps, \
             t.next_due_at AS next_due_at, \
             COALESCE(t.in_progress, 0) AS in_progress, \
             t.last_started_at AS last_started_at, \
             t.last_finished_at AS last_finished_at, \
             t.last_outcome AS last_outcome, \
             t.last_exit_code AS last_exit_code, \
             COALESCE(t.attention_required, 0) AS attention_required, \
             COALESCE(t.consecutive_failures, 0) AS consecutive_failures, \
             COALESCE(t.live_enabled, 0) AS live_enabled \
         FROM projects p \
         LEFT JOIN project_ticker t ON t.project_id = p.id \
         ORDER BY p.created_at, p.id",
    )
    .bind(DEFAULT_MAX_STEPS)
    .fetch_all(db)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let autonomy_level = project_autonomy_level_best_effort(db, &row.project_id).await;
        out.push(ProjectTickerStatusRow::from_raw(row, autonomy_level));
    }
    Ok(out)
}

pub async fn set_project_tick_enabled_core(
    db: &Db,
    project_id: &str,
    enabled: bool,
) -> Result<ProjectTickStatus, AppError> {
    ensure_project_exists(db, project_id).await?;
    ensure_ticker_row(db, project_id).await?;
    sqlx::query("UPDATE project_ticker SET tick_enabled = ?2 WHERE project_id = ?1")
        .bind(project_id)
        .bind(enabled)
        .execute(db)
        .await?;
    get_project_tick_status_core(db, project_id).await
}

pub async fn set_project_tick_interval_core(
    db: &Db,
    project_id: &str,
    interval_sec: Option<i32>,
) -> Result<ProjectTickStatus, AppError> {
    if interval_sec.is_some_and(|sec| sec <= 0) {
        return Err(AppError::validation(
            "ticker.interval_invalid",
            "interval_sec must be positive when provided",
        ));
    }
    ensure_project_exists(db, project_id).await?;
    ensure_ticker_row(db, project_id).await?;
    sqlx::query("UPDATE project_ticker SET interval_sec = ?2 WHERE project_id = ?1")
        .bind(project_id)
        .bind(interval_sec)
        .execute(db)
        .await?;
    get_project_tick_status_core(db, project_id).await
}

/// Per-project LIVE opt-in toggle (operator consent to spawn real sessions). The ticker/
/// snapshot runners read it at spawn time; no governance event/autonomy write.
pub async fn set_project_tick_live_core(
    db: &Db,
    project_id: &str,
    live: bool,
) -> Result<ProjectTickStatus, AppError> {
    ensure_project_exists(db, project_id).await?;
    ensure_ticker_row(db, project_id).await?;
    sqlx::query("UPDATE project_ticker SET live_enabled = ?2 WHERE project_id = ?1")
        .bind(project_id)
        .bind(live)
        .execute(db)
        .await?;
    get_project_tick_status_core(db, project_id).await
}

/// P1(a) — operator latch release. Clears `attention_required` AND resets the
/// `consecutive_failures` streak so the row re-enters the auto due-scan and the NEXT
/// infra failure starts a fresh bounded-escalation window (re-latches cleanly at
/// [`MAX_CONSECUTIVE_INFRA_FAILURES`] — without the reset, one post-release failure
/// would immediately re-latch). Touches NOTHING else: `in_progress`, `last_*` audit
/// fields and the scheduler heartbeat stay as-is — the latch context
/// (`last_outcome`/`last_report_json`) remains visible until the next tick overwrites it.
pub async fn clear_ticker_attention_core(
    db: &Db,
    project_id: &str,
) -> Result<ProjectTickStatus, AppError> {
    ensure_project_exists(db, project_id).await?;
    ensure_ticker_row(db, project_id).await?;
    sqlx::query(
        "UPDATE project_ticker \
         SET attention_required = 0, consecutive_failures = 0 \
         WHERE project_id = ?1",
    )
    .bind(project_id)
    .execute(db)
    .await?;
    get_project_tick_status_core(db, project_id).await
}

struct FinalizedTick {
    outcome: TickStatusOutcome,
    exit_code: Option<i32>,
    report_json: Option<String>,
    report: Option<TickReport>,
    error: Option<String>,
}

fn classify_command_output(output: &TickCommandOutput) -> FinalizedTick {
    let Some(json_line) = output
        .stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
    else {
        return FinalizedTick {
            outcome: TickStatusOutcome::ParseFailed,
            exit_code: Some(output.exit_code),
            report_json: Some(error_report_json("parse_failed", "ticker stdout was empty")),
            report: None,
            error: Some("ticker stdout was empty".into()),
        };
    };

    match serde_json::from_str::<TickReport>(json_line) {
        Ok(report) => {
            let mut outcome = report.outcome;
            if output.exit_code == 10
                && !matches!(
                    outcome,
                    TickStatusOutcome::HaltedDecision
                        | TickStatusOutcome::NeedsHuman
                        | TickStatusOutcome::Stalled
                )
            {
                outcome = TickStatusOutcome::NeedsHuman;
            }
            FinalizedTick {
                outcome,
                exit_code: Some(output.exit_code),
                report_json: Some(json_line.into()),
                report: Some(report),
                error: None,
            }
        }
        Err(e) => FinalizedTick {
            outcome: TickStatusOutcome::ParseFailed,
            exit_code: Some(output.exit_code),
            report_json: Some(error_report_json("parse_failed", &e.to_string())),
            report: None,
            error: Some(format!("failed to parse TickReport JSON: {e}")),
        },
    }
}

async fn ensure_project_exists(db: &Db, project_id: &str) -> Result<(), AppError> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?;
    if exists.is_some() {
        Ok(())
    } else {
        Err(AppError::not_found(
            "projects.not_found",
            "project not found",
        ))
    }
}

async fn ensure_ticker_row(db: &Db, project_id: &str) -> Result<(), AppError> {
    sqlx::query("INSERT OR IGNORE INTO project_ticker (project_id) VALUES (?1)")
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

async fn current_max_steps(db: &Db, project_id: &str) -> Result<i32, AppError> {
    Ok(
        sqlx::query_scalar::<_, i32>("SELECT max_steps FROM project_ticker WHERE project_id = ?1")
            .bind(project_id)
            .fetch_one(db)
            .await?
            .max(1),
    )
}

pub(crate) async fn current_live_enabled(db: &Db, project_id: &str) -> Result<bool, AppError> {
    Ok(sqlx::query_scalar::<_, bool>(
        "SELECT live_enabled FROM project_ticker WHERE project_id = ?1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?
    .unwrap_or(false))
}

async fn project_autonomy_level_best_effort(
    db: &Db,
    project_id: &str,
) -> Option<BouleAutonomyLevel> {
    let repo_id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM repos \
         WHERE project_id = ?1 AND provider = 'local' AND enabled = 1 \
           AND local_path IS NOT NULL AND local_path != '' \
         ORDER BY created_at, id LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await
    .ok()??;

    let config = get_boule_config_core(db, &repo_id).await.ok()?;
    config.config_exists.then_some(config.autonomy_level)
}

async fn acquire_in_progress(db: &Db, project_id: &str) -> Result<bool, AppError> {
    let res = sqlx::query(
        "UPDATE project_ticker \
         SET in_progress = 1, last_started_at = datetime('now') \
         WHERE project_id = ?1 AND in_progress = 0",
    )
    .bind(project_id)
    .execute(db)
    .await?;
    Ok(res.rows_affected() == 1)
}

async fn persist_finalized_tick(
    db: &Db,
    project_id: &str,
    tick: &FinalizedTick,
) -> Result<(), AppError> {
    let governance_attention = tick.outcome.requires_attention();
    let infra_failure = tick.outcome.is_infra_failure();
    // Single atomic UPDATE: infra failures bump consecutive_failures and escalate to
    // attention_required at the threshold (which removes the row from the auto due-scan —
    // bounded retry). Any non-infra outcome resets the streak.
    sqlx::query(
        "UPDATE project_ticker \
         SET in_progress = 0, last_finished_at = datetime('now'), last_outcome = ?2, \
             last_exit_code = ?3, last_report_json = ?4, \
             consecutive_failures = CASE WHEN ?6 THEN consecutive_failures + 1 ELSE 0 END, \
             attention_required = CASE \
                 WHEN ?5 THEN 1 \
                 WHEN ?6 AND consecutive_failures + 1 >= ?7 THEN 1 \
                 ELSE 0 END \
         WHERE project_id = ?1",
    )
    .bind(project_id)
    .bind(tick.outcome)
    .bind(tick.exit_code)
    .bind(&tick.report_json)
    .bind(governance_attention)
    .bind(infra_failure)
    .bind(MAX_CONSECUTIVE_INFRA_FAILURES)
    .execute(db)
    .await?;
    Ok(())
}

/// Persist a due-scan dispatch failure (the tick command never ran — e.g. the project's repo
/// path could not be resolved). Without this, a scheduler-side `Err` left the row untouched and
/// silently retried at every interval forever. Reuses the same bounded-escalation path as
/// infra-class tick outcomes.
pub async fn record_auto_tick_dispatch_failure(
    db: &Db,
    project_id: &str,
    error: &AppError,
) -> Result<(), AppError> {
    ensure_ticker_row(db, project_id).await?;
    let tick = FinalizedTick {
        outcome: TickStatusOutcome::SpawnFailed,
        exit_code: None,
        report_json: Some(error_report_json("dispatch_failed", &error.message)),
        report: None,
        error: Some(error.message.clone()),
    };
    persist_finalized_tick(db, project_id, &tick).await
}

/// Boot reconciliation (MAJOR fix): release `in_progress` locks orphaned by an app crash/exit.
/// The ticker runner runs IN-PROCESS, so a spawned `boule tick` cannot outlive the app — any row
/// with `in_progress = 1` at startup is necessarily stale and would otherwise WEDGE that project
/// forever (`acquire_in_progress` can never win again). Mirrors `recover_interrupted_runs` /
/// `recover_interrupted_actions`. Does NOT touch `attention_required` (an app crash is not a
/// governance halt/stall). Returns the number of locks released.
pub async fn recover_interrupted_ticks(db: &Db) -> Result<u64, AppError> {
    // Deliberately leaves consecutive_failures untouched: an app exit mid-tick says nothing
    // about the tick infra itself, so it neither extends nor resets the failure streak.
    let res = sqlx::query(
        "UPDATE project_ticker \
         SET in_progress = 0, last_finished_at = datetime('now'), last_outcome = 'interrupted' \
         WHERE in_progress = 1",
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// 집계 대상 로컬 레포 한 행 — Control Room이 "어느 레포를 접었는지" 표시할 수 있게
/// 경로뿐 아니라 id도 노출한다. 선정 규칙(첫 enabled 로컬 레포)은 tick과 동일해야 한다.
pub(crate) struct ProjectRepoRow {
    pub id: String,
    pub local_path: String,
}

pub(crate) async fn resolve_project_repo_row(
    db: &Db,
    project_id: &str,
) -> Result<ProjectRepoRow, AppError> {
    ensure_project_exists(db, project_id).await?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT id, local_path FROM repos \
         WHERE project_id = ?1 AND provider = 'local' AND enabled = 1 \
           AND local_path IS NOT NULL AND local_path != '' \
         ORDER BY created_at, id LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(db)
    .await?;
    row.map(|(id, local_path)| ProjectRepoRow { id, local_path })
        .ok_or_else(|| {
            AppError::not_found(
                "ticker.repo_not_found",
                "project has no enabled local repo with local_path",
            )
        })
}

pub(crate) async fn resolve_project_repo_path(
    db: &Db,
    project_id: &str,
) -> Result<PathBuf, AppError> {
    Ok(PathBuf::from(
        resolve_project_repo_row(db, project_id).await?.local_path,
    ))
}

fn error_report_json(code: &str, message: &str) -> String {
    serde_json::json!({ "error": { "code": code, "message": message } }).to_string()
}

pub(crate) async fn resolve_node_bin() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(node) = std::env::var("BOULE_NODE") {
        if !node.trim().is_empty() {
            candidates.push(PathBuf::from(node));
        }
    }
    candidates.extend(
        [
            "node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        .into_iter()
        .map(PathBuf::from),
    );
    for candidate in candidates {
        if node_version(&candidate).await.is_some() {
            return Some(candidate);
        }
    }
    None
}

async fn node_version(bin: &Path) -> Option<String> {
    let out = tokio::time::timeout(AUX_TIMEOUT, Command::new(bin).arg("--version").output())
        .await
        .ok()?
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

pub(crate) fn resolve_boule_cli_entrypoint() -> Option<PathBuf> {
    if let Ok(entrypoint) = std::env::var("BOULE_CLI_ENTRYPOINT") {
        let p = PathBuf::from(entrypoint);
        if p.is_file() {
            return Some(p);
        }
    }
    for env_key in ["WORK_RADAR_GOVERNANCE_DIR", "BOULE_GOVERNANCE_DIR"] {
        if let Ok(dir) = std::env::var(env_key) {
            let p = PathBuf::from(dir).join("src").join("cli").join("boule.ts");
            if p.is_file() {
                return Some(p);
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|repo| {
            repo.join("governance")
                .join("src")
                .join("cli")
                .join("boule.ts")
        });
    if let Some(p) = dev {
        if p.is_file() {
            return Some(p);
        }
    }

    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent();
    while let Some(current) = dir {
        let candidate = current
            .join("governance")
            .join("src")
            .join("cli")
            .join("boule.ts");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_db, Db};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("work-radar-ticker-test-{nanos}-{seq}.db"))
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
    }

    async fn seed_local_repo(db: &Db, project_id: &str, repo_id: &str, path: Option<&str>) {
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

    #[derive(Clone)]
    struct FakeRunner {
        calls: Arc<Mutex<Vec<TickCommandRequest>>>,
        response: FakeResponse,
    }

    #[derive(Clone)]
    enum FakeResponse {
        Output(TickCommandOutput),
        Error(TickerError),
        Sleep(Duration),
    }

    impl FakeRunner {
        fn output(exit_code: i32, stdout: &str) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                response: FakeResponse::Output(TickCommandOutput {
                    exit_code,
                    stdout: stdout.into(),
                }),
            }
        }

        fn sleeping_for(duration: Duration) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                response: FakeResponse::Sleep(duration),
            }
        }

        fn error(err: TickerError) -> Self {
            Self {
                calls: Arc::new(Mutex::new(Vec::new())),
                response: FakeResponse::Error(err),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.lock().expect("calls lock").len()
        }
    }

    #[async_trait::async_trait]
    impl TickCommandRunner for FakeRunner {
        async fn run_tick_command(
            &self,
            request: TickCommandRequest,
        ) -> Result<TickCommandOutput, TickerError> {
            self.calls.lock().expect("calls lock").push(request);
            match &self.response {
                FakeResponse::Output(output) => Ok(output.clone()),
                FakeResponse::Error(err) => Err(err.clone()),
                FakeResponse::Sleep(duration) => {
                    tokio::time::sleep(*duration).await;
                    Ok(TickCommandOutput {
                        exit_code: 0,
                        stdout: advanced_report(),
                    })
                }
            }
        }
    }

    fn advanced_report() -> String {
        r#"{"outcome":"advanced","conducted":1,"specsAccepted":0,"plansAccepted":0,"haltedPlans":[],"stalledCount":0,"blockers":[],"warnings":[]}"#.into()
    }

    fn halted_report() -> &'static str {
        r#"{"outcome":"halted_decision","conducted":0,"specsAccepted":0,"plansAccepted":0,"haltedPlans":["p1"],"stalledCount":0,"blockers":[],"warnings":[]}"#
    }

    #[tokio::test]
    async fn tick_now_resolves_repo_path_from_project_id_before_spawning() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::output(0, &advanced_report());

        let result =
            tick_project_now_with_runner(&db, "p1", runner.clone(), TickerRunConfig::fast())
                .await
                .expect("tick result");

        assert_eq!(runner.call_count(), 1);
        let calls = runner.calls.lock().expect("calls lock");
        assert_eq!(calls[0].repo_path.to_string_lossy(), "/tmp/repo-a");
        assert_eq!(calls[0].max_steps, 1);
        assert_eq!(result.outcome, TickStatusOutcome::Advanced);
    }

    #[tokio::test]
    async fn tick_now_missing_project_or_repo_path_errors_without_spawn() {
        let db = test_db().await;
        let runner = FakeRunner::output(0, &advanced_report());
        let err =
            tick_project_now_with_runner(&db, "missing", runner.clone(), TickerRunConfig::fast())
                .await
                .expect_err("missing project should fail");
        assert_eq!(err.code, "projects.not_found");
        assert_eq!(runner.call_count(), 0);

        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", None).await;
        let err = tick_project_now_with_runner(&db, "p1", runner.clone(), TickerRunConfig::fast())
            .await
            .expect_err("missing local path should fail");
        assert_eq!(err.code, "ticker.repo_not_found");
        assert_eq!(runner.call_count(), 0);
    }

    #[tokio::test]
    async fn tick_now_returns_busy_without_spawning_when_in_progress() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        set_project_tick_enabled_core(&db, "p1", true)
            .await
            .expect("row");
        sqlx::query("UPDATE project_ticker SET in_progress = 1 WHERE project_id = 'p1'")
            .execute(&db)
            .await
            .expect("set in progress");
        let runner = FakeRunner::output(0, &advanced_report());

        let result =
            tick_project_now_with_runner(&db, "p1", runner.clone(), TickerRunConfig::fast())
                .await
                .expect("busy result");

        assert_eq!(result.outcome, TickStatusOutcome::Busy);
        assert!(result.skipped);
        assert_eq!(runner.call_count(), 0);
    }

    #[tokio::test]
    async fn recover_interrupted_ticks_releases_stuck_lock_on_boot() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        set_project_tick_enabled_core(&db, "p1", true)
            .await
            .expect("row");
        // Simulate an app crash mid-tick: the lock is left set.
        sqlx::query("UPDATE project_ticker SET in_progress = 1 WHERE project_id = 'p1'")
            .execute(&db)
            .await
            .expect("set in progress");

        let released = recover_interrupted_ticks(&db).await.expect("recover");
        assert_eq!(released, 1, "the stale lock should be released");

        let status = get_project_tick_status_core(&db, "p1")
            .await
            .expect("status");
        assert!(!status.in_progress, "lock cleared → next tick can run");
        assert_eq!(status.last_outcome, Some(TickStatusOutcome::Interrupted));
        // App crash is NOT a governance halt/stall — attention must stay false.
        assert!(!status.attention_required);

        // Idempotent: a second boot with no stuck locks releases nothing.
        let again = recover_interrupted_ticks(&db).await.expect("recover again");
        assert_eq!(again, 0);
    }

    #[tokio::test]
    async fn exit_10_halted_decision_sets_attention_and_is_not_success() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::output(10, halted_report());

        let result = tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");

        assert_eq!(result.outcome, TickStatusOutcome::HaltedDecision);
        assert!(!result.success);
        assert!(result.status.attention_required);
        assert_eq!(result.status.last_exit_code, Some(10));
        assert_eq!(
            result.status.last_outcome,
            Some(TickStatusOutcome::HaltedDecision)
        );
    }

    #[tokio::test]
    async fn exit_0_advanced_persists_status_without_attention() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::output(0, &advanced_report());

        let result = tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");

        assert_eq!(result.outcome, TickStatusOutcome::Advanced);
        assert!(result.success);
        assert!(!result.status.attention_required);
        assert_eq!(result.status.last_exit_code, Some(0));
        assert_eq!(
            result.status.last_outcome,
            Some(TickStatusOutcome::Advanced)
        );
        assert!(result
            .status
            .last_report_json
            .unwrap()
            .contains("\"advanced\""));
    }

    #[tokio::test]
    async fn timeout_persists_terminal_error_and_clears_in_progress() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::sleeping_for(Duration::from_secs(60));

        let result = tick_project_now_with_runner(
            &db,
            "p1",
            runner,
            TickerRunConfig {
                timeout: Duration::from_millis(5),
            },
        )
        .await
        .expect("timeout result");

        assert_eq!(result.outcome, TickStatusOutcome::Timeout);
        assert!(!result.success);
        assert!(!result.status.in_progress);
        assert_eq!(result.status.last_outcome, Some(TickStatusOutcome::Timeout));
    }

    #[tokio::test]
    async fn runner_unavailable_persists_spawn_failed_and_clears_in_progress() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::error(TickerError::Unavailable("node binary not found".into()));

        let result = tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("spawn failure result");

        assert_eq!(result.outcome, TickStatusOutcome::SpawnFailed);
        assert!(!result.success);
        assert!(!result.status.in_progress);
        assert_eq!(
            result.status.last_outcome,
            Some(TickStatusOutcome::SpawnFailed)
        );
    }

    #[tokio::test]
    async fn ticker_settings_persist_and_missing_row_reads_default_disabled() {
        let db = test_db().await;
        seed_project(&db, "p1").await;

        let default = get_project_tick_status_core(&db, "p1")
            .await
            .expect("status");
        assert!(!default.tick_enabled);
        assert_eq!(default.max_steps, 1);

        set_project_tick_enabled_core(&db, "p1", true)
            .await
            .expect("enable");
        set_project_tick_interval_core(&db, "p1", Some(900))
            .await
            .expect("interval");
        let status = get_project_tick_status_core(&db, "p1")
            .await
            .expect("status");
        assert!(status.tick_enabled);
        assert_eq!(status.interval_sec, Some(900));
    }

    #[tokio::test]
    async fn list_project_tick_status_left_joins_all_projects_with_best_effort_autonomy() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_project(&db, "p2").await;
        sqlx::query("UPDATE projects SET name = 'No ticker' WHERE id = 'p2'")
            .execute(&db)
            .await
            .expect("rename project");

        let repo_dir = tempfile::tempdir().expect("temp repo dir");
        std::fs::create_dir_all(repo_dir.path().join(".boule")).expect("create boule dir");
        std::fs::write(
            repo_dir.path().join(".boule").join("boule.config.json"),
            r#"{"schemaVersion":1,"kind":"work","overrides":{"autonomyLevel":"manual","reviewQuorum":1}}"#,
        )
        .expect("write config");
        seed_local_repo(&db, "p1", "r1", repo_dir.path().to_str()).await;

        set_project_tick_enabled_core(&db, "p1", true)
            .await
            .expect("enable ticker");
        set_project_tick_interval_core(&db, "p1", Some(600))
            .await
            .expect("set interval");

        let rows = list_project_tick_status_core(&db)
            .await
            .expect("list ticker rows");

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].project_id, "p1");
        assert_eq!(rows[0].project_name, "Ticker");
        assert!(rows[0].tick_enabled);
        assert_eq!(rows[0].interval_sec, Some(600));
        assert_eq!(rows[0].autonomy_level, Some(BouleAutonomyLevel::Manual));

        assert_eq!(rows[1].project_id, "p2");
        assert_eq!(rows[1].project_name, "No ticker");
        assert!(!rows[1].tick_enabled);
        assert_eq!(rows[1].interval_sec, None);
        assert_eq!(rows[1].max_steps, DEFAULT_MAX_STEPS);
        assert_eq!(rows[1].autonomy_level, None);
    }

    #[tokio::test]
    async fn ticker_does_not_write_governance_events_or_autonomy_level() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::output(10, halted_report());

        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");

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
    }

    #[tokio::test]
    async fn live_toggle_persists_and_flows_into_tick_request() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;

        // Default OFF: request carries live=false.
        let runner = FakeRunner::output(0, &advanced_report());
        let calls = runner.calls.clone();
        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick");
        assert!(!calls.lock().expect("calls")[0].live);

        // Toggle ON → status reflects it and the next tick request carries live=true.
        let status = set_project_tick_live_core(&db, "p1", true)
            .await
            .expect("set live");
        assert!(status.live_enabled);
        let runner = FakeRunner::output(0, &advanced_report());
        let calls = runner.calls.clone();
        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick");
        assert!(calls.lock().expect("calls")[0].live);

        // Toggle OFF again → fail-closed.
        let status = set_project_tick_live_core(&db, "p1", false)
            .await
            .expect("set live");
        assert!(!status.live_enabled);
    }

    async fn ticker_row(db: &Db, project_id: &str) -> (i32, bool, Option<TickStatusOutcome>) {
        sqlx::query_as::<_, (i32, bool, Option<TickStatusOutcome>)>(
            "SELECT consecutive_failures, attention_required, last_outcome \
             FROM project_ticker WHERE project_id = ?1",
        )
        .bind(project_id)
        .fetch_one(db)
        .await
        .expect("ticker row")
    }

    #[tokio::test]
    async fn infra_failures_escalate_to_attention_after_threshold() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;

        for round in 1..=MAX_CONSECUTIVE_INFRA_FAILURES {
            let runner = FakeRunner::error(TickerError::Spawn("boom".into()));
            let result = tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
                .await
                .expect("tick result");
            assert_eq!(result.outcome, TickStatusOutcome::SpawnFailed);
            let (failures, attention, outcome) = ticker_row(&db, "p1").await;
            assert_eq!(failures, round);
            assert_eq!(outcome, Some(TickStatusOutcome::SpawnFailed));
            assert_eq!(
                attention,
                round >= MAX_CONSECUTIVE_INFRA_FAILURES,
                "attention only at the threshold (round {round})"
            );
        }
    }

    #[tokio::test]
    async fn success_resets_failure_streak_and_clears_attention() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        for _ in 0..MAX_CONSECUTIVE_INFRA_FAILURES {
            let runner = FakeRunner::error(TickerError::Spawn("boom".into()));
            tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
                .await
                .expect("tick result");
        }
        let (failures, attention, _) = ticker_row(&db, "p1").await;
        assert_eq!(
            (failures, attention),
            (MAX_CONSECUTIVE_INFRA_FAILURES, true)
        );

        // A manual tick is still allowed with attention raised; success resets the streak.
        let runner = FakeRunner::output(0, &advanced_report());
        let result = tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");
        assert!(result.success);
        let (failures, attention, outcome) = ticker_row(&db, "p1").await;
        assert_eq!((failures, attention), (0, false));
        assert_eq!(outcome, Some(TickStatusOutcome::Advanced));
    }

    #[tokio::test]
    async fn governance_attention_outcome_resets_streak_but_keeps_attention() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::error(TickerError::Spawn("boom".into()));
        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");

        let runner = FakeRunner::output(10, halted_report());
        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");

        let (failures, attention, outcome) = ticker_row(&db, "p1").await;
        assert_eq!((failures, attention), (0, true));
        assert_eq!(outcome, Some(TickStatusOutcome::HaltedDecision));
    }

    #[tokio::test]
    async fn record_auto_tick_dispatch_failure_counts_toward_escalation() {
        let db = test_db().await;
        seed_project(&db, "p1").await;

        for round in 1..=MAX_CONSECUTIVE_INFRA_FAILURES {
            record_auto_tick_dispatch_failure(
                &db,
                "p1",
                &AppError::not_found("ticker.repo_not_found", "no repo"),
            )
            .await
            .expect("record failure");
            let (failures, attention, outcome) = ticker_row(&db, "p1").await;
            assert_eq!(failures, round);
            assert_eq!(outcome, Some(TickStatusOutcome::SpawnFailed));
            assert_eq!(attention, round >= MAX_CONSECUTIVE_INFRA_FAILURES);
        }
    }

    /// P1(a): governance-latched row (halted_decision) → release clears attention but
    /// PRESERVES the latch context (last_outcome/last_report_json) and audit fields.
    #[tokio::test]
    async fn clear_attention_releases_governance_latch_preserving_context() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        let runner = FakeRunner::output(10, halted_report());
        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");
        let before = get_project_tick_status_core(&db, "p1")
            .await
            .expect("status");
        assert!(before.attention_required);

        let status = clear_ticker_attention_core(&db, "p1")
            .await
            .expect("clear attention");

        assert!(!status.attention_required);
        assert_eq!(status.consecutive_failures, 0);
        // Latch context stays visible until the next tick overwrites it.
        assert_eq!(status.last_outcome, Some(TickStatusOutcome::HaltedDecision));
        assert_eq!(status.last_report_json, before.last_report_json);
        assert_eq!(status.last_exit_code, Some(10));
        assert!(!status.in_progress);
    }

    /// P1(a): infra-latched row → release resets the streak so the NEXT failure starts a
    /// fresh bounded-escalation window (counts 1..threshold again) instead of insta-relatching.
    #[tokio::test]
    async fn clear_attention_resets_streak_so_next_failure_relatches_cleanly() {
        let db = test_db().await;
        seed_project(&db, "p1").await;
        seed_local_repo(&db, "p1", "r1", Some("/tmp/repo-a")).await;
        for _ in 0..MAX_CONSECUTIVE_INFRA_FAILURES {
            let runner = FakeRunner::error(TickerError::Spawn("boom".into()));
            tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
                .await
                .expect("tick result");
        }
        let (failures, attention, _) = ticker_row(&db, "p1").await;
        assert_eq!(
            (failures, attention),
            (MAX_CONSECUTIVE_INFRA_FAILURES, true)
        );

        clear_ticker_attention_core(&db, "p1")
            .await
            .expect("clear attention");
        let (failures, attention, _) = ticker_row(&db, "p1").await;
        assert_eq!((failures, attention), (0, false));

        // One failure after release: streak restarts at 1, NO immediate re-latch.
        let runner = FakeRunner::error(TickerError::Spawn("boom".into()));
        tick_project_now_with_runner(&db, "p1", runner, TickerRunConfig::fast())
            .await
            .expect("tick result");
        let (failures, attention, _) = ticker_row(&db, "p1").await;
        assert_eq!((failures, attention), (1, false));
    }

    /// P1(a): unknown project errors; a project without a ticker row gets the default row
    /// (idempotent release — already-clear attention stays clear).
    #[tokio::test]
    async fn clear_attention_validates_project_and_is_idempotent() {
        let db = test_db().await;
        let err = clear_ticker_attention_core(&db, "ghost")
            .await
            .expect_err("unknown project");
        assert_eq!(err.code, "projects.not_found");

        seed_project(&db, "p1").await;
        let status = clear_ticker_attention_core(&db, "p1")
            .await
            .expect("no ticker row yet → default row");
        assert!(!status.attention_required);
        assert_eq!(status.consecutive_failures, 0);
    }
}
