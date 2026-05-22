//! Codex 에이전트 설정 — app_config 영속. (INVARIANT #7: SQLite SSOT, 비밀 아님)
//! 모델 문자열은 keychain 불필요(비밀이 아닌 설정값) — app_config upsert로 저장한다.

use tauri::State;

use crate::commands::nav::{get_config, set_config};
use crate::db::Db;

const KEY_CODEX_MODEL: &str = "agent.codex_model";

/// 저장된 Codex 모델 문자열(없으면 None → 기본 동작 유지).
#[tauri::command]
#[specta::specta]
pub async fn get_codex_model(db: State<'_, Db>) -> Result<Option<String>, String> {
    get_config(db.inner(), KEY_CODEX_MODEL)
        .await
        .map_err(|e| e.to_string())
}

/// Codex 모델 설정(또는 None으로 삭제 → 기본 동작 복원).
/// None 또는 빈 문자열이면 저장 행을 삭제한다.
#[tauri::command]
#[specta::specta]
pub async fn set_codex_model(db: State<'_, Db>, model: Option<String>) -> Result<(), String> {
    match model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => set_config(db.inner(), KEY_CODEX_MODEL, m)
            .await
            .map_err(|e| e.to_string()),
        None => {
            sqlx::query("DELETE FROM app_config WHERE key = ?1")
                .bind(KEY_CODEX_MODEL)
                .execute(db.inner())
                .await
                .map_err(|e| e.to_string())?;
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
}
