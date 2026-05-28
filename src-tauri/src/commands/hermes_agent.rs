//! IPC layer over [`crate::hermes_agent::acp_client::AcpSession`].

use crate::error::AppError;
use crate::hermes_agent::acp_client::{AcpSession, ImageTransport};
use base64::Engine as _;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub type HermesAgentHolder = Arc<Mutex<Option<AcpSession>>>;

pub fn new_holder() -> HermesAgentHolder {
    Arc::new(Mutex::new(None))
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_start(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
) -> Result<(), AppError> {
    let mut guard = holder.lock().await;
    if let Some(session) = guard.as_ref() {
        // Already started — re-emit session-ready so late frontend listeners
        // (mounted after the original spawn) can pick up the live session.
        let _ = app.emit(
            "hermes-agent:session-ready",
            json!({ "session_id": &session.session_id }),
        );
        return Ok(());
    }
    let session = AcpSession::spawn(app).await?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_send(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
    // 1. Snapshot all needed fields under brief lock, then release before I/O.
    let (session_id, transport, stdin_tx, pending, next_id) = {
        let guard = holder.lock().await;
        let s = guard
            .as_ref()
            .ok_or_else(|| AppError::unexpected("hermes.acp.protocol", "session not started"))?;
        (
            s.session_id.clone(),
            s.image_transport,
            s.stdin_tx.clone(),
            s.pending.clone(),
            s.next_id.clone(),
        )
    };

    // 2. Build prompt blocks — file I/O happens here, lock already released.
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
                json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": b64 } })
            }
        };
        prompt.push(block);
    }

    // 3. Allocate a JSON-RPC id and register a oneshot in pending.
    let id = next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": { "sessionId": session_id, "prompt": prompt },
    }))
    .map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
    let frame = crate::hermes_agent::frame::encode_frame(&body);

    let (tx, rx) = tokio::sync::oneshot::channel();
    pending.lock().await.insert(id, tx);

    // 4. Send the framed request.
    if stdin_tx.send(frame).await.is_err() {
        pending.lock().await.remove(&id);
        let _ = app.emit(
            "hermes-agent:turn-end",
            json!({ "status": "error", "error": "stdin closed" }),
        );
        return Err(AppError::unexpected("hermes.acp.protocol", "stdin closed"));
    }

    // 5. Wait for the response — model turns can take many seconds; 10 min budget.
    let resp = match tokio::time::timeout(tokio::time::Duration::from_secs(600), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => {
            let _ = app.emit(
                "hermes-agent:turn-end",
                json!({ "status": "error", "error": "response dropped (stream closed)" }),
            );
            return Err(AppError::unexpected(
                "hermes.acp.protocol",
                "response dropped",
            ));
        }
        Err(_) => {
            pending.lock().await.remove(&id);
            let _ = app.emit(
                "hermes-agent:turn-end",
                json!({ "status": "error", "error": "timeout" }),
            );
            return Err(AppError::unexpected("hermes.acp.timeout", "session/prompt"));
        }
    };

    // 6. Extract result / error, map stopReason, emit turn-end.
    if let Some(err) = resp.get("error") {
        let msg = err.to_string();
        let _ = app.emit(
            "hermes-agent:turn-end",
            json!({ "status": "error", "error": msg.clone() }),
        );
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
        json!({ "status": status, "stop_reason": stop_reason }),
    );

    Ok(())
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
pub async fn hermes_agent_cancel(holder: State<'_, HermesAgentHolder>) -> Result<(), AppError> {
    // Snapshot then drop lock before sending — allows send to proceed concurrently.
    let snapshot = {
        let guard = holder.lock().await;
        guard
            .as_ref()
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

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_stop(holder: State<'_, HermesAgentHolder>) -> Result<(), AppError> {
    let mut guard = holder.lock().await;
    if let Some(session) = guard.take() {
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
