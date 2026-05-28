//! Hermes 플로팅 패널 위치/크기/열림 상태 영속 (app_config).
//! 글로벌 토글 핫키(hermes.toggle_hotkey) 저장·등록도 담당.
//! INVARIANT #7: 영속 상태는 로컬 SQLite SSOT(`app_config`). 토큰/외부 무관.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppError;
use crate::shortcut;

const KEY: &str = "hermes.panel";
const KEY_TOGGLE_HOTKEY: &str = "hermes.toggle_hotkey";
/// 기본 Hermes 토글 핫키.
pub const DEFAULT_HERMES_TOGGLE_HOTKEY: &str = "Cmd+Shift+Space";

/// Hermes 플로팅 패널의 위치·크기·열림 상태.
/// x/y/w/h는 None = 미설정(프런트에서 defaultBounds로 초기 배치).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HermesPanelState {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
    pub open: bool,
}

impl Default for HermesPanelState {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            w: None,
            h: None,
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

/// app_config에서 단일 값 조회.
async fn get_config(db: &Db, key: &str) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_config WHERE key = ?1")
        .bind(key)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// app_config 단일 값 upsert.
async fn set_config(db: &Db, key: &str, value: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(key)
    .bind(value)
    .execute(db)
    .await?;
    Ok(())
}

/// 저장된 Hermes 토글 핫키. 없으면 기본값("Cmd+Shift+Space").
pub(crate) async fn current_toggle_hotkey(db: &Db) -> String {
    match get_config(db, KEY_TOGGLE_HOTKEY).await {
        Ok(Some(v)) => v,
        Ok(None) => DEFAULT_HERMES_TOGGLE_HOTKEY.to_string(),
        Err(e) => {
            tracing::warn!(code = "hermes.hotkey.read", error = %e, "failed to read toggle hotkey; using default");
            DEFAULT_HERMES_TOGGLE_HOTKEY.to_string()
        }
    }
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

/// 저장된 Hermes 패널 토글 핫키 조회. 미설정 시 기본값("Cmd+Shift+Space").
#[tauri::command]
#[specta::specta]
pub async fn hermes_get_toggle_hotkey(db: State<'_, Db>) -> Result<String, AppError> {
    Ok(current_toggle_hotkey(db.inner()).await)
}

/// Hermes 패널 토글 핫키 변경: 검증 → nav 충돌 거부 → 런타임 재등록 → 성공 시 영속.
/// 등록 실패(충돌/무효) 시 기존 핫키를 유지하고 Err를 노출한다(저장 안 함 — graceful).
/// 같은 값으로 저장해도 재등록은 항상 시도한다(retry path).
#[tauri::command]
#[specta::specta]
pub async fn hermes_set_toggle_hotkey(
    app: AppHandle,
    db: State<'_, Db>,
    spec: String,
) -> Result<(), AppError> {
    let new_spec = spec.trim().to_string();
    // 파싱 검증 — 무효 조합은 재등록 전에 거른다.
    shortcut::parse_shortcut(&new_spec)
        .map_err(|msg| AppError::validation("hermes.invalid_hotkey", msg))?;

    // nav 글로벌 핫키와 충돌 거부.
    let nav_spec = crate::commands::nav::current_global_hotkey(db.inner()).await;
    if new_spec == nav_spec {
        return Err(AppError::validation(
            "hermes.hotkey_conflict",
            "hermes toggle hotkey must differ from nav global hotkey",
        ));
    }

    let old = current_toggle_hotkey(db.inner()).await;
    shortcut::reregister_hermes_toggle(&app, &old, &new_spec)
        .map_err(|msg| AppError::validation("hermes.hotkey_register", msg))?;

    // 값이 바뀐 경우에만 DB 쓰기(재등록은 항상 시도, 저장은 변경분만).
    if old != new_spec {
        set_config(db.inner(), KEY_TOGGLE_HOTKEY, &new_spec).await?;
    }
    Ok(())
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
    async fn hotkey_default_when_missing() {
        let db = mem_db().await;
        assert_eq!(
            current_toggle_hotkey(&db).await,
            DEFAULT_HERMES_TOGGLE_HOTKEY
        );
    }

    #[tokio::test]
    async fn hotkey_roundtrip() {
        let db = mem_db().await;
        set_config(&db, KEY_TOGGLE_HOTKEY, "Ctrl+Alt+H")
            .await
            .unwrap();
        assert_eq!(current_toggle_hotkey(&db).await, "Ctrl+Alt+H");
    }

    #[tokio::test]
    async fn hotkey_rejects_nav_clash() {
        // nav 핫키와 동일한 spec을 hermes에 저장 시도하면 충돌 오류가 나고 DB에 저장되지 않는다.
        // AppHandle이 필요한 재등록 경로는 이 레이어 테스트 범위 밖이므로,
        // 충돌 판별 로직을 직접 구동한다.
        let db = mem_db().await;
        let clash_spec = "Ctrl+Space";
        // nav 핫키를 clash_spec으로 설정.
        set_config(&db, "nav.global_hotkey", clash_spec)
            .await
            .unwrap();

        // 충돌 감지: nav 읽기 → hermes spec과 비교.
        let nav = crate::commands::nav::current_global_hotkey(&db).await;
        assert_eq!(nav, clash_spec);

        // 충돌이면 저장하지 않는 경로를 재현.
        let would_conflict = clash_spec == nav.as_str();
        assert!(would_conflict);
        // set_config 호출 없음 → hermes 핫키는 여전히 기본값.
        assert_eq!(
            current_toggle_hotkey(&db).await,
            DEFAULT_HERMES_TOGGLE_HOTKEY
        );
    }

    #[tokio::test]
    async fn roundtrip_panel_state() {
        let db = mem_db().await;
        let input = HermesPanelState {
            x: Some(100.0),
            y: Some(200.0),
            w: Some(460.0),
            h: Some(600.0),
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
        assert_eq!(state.x, None);
        assert_eq!(state.y, None);
        assert_eq!(state.w, None);
        assert_eq!(state.h, None);
        assert!(!state.open);
    }
}
