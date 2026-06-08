//! Per-repo Boule autonomy config (`<repo>/.boule/boule.config.json`) — the settings-editable
//! knobs for a designated LOCAL repo. File IO lives in Rust (the renderer never touches the fs);
//! the governance Node package owns the canonical schema (`governance/src/repo/config.ts`), so we
//! mirror ONLY the validated knobs + its stable serializer (recursively sorted keys + 2-space
//! pretty + trailing newline) and preserve any fields we don't edit (projectId/projectName/
//! forbiddenDecisionClasses/allowedType2Actions).
//!
//! These knobs tune POST-acceptance autonomy only: `accept_plan`/`accept_spec` stay HUMAN gates
//! regardless (INVARIANT #1). `auto_plan`/`full` OPEN that gate (test/dev) — the UI warns.

// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(snapshot.rs 등과 동일).
#![allow(clippy::result_large_err)]

use crate::db::Db;
use crate::error::AppError;
use crate::models::{ProjectKind, Provider, Repo};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Graduated autonomy level (mirrors governance `AutonomyLevel`). snake_case → the JSON enum
/// strings `manual|dispatch|auto_plan|full` the governance parser expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BouleAutonomyLevel {
    Manual,
    Dispatch,
    AutoPlan,
    Full,
}

impl BouleAutonomyLevel {
    fn as_str(self) -> &'static str {
        match self {
            BouleAutonomyLevel::Manual => "manual",
            BouleAutonomyLevel::Dispatch => "dispatch",
            BouleAutonomyLevel::AutoPlan => "auto_plan",
            BouleAutonomyLevel::Full => "full",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "manual" => Some(BouleAutonomyLevel::Manual),
            "dispatch" => Some(BouleAutonomyLevel::Dispatch),
            "auto_plan" => Some(BouleAutonomyLevel::AutoPlan),
            "full" => Some(BouleAutonomyLevel::Full),
            _ => None,
        }
    }
}

/// The resolved view shown in Settings. When the config file is absent, `config_exists=false` and
/// the values are the per-kind defaults (so the UI renders a sensible starting point).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BouleConfigSettings {
    pub repo_id: String,
    pub repo_path: String,
    pub config_exists: bool,
    pub kind: ProjectKind,
    pub autonomy_level: BouleAutonomyLevel,
    pub review_quorum: u32,
    pub budget: Option<BouleBudgetCaps>,
    pub backends: Option<BouleBackendsConfig>,
    pub routing: Option<BouleRoutingConfig>,
    pub price_table: Option<BoulePriceTable>,
}

/// Settings write input. Paths are NEVER renderer-supplied — only the repo id; Rust resolves the
/// repo's `local_path` from the DB (defense against a forged path). Advanced nested knobs are raw
/// JSON strings so parsing/validation stays fail-closed in Rust; empty/null unsets the override.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetBouleConfigInput {
    pub repo_id: String,
    pub kind: ProjectKind,
    pub autonomy_level: BouleAutonomyLevel,
    pub review_quorum: u32,
    pub budget: Option<BouleBudgetCaps>,
    pub backends: Option<String>,
    pub routing: Option<String>,
    pub price_table: Option<String>,
}

/// Optional pure budget caps (mirrors governance `BudgetCaps`). Empty/all-None means no budget
/// filtering and is omitted from `overrides.budget` on write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BouleBudgetCaps {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_token_cap: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_token_cap: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_cost_cap_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_cost_cap_usd: Option<f64>,
}

/// Backend provider (mirrors governance `Provider`). `deterministic` is evaluator-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum BouleBackendProvider {
    Claude,
    Codex,
    Command,
    Deterministic,
}

impl BouleBackendProvider {
    fn from_key(key: &str) -> Option<Self> {
        match key {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "command" => Some(Self::Command),
            "deterministic" => Some(Self::Deterministic),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BouleBackendSpec {
    pub provider: BouleBackendProvider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BouleBackendChain {
    pub chain: Vec<BouleBackendSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BouleBackendsConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<BouleBackendChain>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reviewers: Option<Vec<BouleBackendChain>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evaluator: Option<BouleBackendChain>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BouleRoutingByDifficulty {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trivial: Option<BouleBackendSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standard: Option<BouleBackendSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hard: Option<BouleBackendSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BouleRoutingConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<BouleRoutingByDifficulty>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoulePriceEntry {
    pub estimated_tokens: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_per_token_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_per_step_usd: Option<f64>,
}

pub type BoulePriceTable = BTreeMap<String, BTreeMap<String, BoulePriceEntry>>;

/// Per-kind defaults (mirrors governance `WORK_DEFAULTS`/`PERSONAL_DEFAULTS`). work = strict
/// (manual gates, ≥2 review); personal = loose (auto-dispatch, single review).
fn kind_defaults(kind: ProjectKind) -> (BouleAutonomyLevel, u32) {
    match kind {
        ProjectKind::Work => (BouleAutonomyLevel::Manual, 2),
        ProjectKind::Personal => (BouleAutonomyLevel::Dispatch, 1),
    }
}

fn budget_active(budget: &BouleBudgetCaps) -> bool {
    budget.run_token_cap.is_some()
        || budget.step_token_cap.is_some()
        || budget.run_cost_cap_usd.is_some()
        || budget.step_cost_cap_usd.is_some()
}

fn validate_budget(budget: &BouleBudgetCaps) -> Result<(), AppError> {
    let token_caps_ok = budget
        .run_token_cap
        .into_iter()
        .chain(budget.step_token_cap)
        .all(|cap| cap >= 0);
    let cost_caps_ok = budget
        .run_cost_cap_usd
        .into_iter()
        .chain(budget.step_cost_cap_usd)
        .all(|cap| cap.is_finite() && cap >= 0.0);
    if token_caps_ok && cost_caps_ok {
        Ok(())
    } else {
        Err(AppError::validation(
            "boule.budget",
            "budget caps must be non-negative",
        ))
    }
}

#[derive(Debug, Clone, Copy)]
enum BouleBackendRole {
    Executor,
    Reviewer,
    Evaluator,
}

impl BouleBackendRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Executor => "executor",
            Self::Reviewer => "reviewer",
            Self::Evaluator => "evaluator",
        }
    }
}

fn validate_non_empty_opt(value: Option<&String>, field: &str) -> Result<(), String> {
    if value.is_some_and(|s| s.is_empty()) {
        Err(format!("{field} must be non-empty when provided"))
    } else {
        Ok(())
    }
}

fn validate_backend_spec(spec: &BouleBackendSpec, role: BouleBackendRole) -> Result<(), String> {
    validate_non_empty_opt(spec.model.as_ref(), "model")?;
    validate_non_empty_opt(spec.command.as_ref(), "command")?;
    if spec.provider == BouleBackendProvider::Command && spec.command.is_none() {
        return Err("provider 'command' requires a command".into());
    }
    if spec.provider == BouleBackendProvider::Deterministic
        && !matches!(role, BouleBackendRole::Evaluator)
    {
        return Err(format!(
            "backend 'deterministic' is not allowed for role '{}' (evaluator only)",
            role.as_str()
        ));
    }
    Ok(())
}

fn validate_backend_chain(role: BouleBackendRole, chain: &BouleBackendChain) -> Result<(), String> {
    if chain.chain.is_empty() {
        return Err(format!(
            "{} backend chain must contain at least one backend",
            role.as_str()
        ));
    }
    for spec in &chain.chain {
        validate_backend_spec(spec, role)?;
    }
    Ok(())
}

fn backends_active(backends: &BouleBackendsConfig) -> bool {
    backends.executor.is_some()
        || backends
            .reviewers
            .as_ref()
            .is_some_and(|reviewers| !reviewers.is_empty())
        || backends.evaluator.is_some()
}

fn validate_backends(backends: &BouleBackendsConfig) -> Result<(), AppError> {
    if let Some(chain) = &backends.executor {
        validate_backend_chain(BouleBackendRole::Executor, chain)
            .map_err(|msg| AppError::validation("boule.backends", msg))?;
    }
    if let Some(reviewers) = &backends.reviewers {
        for chain in reviewers {
            validate_backend_chain(BouleBackendRole::Reviewer, chain)
                .map_err(|msg| AppError::validation("boule.backends", msg))?;
        }
    }
    if let Some(chain) = &backends.evaluator {
        validate_backend_chain(BouleBackendRole::Evaluator, chain)
            .map_err(|msg| AppError::validation("boule.backends", msg))?;
    }
    Ok(())
}

fn routing_active(routing: &BouleRoutingConfig) -> bool {
    routing
        .executor
        .as_ref()
        .is_some_and(|r| r.trivial.is_some() || r.standard.is_some() || r.hard.is_some())
}

fn validate_routing(routing: &BouleRoutingConfig) -> Result<(), AppError> {
    if let Some(executor) = &routing.executor {
        for spec in [&executor.trivial, &executor.standard, &executor.hard]
            .into_iter()
            .flatten()
        {
            validate_backend_spec(spec, BouleBackendRole::Executor)
                .map_err(|msg| AppError::validation("boule.routing", msg))?;
        }
    }
    Ok(())
}

fn price_table_active(price_table: &BoulePriceTable) -> bool {
    price_table.values().any(|models| !models.is_empty())
}

fn validate_price_table(price_table: &BoulePriceTable) -> Result<(), AppError> {
    for (provider, models) in price_table {
        if provider.is_empty() {
            return Err(AppError::validation(
                "boule.price_table",
                "priceTable provider keys must be non-empty",
            ));
        }
        if BouleBackendProvider::from_key(provider).is_none() {
            return Err(AppError::validation(
                "boule.price_table",
                format!("unknown provider '{provider}'"),
            ));
        }
        for (model, entry) in models {
            if model.is_empty() {
                return Err(AppError::validation(
                    "boule.price_table",
                    "priceTable model keys must be non-empty",
                ));
            }
            let token_ok = entry.estimated_tokens.is_finite() && entry.estimated_tokens >= 0.0;
            let token_cost_ok = entry
                .cost_per_token_usd
                .is_none_or(|cost| cost.is_finite() && cost >= 0.0);
            let step_cost_ok = entry
                .cost_per_step_usd
                .is_none_or(|cost| cost.is_finite() && cost >= 0.0);
            let has_cost = entry.cost_per_token_usd.is_some() || entry.cost_per_step_usd.is_some();
            if !(token_ok && token_cost_ok && step_cost_ok && has_cost) {
                return Err(AppError::validation(
                    "boule.price_table",
                    "price entry requires non-negative estimatedTokens and costPerTokenUsd or costPerStepUsd",
                ));
            }
        }
    }
    Ok(())
}

fn parse_raw_override<T>(raw: Option<&String>, code: &str) -> Result<Option<T>, AppError>
where
    T: DeserializeOwned,
{
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(raw).map(Some).map_err(|e| {
        AppError::validation(
            code,
            format!(
                "invalid JSON for {}: {e}",
                code.strip_prefix("boule.").unwrap_or(code)
            ),
        )
    })
}

fn parse_value_override<T>(
    value: Option<&serde_json::Value>,
    code: &str,
) -> Result<Option<T>, AppError>
where
    T: DeserializeOwned,
{
    let Some(value) = value else {
        return Ok(None);
    };
    serde_json::from_value(value.clone())
        .map(Some)
        .map_err(|e| AppError::terminal(code, e.to_string()))
}

fn parse_backends_raw(raw: Option<&String>) -> Result<Option<BouleBackendsConfig>, AppError> {
    let backends = parse_raw_override(raw, "boule.backends")?;
    if let Some(backends) = &backends {
        validate_backends(backends)?;
    }
    Ok(backends.filter(backends_active))
}

fn parse_routing_raw(raw: Option<&String>) -> Result<Option<BouleRoutingConfig>, AppError> {
    let routing = parse_raw_override(raw, "boule.routing")?;
    if let Some(routing) = &routing {
        validate_routing(routing)?;
    }
    Ok(routing.filter(routing_active))
}

fn parse_price_table_raw(raw: Option<&String>) -> Result<Option<BoulePriceTable>, AppError> {
    let price_table = parse_raw_override(raw, "boule.price_table")?;
    if let Some(price_table) = &price_table {
        validate_price_table(price_table)?;
    }
    Ok(price_table.filter(price_table_active))
}

fn parse_budget_value(
    value: Option<&serde_json::Value>,
) -> Result<Option<BouleBudgetCaps>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let budget: BouleBudgetCaps = serde_json::from_value(value.clone())
        .map_err(|e| AppError::terminal("boule.config_budget", e.to_string()))?;
    validate_budget(&budget)?;
    Ok(budget_active(&budget).then_some(budget))
}

fn parse_backends_value(
    value: Option<&serde_json::Value>,
) -> Result<Option<BouleBackendsConfig>, AppError> {
    let backends = parse_value_override(value, "boule.config_backends")?;
    if let Some(backends) = &backends {
        validate_backends(backends)?;
    }
    Ok(backends.filter(backends_active))
}

fn parse_routing_value(
    value: Option<&serde_json::Value>,
) -> Result<Option<BouleRoutingConfig>, AppError> {
    let routing = parse_value_override(value, "boule.config_routing")?;
    if let Some(routing) = &routing {
        validate_routing(routing)?;
    }
    Ok(routing.filter(routing_active))
}

fn parse_price_table_value(
    value: Option<&serde_json::Value>,
) -> Result<Option<BoulePriceTable>, AppError> {
    let price_table = parse_value_override(value, "boule.config_price_table")?;
    if let Some(price_table) = &price_table {
        validate_price_table(price_table)?;
    }
    Ok(price_table.filter(price_table_active))
}

const REPO_COLS: &str =
    "id, project_id, provider, remote_url, local_path, default_branch, enabled, created_at";

async fn fetch_repo(db: &Db, repo_id: &str) -> Result<Repo, AppError> {
    sqlx::query_as::<_, Repo>(&format!("SELECT {REPO_COLS} FROM repos WHERE id = ?1"))
        .bind(repo_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("repos.not_found", "repo not found"))
}

/// A designated local repo's on-disk config path. Rejects non-local repos (only local repos get a
/// `.boule` sidecar) and repos without a `local_path`.
fn local_repo_dir(repo: &Repo) -> Result<PathBuf, AppError> {
    if repo.provider != Provider::Local {
        return Err(AppError::validation(
            "boule.repo_not_local",
            "Boule config is only available for local repos",
        ));
    }
    let path = repo
        .local_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            AppError::validation("boule.repo_no_path", "local repo has no local_path")
        })?;
    Ok(PathBuf::from(path))
}

fn config_path(repo_dir: &std::path::Path) -> PathBuf {
    repo_dir.join(".boule").join("boule.config.json")
}

async fn fetch_project_kind(db: &Db, project_id: &str) -> Result<ProjectKind, AppError> {
    sqlx::query_scalar::<_, ProjectKind>("SELECT kind FROM projects WHERE id = ?1")
        .bind(project_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))
}

/// Recursively sort object keys so serialized output is byte-stable (matches governance
/// `sortKeysDeep`), independent of serde_json's map-ordering feature.
fn sort_value(v: serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(m) => {
            let sorted: BTreeMap<String, Value> =
                m.into_iter().map(|(k, val)| (k, sort_value(val))).collect();
            Value::Object(sorted.into_iter().collect())
        }
        Value::Array(a) => Value::Array(a.into_iter().map(sort_value).collect()),
        other => other,
    }
}

/// Stable pretty JSON (recursively sorted keys + trailing newline) — clean diffs whether the file
/// is edited by the CLI (`boule set`) or this UI.
fn serialize_config(v: &serde_json::Value) -> Result<String, AppError> {
    let pretty = serde_json::to_string_pretty(&sort_value(v.clone()))
        .map_err(|e| AppError::unexpected("boule.serialize", e.to_string()))?;
    Ok(pretty + "\n")
}

/// Read the resolved settings for a repo. Absent file ⇒ `config_exists=false` + per-(project)kind
/// defaults. A malformed file is a terminal error (don't silently mask a corrupt config).
pub(crate) async fn get_boule_config_core(
    db: &Db,
    repo_id: &str,
) -> Result<BouleConfigSettings, AppError> {
    let repo = fetch_repo(db, repo_id).await?;
    let dir = local_repo_dir(&repo)?;
    let path = config_path(&dir);

    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let val: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| AppError::terminal("boule.config_parse", e.to_string()))?;
            let kind: ProjectKind =
                serde_json::from_value(val.get("kind").cloned().unwrap_or(serde_json::Value::Null))
                    .map_err(|e| AppError::terminal("boule.config_kind", e.to_string()))?;
            let (def_level, def_quorum) = kind_defaults(kind);
            let overrides = val.get("overrides");
            let autonomy_level = overrides
                .and_then(|o| o.get("autonomyLevel"))
                .and_then(|l| l.as_str())
                .and_then(BouleAutonomyLevel::from_str)
                .unwrap_or(def_level);
            let review_quorum = overrides
                .and_then(|o| o.get("reviewQuorum"))
                .and_then(|q| q.as_u64())
                .map(|q| q as u32)
                .filter(|q| *q >= 1)
                .unwrap_or(def_quorum);
            let budget = parse_budget_value(overrides.and_then(|o| o.get("budget")))?;
            let backends = parse_backends_value(overrides.and_then(|o| o.get("backends")))?;
            let routing = parse_routing_value(overrides.and_then(|o| o.get("routing")))?;
            let price_table = parse_price_table_value(overrides.and_then(|o| o.get("priceTable")))?;
            Ok(BouleConfigSettings {
                repo_id: repo.id,
                repo_path: dir.to_string_lossy().into_owned(),
                config_exists: true,
                kind,
                autonomy_level,
                review_quorum,
                budget,
                backends,
                routing,
                price_table,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No sidecar yet — show the project's kind + its defaults as the starting point.
            let kind = fetch_project_kind(db, &repo.project_id).await?;
            let (autonomy_level, review_quorum) = kind_defaults(kind);
            Ok(BouleConfigSettings {
                repo_id: repo.id,
                repo_path: dir.to_string_lossy().into_owned(),
                config_exists: false,
                kind,
                autonomy_level,
                review_quorum,
                budget: None,
                backends: None,
                routing: None,
                price_table: None,
            })
        }
        Err(e) => Err(AppError::terminal("boule.config_read", e.to_string())),
    }
}

/// Write the editable knobs, preserving any fields this UI doesn't manage. Validates reviewQuorum
/// (≥1) and writes atomically (tmp + rename) with the stable serializer.
pub(crate) async fn set_boule_config_core(
    db: &Db,
    input: &SetBouleConfigInput,
) -> Result<BouleConfigSettings, AppError> {
    if input.review_quorum < 1 {
        return Err(AppError::validation(
            "boule.review_quorum",
            "reviewQuorum must be >= 1",
        ));
    }
    if let Some(budget) = &input.budget {
        validate_budget(budget)?;
    }
    let next_backends = parse_backends_raw(input.backends.as_ref())?;
    let next_routing = parse_routing_raw(input.routing.as_ref())?;
    let next_price_table = parse_price_table_raw(input.price_table.as_ref())?;
    let repo = fetch_repo(db, &input.repo_id).await?;
    let dir = local_repo_dir(&repo)?;
    let boule_dir = dir.join(".boule");
    let path = config_path(&dir);

    // Start from the existing file (preserve projectId/projectName/other overrides) or a fresh
    // schemaVersion:1 object seeded with the DB project metadata.
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| AppError::terminal("boule.config_parse", e.to_string()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut seed = serde_json::Map::new();
            seed.insert("schemaVersion".into(), serde_json::json!(1));
            seed.insert("projectId".into(), serde_json::json!(repo.project_id));
            serde_json::Value::Object(seed)
        }
        Err(e) => return Err(AppError::terminal("boule.config_read", e.to_string())),
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| AppError::terminal("boule.config_shape", "config root is not an object"))?;
    obj.insert("schemaVersion".into(), serde_json::json!(1));
    obj.insert(
        "kind".into(),
        serde_json::to_value(input.kind)
            .map_err(|e| AppError::unexpected("boule.serialize", e.to_string()))?,
    );
    // Merge into overrides (keep forbiddenDecisionClasses / allowedType2Actions if present).
    let overrides = obj
        .entry("overrides")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let ov = overrides
        .as_object_mut()
        .ok_or_else(|| AppError::terminal("boule.config_shape", "overrides is not an object"))?;
    ov.insert(
        "autonomyLevel".into(),
        serde_json::json!(input.autonomy_level.as_str()),
    );
    ov.insert(
        "reviewQuorum".into(),
        serde_json::json!(input.review_quorum),
    );
    match input.budget.as_ref().filter(|budget| budget_active(budget)) {
        Some(budget) => {
            ov.insert(
                "budget".into(),
                serde_json::to_value(budget)
                    .map_err(|e| AppError::unexpected("boule.serialize", e.to_string()))?,
            );
        }
        None => {
            ov.remove("budget");
        }
    }
    match next_backends.as_ref() {
        Some(backends) => {
            ov.insert(
                "backends".into(),
                serde_json::to_value(backends)
                    .map_err(|e| AppError::unexpected("boule.serialize", e.to_string()))?,
            );
        }
        None => {
            ov.remove("backends");
        }
    }
    match next_routing.as_ref() {
        Some(routing) => {
            ov.insert(
                "routing".into(),
                serde_json::to_value(routing)
                    .map_err(|e| AppError::unexpected("boule.serialize", e.to_string()))?,
            );
        }
        None => {
            ov.remove("routing");
        }
    }
    match next_price_table.as_ref() {
        Some(price_table) => {
            ov.insert(
                "priceTable".into(),
                serde_json::to_value(price_table)
                    .map_err(|e| AppError::unexpected("boule.serialize", e.to_string()))?,
            );
        }
        None => {
            ov.remove("priceTable");
        }
    }

    let body = serialize_config(&root)?;
    std::fs::create_dir_all(&boule_dir)
        .map_err(|e| AppError::terminal("boule.config_mkdir", e.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body)
        .map_err(|e| AppError::terminal("boule.config_write", e.to_string()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|e| AppError::terminal("boule.config_rename", e.to_string()))?;

    Ok(BouleConfigSettings {
        repo_id: repo.id,
        repo_path: dir.to_string_lossy().into_owned(),
        config_exists: true,
        kind: input.kind,
        autonomy_level: input.autonomy_level,
        review_quorum: input.review_quorum,
        budget: input.budget.clone().filter(budget_active),
        backends: next_backends,
        routing: next_routing,
        price_table: next_price_table,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::projects::{insert_project, insert_repo};
    use crate::commands::shared::test_support::{fresh_db, project_input};
    use crate::models::CreateRepoInput;

    fn repo_lit(provider: Provider, local_path: Option<&str>) -> Repo {
        Repo {
            id: "repo1".into(),
            project_id: "proj1".into(),
            provider,
            remote_url: None,
            local_path: local_path.map(|s| s.to_string()),
            default_branch: "main".into(),
            enabled: true,
            created_at: "2026-06-07".into(),
        }
    }

    #[test]
    fn serialize_is_sorted_with_trailing_newline() {
        let v = serde_json::json!({
            "kind": "work",
            "schemaVersion": 1,
            "overrides": { "reviewQuorum": 2, "autonomyLevel": "manual" },
        });
        let out = serialize_config(&v).unwrap();
        assert!(out.ends_with("}\n"), "trailing newline");
        let (k, o, s) = (
            out.find("\"kind\"").unwrap(),
            out.find("\"overrides\"").unwrap(),
            out.find("\"schemaVersion\"").unwrap(),
        );
        assert!(k < o && o < s, "top-level keys sorted");
        assert!(
            out.find("\"autonomyLevel\"").unwrap() < out.find("\"reviewQuorum\"").unwrap(),
            "override keys sorted"
        );
    }

    #[test]
    fn autonomy_level_str_roundtrip() {
        for (lvl, s) in [
            (BouleAutonomyLevel::Manual, "manual"),
            (BouleAutonomyLevel::Dispatch, "dispatch"),
            (BouleAutonomyLevel::AutoPlan, "auto_plan"),
            (BouleAutonomyLevel::Full, "full"),
        ] {
            assert_eq!(lvl.as_str(), s);
            assert_eq!(BouleAutonomyLevel::from_str(s), Some(lvl));
        }
        assert_eq!(BouleAutonomyLevel::from_str("yolo"), None);
    }

    #[test]
    fn kind_defaults_match_governance() {
        assert!(matches!(
            kind_defaults(ProjectKind::Work),
            (BouleAutonomyLevel::Manual, 2)
        ));
        assert!(matches!(
            kind_defaults(ProjectKind::Personal),
            (BouleAutonomyLevel::Dispatch, 1)
        ));
    }

    #[test]
    fn local_repo_dir_rejects_github_and_pathless() {
        assert_eq!(
            local_repo_dir(&repo_lit(Provider::Github, Some("/x")))
                .unwrap_err()
                .code,
            "boule.repo_not_local"
        );
        assert_eq!(
            local_repo_dir(&repo_lit(Provider::Local, None))
                .unwrap_err()
                .code,
            "boule.repo_no_path"
        );
        assert!(local_repo_dir(&repo_lit(Provider::Local, Some("/x"))).is_ok());
    }

    async fn local_repo_with_dir(db: &Db, kind: ProjectKind, dir: &std::path::Path) -> String {
        let proj = insert_project(db, &project_input("Acme", kind))
            .await
            .unwrap();
        let repo = insert_repo(
            db,
            &CreateRepoInput {
                project_id: proj.id,
                provider: Provider::Local,
                remote_url: None,
                local_path: Some(dir.to_string_lossy().into_owned()),
                default_branch: None,
            },
        )
        .await
        .unwrap();
        repo.id
    }

    #[tokio::test]
    async fn roundtrip_absent_defaults_then_set_then_read() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let repo_id = local_repo_with_dir(&db, ProjectKind::Work, dir.path()).await;

        // absent file ⇒ per-(project)kind defaults, config_exists=false
        let g0 = get_boule_config_core(&db, &repo_id).await.unwrap();
        assert!(!g0.config_exists);
        assert!(matches!(g0.kind, ProjectKind::Work));
        assert!(matches!(g0.autonomy_level, BouleAutonomyLevel::Manual));
        assert_eq!(g0.review_quorum, 2);

        // set full / quorum 3
        let s = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Work,
                autonomy_level: BouleAutonomyLevel::Full,
                review_quorum: 3,
                budget: None,
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap();
        assert!(s.config_exists);

        // file written with the stable serializer
        let text =
            std::fs::read_to_string(dir.path().join(".boule").join("boule.config.json")).unwrap();
        assert!(text.contains("\"autonomyLevel\": \"full\""));
        assert!(text.contains("\"reviewQuorum\": 3"));
        assert!(text.ends_with("}\n"));

        // read back reflects the write
        let g1 = get_boule_config_core(&db, &repo_id).await.unwrap();
        assert!(g1.config_exists);
        assert!(matches!(g1.autonomy_level, BouleAutonomyLevel::Full));
        assert_eq!(g1.review_quorum, 3);
    }

    #[tokio::test]
    async fn roundtrip_budget_caps_and_clear_removes_budget() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let repo_id = local_repo_with_dir(&db, ProjectKind::Personal, dir.path()).await;

        let s = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Personal,
                autonomy_level: BouleAutonomyLevel::Dispatch,
                review_quorum: 1,
                budget: Some(BouleBudgetCaps {
                    run_token_cap: Some(50_000),
                    step_token_cap: None,
                    run_cost_cap_usd: Some(2.5),
                    step_cost_cap_usd: Some(0.75),
                }),
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            s.budget,
            Some(BouleBudgetCaps {
                run_token_cap: Some(50_000),
                step_token_cap: None,
                run_cost_cap_usd: Some(2.5),
                step_cost_cap_usd: Some(0.75),
            })
        );

        let text =
            std::fs::read_to_string(dir.path().join(".boule").join("boule.config.json")).unwrap();
        assert!(text.contains("\"budget\""));
        assert!(text.contains("\"runCostCapUsd\": 2.5"));
        assert!(text.contains("\"runTokenCap\": 50000"));
        assert!(!text.contains("stepTokenCap"));

        let g = get_boule_config_core(&db, &repo_id).await.unwrap();
        assert_eq!(
            g.budget.as_ref().and_then(|b| b.run_token_cap),
            Some(50_000)
        );
        assert_eq!(
            g.budget.as_ref().and_then(|b| b.run_cost_cap_usd),
            Some(2.5)
        );

        let cleared = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Personal,
                autonomy_level: BouleAutonomyLevel::Dispatch,
                review_quorum: 1,
                budget: None,
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(cleared.budget, None);

        let text =
            std::fs::read_to_string(dir.path().join(".boule").join("boule.config.json")).unwrap();
        assert!(!text.contains("\"budget\""));
        assert_eq!(
            get_boule_config_core(&db, &repo_id).await.unwrap().budget,
            None
        );
    }

    #[tokio::test]
    async fn roundtrip_advanced_overrides_and_clear_removes_them() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let repo_id = local_repo_with_dir(&db, ProjectKind::Work, dir.path()).await;

        let backends = r#"{
          "executor": { "chain": [{ "provider": "claude", "model": "claude-sonnet-4-5" }] },
          "reviewers": [{ "chain": [{ "provider": "codex", "model": "gpt-5-codex-small" }] }],
          "evaluator": { "chain": [{ "provider": "deterministic" }] }
        }"#;
        let routing = r#"{
          "executor": {
            "standard": { "provider": "codex", "model": "gpt-5-codex-small" },
            "hard": { "provider": "command", "command": "boule-eval", "args": ["--json"] }
          }
        }"#;
        let price_table = r#"{
          "claude": {
            "default": { "estimatedTokens": 20000, "costPerStepUsd": 0.2 }
          },
          "codex": {
            "gpt-5-codex-small": { "estimatedTokens": 2000, "costPerTokenUsd": 0.000005 }
          }
        }"#;

        let s = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Work,
                autonomy_level: BouleAutonomyLevel::Manual,
                review_quorum: 2,
                budget: None,
                backends: Some(backends.into()),
                routing: Some(routing.into()),
                price_table: Some(price_table.into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            s.backends
                .as_ref()
                .and_then(|b| b.executor.as_ref())
                .and_then(|c| c.chain.first())
                .map(|spec| spec.model.as_deref()),
            Some(Some("claude-sonnet-4-5"))
        );
        assert_eq!(
            s.routing
                .as_ref()
                .and_then(|r| r.executor.as_ref())
                .and_then(|r| r.standard.as_ref())
                .map(|spec| spec.provider),
            Some(BouleBackendProvider::Codex)
        );
        assert_eq!(
            s.price_table
                .as_ref()
                .and_then(|table| table.get("claude"))
                .and_then(|models| models.get("default"))
                .map(|entry| entry.estimated_tokens),
            Some(20_000.0)
        );

        let path = dir.path().join(".boule").join("boule.config.json");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"backends\""));
        assert!(text.contains("\"priceTable\""));
        assert!(text.contains("\"costPerStepUsd\": 0.2"));
        assert!(text.contains("\"standard\""));
        assert!(!text.contains("price_table"));

        let g = get_boule_config_core(&db, &repo_id).await.unwrap();
        assert_eq!(g.backends, s.backends);
        assert_eq!(g.routing, s.routing);
        assert_eq!(g.price_table, s.price_table);

        let cleared = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Work,
                autonomy_level: BouleAutonomyLevel::Manual,
                review_quorum: 2,
                budget: None,
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(cleared.backends, None);
        assert_eq!(cleared.routing, None);
        assert_eq!(cleared.price_table, None);

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("\"backends\""));
        assert!(!text.contains("\"routing\""));
        assert!(!text.contains("\"priceTable\""));
    }

    #[tokio::test]
    async fn set_rejects_invalid_advanced_overrides_without_writing() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let repo_id = local_repo_with_dir(&db, ProjectKind::Work, dir.path()).await;

        set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Work,
                autonomy_level: BouleAutonomyLevel::Manual,
                review_quorum: 2,
                budget: None,
                backends: Some(
                    r#"{"executor":{"chain":[{"provider":"claude","model":"ok"}]}}"#.into(),
                ),
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap();

        let path = dir.path().join(".boule").join("boule.config.json");
        let before = std::fs::read_to_string(&path).unwrap();
        let e = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id,
                kind: ProjectKind::Work,
                autonomy_level: BouleAutonomyLevel::Manual,
                review_quorum: 2,
                budget: None,
                backends: Some(r#"{"executor":{"chain":[{"provider":"deterministic"}]}}"#.into()),
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "boule.backends");
        assert!(
            e.message.contains("deterministic"),
            "error should explain the rejected provider"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[tokio::test]
    async fn set_rejects_bad_json_and_invalid_price_entry_without_writing() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let repo_id = local_repo_with_dir(&db, ProjectKind::Personal, dir.path()).await;

        set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Personal,
                autonomy_level: BouleAutonomyLevel::Dispatch,
                review_quorum: 1,
                budget: None,
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap();

        let path = dir.path().join(".boule").join("boule.config.json");
        let before = std::fs::read_to_string(&path).unwrap();
        let bad_json = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: repo_id.clone(),
                kind: ProjectKind::Personal,
                autonomy_level: BouleAutonomyLevel::Dispatch,
                review_quorum: 1,
                budget: None,
                backends: Some("{".into()),
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(bad_json.code, "boule.backends");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        let invalid_price = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id,
                kind: ProjectKind::Personal,
                autonomy_level: BouleAutonomyLevel::Dispatch,
                review_quorum: 1,
                budget: None,
                backends: None,
                routing: None,
                price_table: Some(r#"{"claude":{"default":{"estimatedTokens":1000}}}"#.into()),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(invalid_price.code, "boule.price_table");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[tokio::test]
    async fn set_rejects_negative_budget_caps() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let repo_id = local_repo_with_dir(&db, ProjectKind::Work, dir.path()).await;

        let e = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id,
                kind: ProjectKind::Work,
                autonomy_level: BouleAutonomyLevel::Manual,
                review_quorum: 2,
                budget: Some(BouleBudgetCaps {
                    run_token_cap: Some(-1),
                    step_token_cap: None,
                    run_cost_cap_usd: None,
                    step_cost_cap_usd: None,
                }),
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "boule.budget");
    }

    #[tokio::test]
    async fn set_rejects_quorum_zero_and_get_rejects_github() {
        let db = fresh_db().await;
        let dir = tempfile::tempdir().unwrap();
        let local_id = local_repo_with_dir(&db, ProjectKind::Personal, dir.path()).await;

        let e = set_boule_config_core(
            &db,
            &SetBouleConfigInput {
                repo_id: local_id,
                kind: ProjectKind::Personal,
                autonomy_level: BouleAutonomyLevel::Dispatch,
                review_quorum: 0,
                budget: None,
                backends: None,
                routing: None,
                price_table: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, "boule.review_quorum");

        let proj = insert_project(&db, &project_input("Gh", ProjectKind::Work))
            .await
            .unwrap();
        let gh = insert_repo(
            &db,
            &CreateRepoInput {
                project_id: proj.id,
                provider: Provider::Github,
                remote_url: Some("https://github.com/x/y".into()),
                local_path: None,
                default_branch: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            get_boule_config_core(&db, &gh.id).await.unwrap_err().code,
            "boule.repo_not_local"
        );
    }
}
