//! Codex 에이전트 설정 — app_config 영속. (INVARIANT #7: SQLite SSOT, 비밀 아님)
//! 모델 문자열은 keychain 불필요(비밀이 아닌 설정값) — app_config upsert로 저장한다.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tauri::State;
use tokio::process::Command;

use crate::commands::nav::{get_config, set_config};
use crate::commands::skills::{seed_in_app_skills, FAST_CODEX_MODEL};
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    AgentPromptConfig, AgentReasoningEffort, CodexModelCatalog, CodexModelOption,
    UpdateAgentPromptConfigInput,
};

const KEY_CODEX_MODEL: &str = "agent.codex_model";
const KEY_CODEX_MODEL_CATALOG: &str = "agent.codex_model_catalog";
const AGENT_NAME_PREFIX: &str = "agent.name.";
const CODEX_MODELS_TIMEOUT: Duration = Duration::from_secs(20);

/// `agent.name.<sessionKey>` app_config 키. sessionKey는 박스 안정 key(`run:<id>` 등).
/// per-machine 표시 라벨일 뿐 — 결정 레일(#1)/상태 SSOT(signals, #7)와 무관.
fn agent_name_key(session_key: &str) -> String {
    format!("{AGENT_NAME_PREFIX}{session_key}")
}

/// 저장된 Codex 모델 문자열(없으면 None → 기본 동작 유지).
#[tauri::command]
#[specta::specta]
pub async fn get_codex_model(db: State<'_, Db>) -> Result<Option<String>, AppError> {
    Ok(get_config(db.inner(), KEY_CODEX_MODEL).await?)
}

/// Codex 모델 설정(또는 None으로 삭제 → 기본 동작 복원).
/// None 또는 빈 문자열이면 저장 행을 삭제한다.
#[tauri::command]
#[specta::specta]
pub async fn set_codex_model(db: State<'_, Db>, model: Option<String>) -> Result<(), AppError> {
    match model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => Ok(set_config(db.inner(), KEY_CODEX_MODEL, m).await?),
        None => {
            sqlx::query("DELETE FROM app_config WHERE key = ?1")
                .bind(KEY_CODEX_MODEL)
                .execute(db.inner())
                .await?;
            Ok(())
        }
    }
}

fn fallback_model_catalog(source: &str) -> CodexModelCatalog {
    CodexModelCatalog {
        models: vec![
            CodexModelOption {
                slug: "gpt-5.5".to_string(),
                display_name: "GPT-5.5".to_string(),
                default_reasoning_level: Some(AgentReasoningEffort::Medium),
                supported_reasoning_levels: vec![
                    AgentReasoningEffort::Low,
                    AgentReasoningEffort::Medium,
                    AgentReasoningEffort::High,
                    AgentReasoningEffort::Xhigh,
                ],
                supports_fast: true,
            },
            CodexModelOption {
                slug: FAST_CODEX_MODEL.to_string(),
                display_name: FAST_CODEX_MODEL.to_string(),
                default_reasoning_level: Some(AgentReasoningEffort::Low),
                supported_reasoning_levels: vec![AgentReasoningEffort::Low],
                supports_fast: false,
            },
        ],
        cached_at: chrono::Utc::now().to_rfc3339(),
        source: source.to_string(),
    }
}

fn parse_reasoning(value: Option<&str>) -> Option<AgentReasoningEffort> {
    value.and_then(|v| v.parse().ok())
}

pub(crate) fn parse_codex_model_catalog(raw: &str) -> Result<CodexModelCatalog, String> {
    let root: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("codex model catalog JSON parse failed: {e}"))?;
    let models = root
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "codex model catalog missing models[]".to_string())?;

    let mut out = Vec::new();
    for item in models {
        let slug = item
            .get("slug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if slug.is_empty() {
            continue;
        }
        if item
            .get("visibility")
            .and_then(|v| v.as_str())
            .is_some_and(|v| v != "list")
        {
            continue;
        }
        let display_name = item
            .get("display_name")
            .and_then(|v| v.as_str())
            .unwrap_or(slug)
            .to_string();
        let default_reasoning_level =
            parse_reasoning(item.get("default_reasoning_level").and_then(|v| v.as_str()));
        let supported_reasoning_levels = item
            .get("supported_reasoning_levels")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
            .filter_map(|v| parse_reasoning(v.get("effort").and_then(|e| e.as_str())))
            .collect::<Vec<_>>();
        let supports_fast = item
            .get("additional_speed_tiers")
            .and_then(|v| v.as_array())
            .is_some_and(|tiers| tiers.iter().any(|t| t.as_str() == Some("fast")))
            || item
                .get("service_tiers")
                .and_then(|v| v.as_array())
                .is_some_and(|tiers| {
                    tiers
                        .iter()
                        .any(|t| t.get("id").and_then(|id| id.as_str()) == Some("priority"))
                });
        out.push(CodexModelOption {
            slug: slug.to_string(),
            display_name,
            default_reasoning_level,
            supported_reasoning_levels,
            supports_fast,
        });
    }
    if out.is_empty() {
        return Err("codex model catalog returned no listable models".to_string());
    }
    Ok(CodexModelCatalog {
        models: out,
        cached_at: chrono::Utc::now().to_rfc3339(),
        source: "codex debug models".to_string(),
    })
}

async fn load_codex_model_catalog(codex_bin: &Path) -> Result<CodexModelCatalog, String> {
    let output = tokio::time::timeout(
        CODEX_MODELS_TIMEOUT,
        Command::new(codex_bin)
            .args(["debug", "models"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| "codex debug models timed out".to_string())?
    .map_err(|e| format!("codex debug models spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "codex debug models failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_codex_model_catalog(&String::from_utf8_lossy(&output.stdout))
}

pub(crate) async fn cache_codex_model_catalog_on_startup(db: &Db, codex_bin: Option<&Path>) {
    let catalog = match codex_bin {
        Some(bin) => load_codex_model_catalog(bin)
            .await
            .unwrap_or_else(|_| fallback_model_catalog("fallback")),
        None => fallback_model_catalog("fallback"),
    };
    if let Ok(raw) = serde_json::to_string(&catalog) {
        let _ = set_config(db, KEY_CODEX_MODEL_CATALOG, &raw).await;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn get_codex_model_catalog(db: State<'_, Db>) -> Result<CodexModelCatalog, AppError> {
    if let Some(raw) = get_config(db.inner(), KEY_CODEX_MODEL_CATALOG).await? {
        if let Ok(catalog) = serde_json::from_str::<CodexModelCatalog>(&raw) {
            return Ok(catalog);
        }
    }
    Ok(fallback_model_catalog("fallback"))
}

pub(crate) async fn resolve_codex_model_for_prompt(
    db: &Db,
    prompt_model: Option<String>,
    fast_mode: bool,
) -> Option<String> {
    if let Some(model) = prompt_model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
    {
        return Some(model);
    }
    if fast_mode {
        return Some(FAST_CODEX_MODEL.to_string());
    }
    get_config(db, KEY_CODEX_MODEL).await.ok().flatten()
}

#[tauri::command]
#[specta::specta]
pub async fn list_agent_prompt_configs(
    db: State<'_, Db>,
) -> Result<Vec<AgentPromptConfig>, AppError> {
    seed_in_app_skills(db.inner()).await?;
    let rows = sqlx::query_as::<_, AgentPromptConfig>(
        "SELECT id, name, binding, COALESCE(prompt, '') AS prompt, enabled, model, reasoning_effort, fast_mode, updated_at \
         FROM skills \
         WHERE kind = 'in_app_prompt' AND binding IS NOT NULL \
         ORDER BY binding, name",
    )
    .fetch_all(db.inner())
    .await?;
    Ok(rows)
}

#[tauri::command]
#[specta::specta]
pub async fn update_agent_prompt_config(
    db: State<'_, Db>,
    input: UpdateAgentPromptConfigInput,
) -> Result<AgentPromptConfig, AppError> {
    let name = input.name.trim();
    let prompt = input.prompt.trim();
    if name.is_empty() {
        return Err(AppError::validation(
            "agents.prompt_name_empty",
            "프롬프트 이름이 비었습니다.",
        ));
    }
    if prompt.is_empty() {
        return Err(AppError::validation(
            "agents.prompt_empty",
            "프롬프트가 비었습니다.",
        ));
    }
    let model = input
        .model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    let row = sqlx::query_as::<_, AgentPromptConfig>(
        "UPDATE skills SET \
            name = ?2, \
            prompt = ?3, \
            enabled = ?4, \
            model = ?5, \
            reasoning_effort = ?6, \
            fast_mode = ?7, \
            updated_at = datetime('now') \
         WHERE id = ?1 AND kind = 'in_app_prompt' AND binding IS NOT NULL \
         RETURNING id, name, binding, COALESCE(prompt, '') AS prompt, enabled, model, reasoning_effort, fast_mode, updated_at",
    )
    .bind(&input.id)
    .bind(name)
    .bind(prompt)
    .bind(input.enabled)
    .bind(model)
    .bind(input.reasoning_effort)
    .bind(input.fast_mode)
    .fetch_optional(db.inner())
    .await?
    .ok_or_else(|| AppError::not_found("agents.prompt_not_found", "내부 프롬프트를 찾을 수 없습니다."))?;
    Ok(row)
}

/// 박스의 사용자 지정 이름(없으면 None → 호출부가 기본 라벨 fallback).
#[tauri::command]
#[specta::specta]
pub async fn get_agent_name(
    db: State<'_, Db>,
    session_key: String,
) -> Result<Option<String>, AppError> {
    Ok(get_config(db.inner(), &agent_name_key(&session_key)).await?)
}

/// 박스 이름 설정(또는 None/빈 문자열 → 저장 행 삭제 → 기본 라벨 복원).
#[tauri::command]
#[specta::specta]
pub async fn set_agent_name(
    db: State<'_, Db>,
    session_key: String,
    name: Option<String>,
) -> Result<(), AppError> {
    let key = agent_name_key(&session_key);
    match name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => Ok(set_config(db.inner(), &key, n).await?),
        None => {
            sqlx::query("DELETE FROM app_config WHERE key = ?1")
                .bind(&key)
                .execute(db.inner())
                .await?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn codex_model_round_trip() {
        let db = fresh_db().await;
        // 미설정 → None.
        assert!(get_config(&db, KEY_CODEX_MODEL).await.unwrap().is_none());
        // 저장.
        set_config(&db, KEY_CODEX_MODEL, "claude-opus-4-5")
            .await
            .unwrap();
        assert_eq!(
            get_config(&db, KEY_CODEX_MODEL).await.unwrap().as_deref(),
            Some("claude-opus-4-5")
        );
        // 덮어쓰기.
        set_config(&db, KEY_CODEX_MODEL, "claude-sonnet-4-5")
            .await
            .unwrap();
        assert_eq!(
            get_config(&db, KEY_CODEX_MODEL).await.unwrap().as_deref(),
            Some("claude-sonnet-4-5")
        );
        // 삭제(DELETE).
        sqlx::query("DELETE FROM app_config WHERE key = ?1")
            .bind(KEY_CODEX_MODEL)
            .execute(&db)
            .await
            .unwrap();
        assert!(get_config(&db, KEY_CODEX_MODEL).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn agent_name_round_trip() {
        let db = fresh_db().await;
        let key = agent_name_key("run:42");
        assert_eq!(key, "agent.name.run:42");
        // 미설정 → None.
        assert!(get_config(&db, &key).await.unwrap().is_none());
        // 저장.
        set_config(&db, &key, "내 에이전트").await.unwrap();
        assert_eq!(
            get_config(&db, &key).await.unwrap().as_deref(),
            Some("내 에이전트")
        );
        // 덮어쓰기(재시작 후 복원과 동일 경로).
        set_config(&db, &key, "renamed").await.unwrap();
        assert_eq!(
            get_config(&db, &key).await.unwrap().as_deref(),
            Some("renamed")
        );
        // 삭제(빈 이름 → DELETE → 기본 라벨 fallback).
        sqlx::query("DELETE FROM app_config WHERE key = ?1")
            .bind(&key)
            .execute(&db)
            .await
            .unwrap();
        assert!(get_config(&db, &key).await.unwrap().is_none());
    }
}
