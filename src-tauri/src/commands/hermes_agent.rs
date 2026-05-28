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
    let guard = holder.lock().await;
    let session = guard
        .as_ref()
        .ok_or_else(|| AppError::unexpected("hermes.acp.protocol", "session not started"))?;

    let mut prompt: Vec<serde_json::Value> = Vec::new();
    if !text.is_empty() {
        prompt.push(json!({ "type": "text", "text": text }));
    }

    for path in &image_paths {
        let block = match session.image_transport {
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

    let params = json!({
        "sessionId": session.session_id,
        "prompt": prompt,
    });
    session.notify("session/prompt", params).await
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
    let guard = holder.lock().await;
    if let Some(session) = guard.as_ref() {
        session
            .notify("session/cancel", json!({ "sessionId": session.session_id }))
            .await?;
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
