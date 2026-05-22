use tauri::State;

use crate::db::Db;
use crate::models::{PingResult, TokenKind, TokenStatus};
use crate::{api, keychain};

// ── 토큰 (keychain 경유 — 토큰 본문은 절대 반환하지 않는다, INVARIANT) ──────────

/// project의 keychain 분리 키. 토큰 커맨드들이 공유한다.
pub(crate) async fn project_credential_ref(db: &Db, project_id: &str) -> Result<String, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT credential_ref FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.map(|r| r.0)
        .ok_or_else(|| "project not found".to_string())
}

/// 토큰 저장. 토큰은 IPC 인자로만 들어와 즉시 keychain으로 가고, 반환되지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn set_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
    token: String,
) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("empty token".into());
    }
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    keychain::set_token(&cref, kind, token).map_err(|e| e.to_string())
}

/// 토큰 삭제(클리어).
#[tauri::command]
#[specta::specta]
pub async fn delete_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
) -> Result<(), String> {
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    keychain::delete_token(&cref, kind).map_err(|e| e.to_string())
}

/// 토큰 존재 여부만 (본문 미노출). UI 마스킹 표시용.
#[tauri::command]
#[specta::specta]
pub async fn project_token_status(
    db: State<'_, Db>,
    project_id: String,
) -> Result<TokenStatus, String> {
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    Ok(TokenStatus {
        has_notion: keychain::has_token(&cref, TokenKind::Notion).map_err(|e| e.to_string())?,
        has_github: keychain::has_token(&cref, TokenKind::Github).map_err(|e| e.to_string())?,
    })
}

/// 토큰으로 외부 API ping(read-only). 토큰은 keychain에서 읽어 Rust 안에서만 쓰인다.
#[tauri::command]
#[specta::specta]
pub async fn ping_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
) -> Result<PingResult, String> {
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    let token = keychain::get_token(&cref, kind).map_err(|e| e.to_string())?;
    let Some(token) = token else {
        return Ok(PingResult {
            ok: false,
            detail: "토큰 없음".into(),
        });
    };
    Ok(match kind {
        TokenKind::Notion => api::ping_notion(&token).await,
        TokenKind::Github => api::ping_github(&token).await,
        // GoogleCalendar는 OAuth blob이라 단순 ping 대상이 아님 — 연결은 google_calendar_status로.
        TokenKind::GoogleCalendar => PingResult {
            ok: false,
            detail: "Google Calendar는 '연결' 흐름을 사용하세요".into(),
        },
    })
}
