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
}

/// Settings write input. Paths are NEVER renderer-supplied — only the repo id; Rust resolves the
/// repo's `local_path` from the DB (defense against a forged path).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetBouleConfigInput {
    pub repo_id: String,
    pub kind: ProjectKind,
    pub autonomy_level: BouleAutonomyLevel,
    pub review_quorum: u32,
}

/// Per-kind defaults (mirrors governance `WORK_DEFAULTS`/`PERSONAL_DEFAULTS`). work = strict
/// (manual gates, ≥2 review); personal = loose (auto-dispatch, single review).
fn kind_defaults(kind: ProjectKind) -> (BouleAutonomyLevel, u32) {
    match kind {
        ProjectKind::Work => (BouleAutonomyLevel::Manual, 2),
        ProjectKind::Personal => (BouleAutonomyLevel::Dispatch, 1),
    }
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
            Ok(BouleConfigSettings {
                repo_id: repo.id,
                repo_path: dir.to_string_lossy().into_owned(),
                config_exists: true,
                kind,
                autonomy_level,
                review_quorum,
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
