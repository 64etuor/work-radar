//! Hermes 플로팅 패널 위치/크기/열림 상태 영속 (app_config).
//! INVARIANT #7: 영속 상태는 로컬 SQLite SSOT(`app_config`). 토큰/외부 무관.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::error::AppError;

const KEY: &str = "hermes.panel";

/// Hermes 플로팅 패널의 위치·크기·열림 상태.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesPanelState {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub open: bool,
}

impl Default for HermesPanelState {
    fn default() -> Self {
        HermesPanelState {
            x: 0.0,
            y: 0.0,
            w: 460.0,
            h: 600.0,
            open: false,
        }
    }
}

/// app_config에서 패널 상태 조회. 없으면 Default 반환.
async fn get_state(db: &Db) -> Result<HermesPanelState, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_config WHERE key = ?1")
        .bind(KEY)
        .fetch_optional(db)
        .await?;
    match row {
        None => Ok(HermesPanelState::default()),
        Some((json,)) => serde_json::from_str(&json)
            .map_err(|e| AppError::unexpected("hermes.panel.json", e.to_string())),
    }
}

/// app_config에 패널 상태 upsert.
async fn set_state(db: &Db, state: &HermesPanelState) -> Result<(), AppError> {
    let json = serde_json::to_string(state)
        .map_err(|e| AppError::unexpected("hermes.panel.json", e.to_string()))?;
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(KEY)
    .bind(json)
    .execute(db)
    .await?;
    Ok(())
}

/// 저장된 Hermes 패널 상태 조회. 미설정 시 기본값 반환.
#[tauri::command]
#[specta::specta]
pub async fn hermes_panel_state_get(db: State<'_, Db>) -> Result<HermesPanelState, AppError> {
    get_state(db.inner()).await
}

/// Hermes 패널 상태 저장.
#[tauri::command]
#[specta::specta]
pub async fn hermes_panel_state_set(
    db: State<'_, Db>,
    state: HermesPanelState,
) -> Result<(), AppError> {
    set_state(db.inner(), &state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn mem_db() -> Db {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE app_config (\
             key TEXT PRIMARY KEY, \
             value TEXT NOT NULL, \
             updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn roundtrip_panel_state() {
        let db = mem_db().await;
        let input = HermesPanelState {
            x: 100.0,
            y: 200.0,
            w: 500.0,
            h: 700.0,
            open: true,
        };
        set_state(&db, &input).await.unwrap();
        let got = get_state(&db).await.unwrap();
        assert_eq!(got, input);
    }

    #[tokio::test]
    async fn default_when_missing() {
        let db = mem_db().await;
        let state = get_state(&db).await.unwrap();
        assert!(!state.open);
        assert!(state.w >= 360.0);
        assert!(state.h >= 320.0);
    }
}
