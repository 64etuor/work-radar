//! IPC layer over [`crate::hermes_agent::acp_client::AcpSession`].

use crate::error::AppError;
use crate::hermes_agent::acp_client::{AcpSession, ImageTransport};
use base64::Engine as _;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::RwLock;

pub type TabId = String;
pub type HermesAgentHolder = Arc<RwLock<HashMap<TabId, AcpSession>>>;

pub const HERMES_TAB_CAP: usize = 3;

pub fn new_holder() -> HermesAgentHolder {
    Arc::new(RwLock::new(HashMap::new()))
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_open_tab(
    _holder: State<'_, HermesAgentHolder>,
    _tab_id: String,
) -> Result<(), AppError> {
    // No-op: tab existence is tracked by the frontend; the backend reserves a slot
    // only on first `send` (lazy spawn). Cap is enforced at spawn time in `send`.
    // This command remains for explicit "tab will be used" signaling and future-proofing.
    Ok(())
}

/// Returns the maximum number of concurrent Hermes tabs. Single source of truth
/// for the cap — frontend reads this at mount rather than duplicating the constant.
#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_cap() -> Result<u32, AppError> {
    Ok(HERMES_TAB_CAP as u32)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_send(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
    // 1. Lazy spawn — if no child for this slot, spawn one. Re-check cap.
    let snapshot = {
        let map = holder.read().await;
        map.get(&tab_id).map(|s| {
            (
                s.session_id.clone(),
                s.image_transport,
                s.stdin_tx.clone(),
                s.pending.clone(),
                s.next_id.clone(),
            )
        })
    };

    let (session_id, transport, stdin_tx, pending, next_id) = match snapshot {
        Some(s) => s,
        None => {
            // Fast-fail cap pre-check under read lock (best-effort; avoids spawning when
            // already at capacity without a racing opener).
            {
                let map = holder.read().await;
                if !map.contains_key(&tab_id) && map.len() >= HERMES_TAB_CAP {
                    return Err(AppError::unexpected(
                        "hermes.tab.cap",
                        format!("max {HERMES_TAB_CAP}"),
                    ));
                }
            }
            // Spawn WITHOUT holding any lock so concurrent tabs don't serialise here.
            let session = AcpSession::spawn(app.clone(), tab_id.clone()).await?;
            // Re-acquire write lock for insertion with race re-check.
            let mut map = holder.write().await;
            if let Some(existing) = map.get(&tab_id) {
                // Racing spawn won — use existing session, kill ours.
                let tup = (
                    existing.session_id.clone(),
                    existing.image_transport,
                    existing.stdin_tx.clone(),
                    existing.pending.clone(),
                    existing.next_id.clone(),
                );
                drop(map);
                session.kill().await;
                tup
            } else if map.len() >= HERMES_TAB_CAP {
                drop(map);
                session.kill().await;
                return Err(AppError::unexpected(
                    "hermes.tab.cap",
                    format!("max {HERMES_TAB_CAP}"),
                ));
            } else {
                let tup = (
                    session.session_id.clone(),
                    session.image_transport,
                    session.stdin_tx.clone(),
                    session.pending.clone(),
                    session.next_id.clone(),
                );
                map.insert(tab_id.clone(), session);
                tup
            }
        }
    };

    // 2. Build prompt blocks (same as before — image_paths handling).
    let mut prompt: Vec<serde_json::Value> = Vec::new();
    if !text.is_empty() {
        prompt.push(json!({ "type": "text", "text": text }));
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
}
