//! Codex 에이전트 설정 — app_config 영속. (INVARIANT #7: SQLite SSOT, 비밀 아님)
//! 모델 문자열은 keychain 불필요(비밀이 아닌 설정값) — app_config upsert로 저장한다.

use tauri::State;

use crate::commands::nav::{get_config, set_config};
use crate::db::Db;
use crate::error::AppError;

const KEY_CODEX_MODEL: &str = "agent.codex_model";
const AGENT_NAME_PREFIX: &str = "agent.name.";

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
