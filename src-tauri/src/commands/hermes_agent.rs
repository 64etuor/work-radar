//! IPC layer over [`crate::hermes_agent::acp_client::AcpSession`].

use crate::error::AppError;
use crate::hermes_agent::acp_client::{AcpSession, ImageTransport};
use base64::Engine as _;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, State};
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
    if guard.is_some() {
        return Ok(()); // idempotent
    }
    let session = AcpSession::spawn(app).await?;
    *guard = Some(session);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_send(
    holder: State<'_, HermesAgentHolder>,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
    // Snapshot only what we need, then release the lock before any I/O.
    let (session_id, transport, stdin_tx) = {
        let guard = holder.lock().await;
        let s = guard
            .as_ref()
            .ok_or_else(|| AppError::unexpected("hermes.acp.protocol", "session not started"))?;
        (s.session_id.clone(), s.image_transport, s.stdin_tx.clone())
    };

    // Build prompt blocks — file I/O happens here, lock already released.
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

    // Encode + send via the cloned stdin_tx — no holder lock needed.
    let params = json!({ "sessionId": session_id, "prompt": prompt });
    let body = serde_json::to_vec(
        &json!({ "jsonrpc": "2.0", "method": "session/prompt", "params": params }),
    )
    .map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
    let frame = crate::hermes_agent::frame::encode_frame(&body);
    stdin_tx
        .send(frame)
        .await
        .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))
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
