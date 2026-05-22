//! 네비게이션 설정 (Phase 18 #7): 글로벌 창 핫키 + 메뉴별 단축키 keymap.
//! INVARIANT #7: 영속 상태는 로컬 SQLite SSOT(`app_config`). 토큰/외부 무관(키 조합 문자열뿐).
//! 글로벌 핫키 재등록은 bounded·graceful — 충돌/무효 시 옛 핫키 유지 + Err 노출(shortcut.rs).
//!
//! keymap(view→shortcut)은 렌더러가 의미를 소유한다 — Rust는 JSON blob을 영속/조회만 한다
//! (per-view 단축키 적용은 입력 포커스 컨텍스트가 필요해 프런트에서 처리).

use tauri::{AppHandle, State};

use crate::db::Db;
use crate::error::AppError;
use crate::shortcut::{self, DEFAULT_GLOBAL_HOTKEY};

/// app_config 단일 값 조회. 없으면 None.
pub(crate) async fn get_config(db: &Db, key: &str) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM app_config WHERE key = ?1")
        .bind(key)
        .fetch_optional(db)
        .await?;
    Ok(row.map(|(v,)| v))
}

/// app_config 단일 값 upsert.
pub(crate) async fn set_config(db: &Db, key: &str, value: &str) -> Result<(), sqlx::Error> {
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

const KEY_GLOBAL_HOTKEY: &str = "nav.global_hotkey";
const KEY_KEYMAP: &str = "nav.keymap";

/// 저장된 글로벌 핫키(없으면 기본 Ctrl+Space). startup 등록부와 Settings 표시에 공용.
pub(crate) async fn current_global_hotkey(db: &Db) -> String {
    get_config(db, KEY_GLOBAL_HOTKEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| DEFAULT_GLOBAL_HOTKEY.to_string())
}

/// 현재 글로벌 창 핫키 문자열 조회(Settings 표시용). 미설정 시 기본값.
#[tauri::command]
#[specta::specta]
pub async fn get_global_hotkey(db: State<'_, Db>) -> Result<String, AppError> {
    Ok(current_global_hotkey(db.inner()).await)
}

/// 글로벌 창 핫키 변경: 검증 → 런타임 재등록(옛 unregister → 새 register) → 성공 시 영속.
/// 등록 실패(충돌/무효) 시 옛 핫키를 유지하고 Err를 노출한다(저장 안 함 — graceful, #5 정신).
#[tauri::command]
#[specta::specta]
pub async fn set_global_hotkey(
    app: AppHandle,
    db: State<'_, Db>,
    spec: String,
) -> Result<(), AppError> {
    let new_spec = spec.trim().to_string();
    // 빠른 검증(저장 거부) — 무효 조합은 재등록 시도 전에 거른다.
    shortcut::parse_shortcut(&new_spec)
        .map_err(|msg| AppError::validation("nav.invalid_hotkey", msg))?;

    let old = current_global_hotkey(db.inner()).await;
    // 같은 값이면 재등록 불필요(이미 등록됨).
    if old != new_spec {
        shortcut::reregister(&app, &old, &new_spec)
            .map_err(|msg| AppError::validation("nav.hotkey_register", msg))?;
    }
    Ok(set_config(db.inner(), KEY_GLOBAL_HOTKEY, &new_spec).await?)
}

/// 글로벌 핫키를 기본값(Ctrl+Space)으로 리셋 + 재등록.
#[tauri::command]
#[specta::specta]
pub async fn reset_global_hotkey(app: AppHandle, db: State<'_, Db>) -> Result<String, AppError> {
    let old = current_global_hotkey(db.inner()).await;
    if old != DEFAULT_GLOBAL_HOTKEY {
        shortcut::reregister(&app, &old, DEFAULT_GLOBAL_HOTKEY)
            .map_err(|msg| AppError::validation("nav.hotkey_register", msg))?;
    }
    set_config(db.inner(), KEY_GLOBAL_HOTKEY, DEFAULT_GLOBAL_HOTKEY).await?;
    Ok(DEFAULT_GLOBAL_HOTKEY.to_string())
}

/// 저장된 per-view keymap(JSON 문자열) 조회. 미설정 시 None — 프런트가 기본 keymap을 쓴다.
#[tauri::command]
#[specta::specta]
pub async fn get_nav_keymap(db: State<'_, Db>) -> Result<Option<String>, AppError> {
    Ok(get_config(db.inner(), KEY_KEYMAP).await?)
}

/// per-view keymap(JSON 문자열) 저장. 렌더러가 view→shortcut 의미를 소유 — Rust는 blob 영속만.
/// 비어 있지 않은 JSON 객체 문자열만 받는다(가벼운 검증).
#[tauri::command]
#[specta::specta]
pub async fn set_nav_keymap(db: State<'_, Db>, keymap_json: String) -> Result<(), AppError> {
    let trimmed = keymap_json.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') {
        return Err(AppError::validation(
            "nav.invalid_keymap",
            "keymap은 비어있지 않은 JSON 객체여야 합니다",
        ));
    }
    Ok(set_config(db.inner(), KEY_KEYMAP, trimmed).await?)
}

/// keymap을 기본값으로 리셋(저장 행 삭제 → 프런트가 코드 상수 기본 keymap 사용).
#[tauri::command]
#[specta::specta]
pub async fn reset_nav_keymap(db: State<'_, Db>) -> Result<(), AppError> {
    sqlx::query("DELETE FROM app_config WHERE key = ?1")
        .bind(KEY_KEYMAP)
        .execute(db.inner())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn hotkey_defaults_then_persists() {
        let db = fresh_db().await;
        // 미설정 → 기본값.
        assert_eq!(current_global_hotkey(&db).await, DEFAULT_GLOBAL_HOTKEY);
        // 저장 → 라운드트립.
        set_config(&db, KEY_GLOBAL_HOTKEY, "Cmd+Shift+Space")
            .await
            .unwrap();
        assert_eq!(current_global_hotkey(&db).await, "Cmd+Shift+Space");
    }

    #[tokio::test]
    async fn keymap_upsert_and_reset() {
        let db = fresh_db().await;
        assert!(get_config(&db, KEY_KEYMAP).await.unwrap().is_none());
        set_config(&db, KEY_KEYMAP, r#"{"board":"g b"}"#)
            .await
            .unwrap();
        assert_eq!(
            get_config(&db, KEY_KEYMAP).await.unwrap().as_deref(),
            Some(r#"{"board":"g b"}"#)
        );
        // 덮어쓰기.
        set_config(&db, KEY_KEYMAP, r#"{"board":"1"}"#)
            .await
            .unwrap();
        assert_eq!(
            get_config(&db, KEY_KEYMAP).await.unwrap().as_deref(),
            Some(r#"{"board":"1"}"#)
        );
    }
}
