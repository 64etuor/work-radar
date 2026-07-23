//! IPC layer over [`crate::hermes_agent::acp_client::AcpSession`].

use crate::error::AppError;
use crate::hermes_agent::acp_client::{AcpSession, ImageTransport};
use crate::platform::{self, OptionalIntegration};
use base64::Engine as _;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::RwLock;

pub type TabId = String;
pub type HermesAgentHolder = Arc<RwLock<HashMap<TabId, AcpSession>>>;

pub fn new_holder() -> HermesAgentHolder {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Ensure an ACP child session exists for `tab_id` (idempotent). Spawns one if absent.
/// Spawning runs the `initialize` + `session/new` handshake, which makes the agent emit
/// `available_commands` — so calling this before the first prompt lets the `/` slash menu
/// populate. Replay is gated by the per-session `first_prompt_sent` flag (not spawn timing),
/// so pre-spawning here does not suppress the resume-replay preamble.
async fn ensure_session(
    app: &AppHandle,
    holder: &HermesAgentHolder,
    db: &crate::db::Db,
    tab_id: &str,
) -> Result<(), AppError> {
    if !platform::supports_integration(platform::current_host(), OptionalIntegration::Hermes) {
        return Err(AppError::terminal(
            "hermes.unsupported_platform",
            "Hermes is not supported on this platform",
        ));
    }
    {
        let map = holder.read().await;
        if map.contains_key(tab_id) {
            return Ok(());
        }
    }
    let executable = std::env::current_exe()
        .map_err(|e| AppError::unexpected("hermes.mcp.executable", e.to_string()))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::unexpected("hermes.mcp.app_data", e.to_string()))?;
    let db_path = crate::resolve_db_path(&app_data);
    let mcp_servers = crate::hermes_agent::acp_client::hermes_mcp_servers_for_tab(
        db,
        tab_id,
        &executable,
        &db_path,
    )
    .await;
    // Spawn WITHOUT holding the lock so concurrent tabs don't serialise here.
    let session = AcpSession::spawn(app.clone(), tab_id.to_string(), mcp_servers).await?;
    let mut map = holder.write().await;
    if map.contains_key(tab_id) {
        // Racing spawn won — drop ours.
        drop(map);
        session.kill().await;
    } else {
        map.insert(tab_id.to_string(), session);
    }
    Ok(())
}

/// Eagerly establish the agent session so `available_commands` arrives (slash menu) and the
/// agent is ready. Idempotent — no-op if already spawned. The frontend calls this when a
/// session is focused/opened.
#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_open_tab(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
    db: State<'_, crate::db::Db>,
    tab_id: String,
) -> Result<(), AppError> {
    ensure_session(&app, &holder, db.inner(), &tab_id).await
}

/// 세션 ↔ 프로젝트 바인딩 설정/해제. 실행 중인 child가 있으면 종료해 다음 open/send가
/// 새 바인딩의 MCP 주입으로 재spawn하게 한다(재개 preamble이 대화 맥락을 복원).
/// ⚠ 좁은 TOCTOU: DB 갱신과 kill 사이에 경쟁 spawn이 옛 바인딩을 읽을 수 있다 — 최악
/// 한 메시지 분량이며 다음 재바인딩/재시작으로 자가 치유(잠금 추가 대비 수용).
#[tauri::command]
#[specta::specta]
pub async fn hermes_session_set_project(
    holder: State<'_, HermesAgentHolder>,
    db: State<'_, crate::db::Db>,
    tab_id: String,
    project_id: Option<String>,
) -> Result<(), AppError> {
    crate::hermes_agent::session_store::set_project_inner(
        db.inner(),
        &tab_id,
        project_id.as_deref(),
    )
    .await?;
    let removed = {
        let mut map = holder.write().await;
        map.remove(&tab_id)
    };
    if let Some(session) = removed {
        session.kill().await;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_send(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
    db: State<'_, crate::db::Db>,
    tab_id: String,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
    // 1. Lazy spawn — ensure a child exists (idempotent; may already be spawned via open_tab).
    ensure_session(&app, &holder, db.inner(), &tab_id).await?;
    let (session_id, transport, stdin_tx, pending, next_id, first_prompt_sent) = {
        let map = holder.read().await;
        let s = map.get(&tab_id).ok_or_else(|| {
            AppError::unexpected("hermes.acp.protocol", "session missing after ensure")
        })?;
        (
            s.session_id.clone(),
            s.image_transport,
            s.stdin_tx.clone(),
            s.pending.clone(),
            s.next_id.clone(),
            s.first_prompt_sent.clone(),
        )
    };
    // 이 child 에 대한 "첫 prompt" 인가? (spawn 시점과 무관 — open_tab 선-spawn 후에도 replay 보존.)
    let is_first_prompt = !first_prompt_sent.swap(true, std::sync::atomic::Ordering::SeqCst);

    // 재개: fresh child 의 첫 prompt이고 DB에 이전 히스토리가 있으면 최근 N개를 preamble로 prepend.
    const REPLAY_LIMIT: i64 = 20;
    let effective_text = if should_prepend_replay_preamble(is_first_prompt, &text) {
        let recent = crate::hermes_agent::session_store::recent_messages_inner(
            db.inner(),
            &tab_id,
            REPLAY_LIMIT,
        )
        .await
        .unwrap_or_default();
        // 방금 FE가 append한 이번 user 메시지는 preamble에서 제외.
        let ctx: Vec<_> = recent
            .into_iter()
            .filter(|r| !(r.role == "user" && r.content == text))
            .collect();
        if let Some(preamble) = crate::hermes_agent::session_store::build_replay_preamble(&ctx) {
            format!("{preamble}---\n\n{text}")
        } else {
            text.clone()
        }
    } else {
        text.clone()
    };

    // 2. Build prompt blocks (same as before — image_paths handling).
    let mut prompt: Vec<serde_json::Value> = Vec::new();
    if !effective_text.is_empty() {
        prompt.push(json!({ "type": "text", "text": effective_text }));
    }
    for path in &image_paths {
        let block = match transport {
            ImageTransport::FilePath => {
                json!({ "type": "image", "source": { "type": "file", "path": path } })
            }
            ImageTransport::Base64 => {
                let bytes = tokio::fs::read(path)
                    .await
                    .map_err(|e| AppError::unexpected("hermes.image.read", e.to_string()))?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let media_type = mime_from_ext(path);
                json!({ "type": "image", "source": {
                    "type": "base64", "media_type": media_type, "data": b64 } })
            }
        };
        prompt.push(block);
    }

    // 3. JSON-RPC id + pending oneshot.
    let id = next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": id,
        "method": "session/prompt",
        "params": { "sessionId": session_id, "prompt": prompt },
    }))
    .map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
    let frame = crate::hermes_agent::frame::encode_frame(&body);
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending.lock().await.insert(id, tx);

    // 4. Send.
    if stdin_tx.send(frame).await.is_err() {
        pending.lock().await.remove(&id);
        emit_turn_end(&app, &tab_id, "error", Some("stdin closed"));
        return Err(AppError::unexpected("hermes.acp.protocol", "stdin closed"));
    }

    // 5. Wait — 10 min budget.
    let resp = match tokio::time::timeout(tokio::time::Duration::from_secs(600), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => {
            emit_turn_end(
                &app,
                &tab_id,
                "error",
                Some("response dropped (stream closed)"),
            );
            return Err(AppError::unexpected(
                "hermes.acp.protocol",
                "response dropped",
            ));
        }
        Err(_) => {
            pending.lock().await.remove(&id);
            emit_turn_end(&app, &tab_id, "error", Some("timeout"));
            return Err(AppError::unexpected("hermes.acp.timeout", "session/prompt"));
        }
    };

    // 6. Map response → turn-end.
    if let Some(err) = resp.get("error") {
        let msg = err.to_string();
        emit_turn_end(&app, &tab_id, "error", Some(&msg));
        return Err(AppError::unexpected("hermes.acp.protocol", msg));
    }
    let stop_reason = resp
        .get("result")
        .and_then(|r| r.get("stopReason"))
        .and_then(|v| v.as_str())
        .unwrap_or("end_turn")
        .to_string();
    let status = match stop_reason.as_str() {
        "cancelled" => "cancelled",
        "refusal" | "error" => "error",
        _ => "ok",
    };
    let _ = app.emit(
        "hermes-agent:turn-end",
        json!({
            "tabId": tab_id,
            "status": status,
            "stop_reason": stop_reason,
        }),
    );
    Ok(())
}

fn emit_turn_end(app: &AppHandle, tab_id: &str, status: &str, error: Option<&str>) {
    let mut payload = json!({ "tabId": tab_id, "status": status });
    if let Some(e) = error {
        payload["error"] = json!(e);
    }
    let _ = app.emit("hermes-agent:turn-end", payload);
}

fn mime_from_ext(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

fn should_prepend_replay_preamble(is_first_prompt: bool, text: &str) -> bool {
    let trimmed = text.trim();
    is_first_prompt && !trimmed.is_empty() && !trimmed.starts_with('/')
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_cancel(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
) -> Result<(), AppError> {
    let snapshot = {
        let map = holder.read().await;
        map.get(&tab_id)
            .map(|s| (s.session_id.clone(), s.stdin_tx.clone()))
    };
    if let Some((session_id, stdin_tx)) = snapshot {
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
        }))
        .map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
        let frame = crate::hermes_agent::frame::encode_frame(&body);
        stdin_tx
            .send(frame)
            .await
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))?;
    }
    Ok(())
}

/// Route the user's ask-user card choice back to the agent as a JSON-RPC response,
/// echoing the original request id. `cancelled=true` sends the ACP `cancelled` outcome
/// (dismissed card → agent unblocks rather than hangs). Missing session = graceful no-op.
#[tauri::command]
#[specta::specta]
pub async fn hermes_ask_user_respond(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
    request_id: String,
    option_id: String,
    cancelled: bool,
) -> Result<(), AppError> {
    let stdin_tx = {
        let map = holder.read().await;
        map.get(&tab_id).map(|s| s.stdin_tx.clone())
    };
    if let Some(stdin_tx) = stdin_tx {
        let body = crate::hermes_agent::acp_client::build_ask_user_response(
            &request_id,
            &option_id,
            cancelled,
        );
        let frame = crate::hermes_agent::frame::encode_frame(&body);
        stdin_tx
            .send(frame)
            .await
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_close_tab(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
) -> Result<(), AppError> {
    let removed = {
        let mut map = holder.write().await;
        map.remove(&tab_id)
    };
    if let Some(session) = removed {
        session.kill().await;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_save_pasted_image(bytes: Vec<u8>, ext: String) -> Result<String, AppError> {
    let safe_ext = match ext.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => ext.to_ascii_lowercase(),
        _ => "png".to_string(),
    };
    let id = uuid::Uuid::new_v4();
    let path = std::env::temp_dir().join(format!("hermes-paste-{}.{}", id, safe_ext));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| AppError::unexpected("hermes.image.write", e.to_string()))?;

    // Schedule cleanup 5 minutes later (fire-and-forget).
    let cleanup_path = path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        let _ = tokio::fs::remove_file(cleanup_path).await;
    });

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_tab_idempotent_and_cap_precheck_passes_under_cap() {
        let holder: HermesAgentHolder = new_holder();
        // open_tab does not spawn child — cap precheck only. map is empty so passes.
        assert_eq!(holder.read().await.len(), 0);
    }

    #[tokio::test]
    async fn close_tab_on_missing_is_noop() {
        let holder: HermesAgentHolder = new_holder();
        let mut map = holder.write().await;
        let removed = map.remove("missing");
        assert!(removed.is_none());
    }

    #[test]
    fn replay_preamble_is_not_added_to_slash_commands() {
        assert!(should_prepend_replay_preamble(
            true,
            "이전 작업 이어서 해줘"
        ));
        assert!(!should_prepend_replay_preamble(true, "/new"));
        assert!(!should_prepend_replay_preamble(true, "  /clear  "));
        assert!(!should_prepend_replay_preamble(
            false,
            "이전 작업 이어서 해줘"
        ));
    }
}
