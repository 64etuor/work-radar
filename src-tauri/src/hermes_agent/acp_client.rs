//! ACP (Agent Client Protocol) session over NDJSON stdio.
//!
//! # Wire-format evidence (2026-05-28 probe + acp v0.11.2 schema)
//!
//! ## session/new
//! Required params: `{ "cwd": "<path>", "mcpServers": [] }`.
//! `mcpServers` is required (pydantic field-required validation error if omitted).
//!
//! ## session/update notification shape
//! ```json
//! {
//!   "jsonrpc": "2.0",
//!   "method": "session/update",
//!   "params": {
//!     "sessionId": "<uuid>",
//!     "update": {
//!       "sessionUpdate": "<discriminator>",
//!       ... update-specific fields ...
//!     }
//!   }
//! }
//! ```
//! The discriminator is in `params.update.sessionUpdate` (NOT `params.sessionUpdate`).
//!
//! ## All known sessionUpdate discriminators (acp/schema.py v0.11.2)
//! - `available_commands_update` — `update.availableCommands: [{name, description?}]` (probe-confirmed)
//! - `usage_update`             — `update.{size, used}` (probe-confirmed)
//! - `agent_message_chunk`      — `update.content.{type:"text", text: str}` (schema-confirmed)
//! - `user_message_chunk`       — same ContentChunk shape (schema-confirmed, not yet observed live)
//! - `agent_thought_chunk`      — same ContentChunk shape (schema-confirmed)
//! - `tool_call`                — `update.{toolCallId, title, kind?, status?, ...}` (schema-confirmed)
//! - `tool_call_update`         — same ToolCall shape (schema-confirmed)
//! - `plan`                     — `update.{entries:[{title,status,priority}]}` (schema-confirmed)
//! - `session_info_update`      — session metadata update (schema-confirmed)
//! - `current_mode_update`      — mode switch notification (schema-confirmed)
//! - `config_option_update`     — config change notification (schema-confirmed)
//!
//! ## Tauri events emitted
//! - `hermes-agent:session-ready`    — `{ session_id: str }`
//! - `hermes-agent:available-commands` — `{ commands: [{name, description?}] }`
//! - `hermes-agent:chunk`            — `{ kind: "agent"|"user"|"thought", text: str }`
//! - `hermes-agent:tool-call`        — `{ tool_call_id, title, kind?, status?, session_update }`
//! - `hermes-agent:tool-call-update` — same shape as tool-call
//! - `hermes-agent:plan`             — `{ entries: [{title, status, priority}] }`
//! - `hermes-agent:error`            — `{ kind: str, message: str }`

use crate::error::AppError;
use crate::hermes_agent::frame::{encode_frame, read_frame};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use specta::Type;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};

// C3 will construct these; suppress dead_code until then.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AcpCommand {
    pub name: String,
    pub description: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageTransport {
    FilePath,
    Base64,
}

// C3 will construct and use AcpSession; suppress dead_code until then.
#[allow(dead_code)]
pub struct AcpSession {
    pub session_id: String,
    pub image_transport: ImageTransport,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    next_id: Arc<AtomicU64>,
    child: Child,
}

#[allow(dead_code)]
impl AcpSession {
    pub async fn spawn(app: AppHandle) -> Result<Self, AppError> {
        let mut child = Command::new("hermes")
            .arg("acp")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::unexpected("hermes.acp.spawn", e.to_string()))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::unexpected("hermes.acp.spawn", "no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::unexpected("hermes.acp.spawn", "no stdout"))?;

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<Vec<u8>>(32);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>> = Default::default();
        let next_id = Arc::new(AtomicU64::new(1));

        // Writer task: drain stdin_rx → child stdin
        tokio::spawn(async move {
            let mut stdin: ChildStdin = stdin;
            use tokio::io::AsyncWriteExt;
            while let Some(frame) = stdin_rx.recv().await {
                if stdin.write_all(&frame).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
        });

        // Reader task: pump stdout → dispatch_incoming
        let pending_r = pending.clone();
        let app_r = app.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let body = match read_frame(&mut reader).await {
                    Ok(b) => b,
                    Err(_) => {
                        let _ = app_r.emit(
                            "hermes-agent:error",
                            json!({ "kind": "io", "message": "acp stream closed" }),
                        );
                        break;
                    }
                };
                let val = match serde_json::from_slice::<Json>(&body) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = app_r.emit(
                            "hermes-agent:error",
                            json!({ "kind": "parse", "message": "non-json frame" }),
                        );
                        continue;
                    }
                };
                dispatch_incoming(&app_r, &pending_r, val).await;
            }
        });

        let session = AcpSession {
            session_id: String::new(),
            image_transport: ImageTransport::FilePath,
            stdin_tx,
            pending,
            next_id,
            child,
        };

        // 1) initialize
        let init_result = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": {}, "terminal": {} }
                }),
                10,
            )
            .await?;

        // Image transport: hermes-agent v0.14.0 advertises image capability via
        // agentCapabilities.promptCapabilities.image=true but only supports file-path
        // transport (base64 is a future extension). Always FilePath for now.
        let _ = init_result; // consumed above; suppress unused-variable lint
        let image_transport = ImageTransport::FilePath;

        // 2) session/new — mcpServers is required (pydantic field-required)
        let cwd = std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/tmp".to_string());

        let new_resp = session
            .request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), 10)
            .await?;

        let session_id = new_resp
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if session_id.is_empty() {
            return Err(AppError::unexpected(
                "hermes.acp.protocol",
                "session/new missing sessionId",
            ));
        }

        let _ = app.emit(
            "hermes-agent:session-ready",
            json!({ "session_id": &session_id }),
        );

        Ok(AcpSession {
            session_id,
            image_transport,
            ..session
        })
    }

    /// Send a JSON-RPC request and await the matching response (timeout in seconds).
    pub async fn request(
        &self,
        method: &str,
        params: Json,
        timeout_secs: u64,
    ) -> Result<Json, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let body = serde_json::to_vec(&req)
            .map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
        let frame = encode_frame(&body);

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        self.stdin_tx
            .send(frame)
            .await
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))?;

        let resp = timeout(Duration::from_secs(timeout_secs), rx)
            .await
            .map_err(|_| AppError::unexpected("hermes.acp.timeout", method.to_string()))?
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "response channel dropped"))?;

        if let Some(err) = resp.get("error") {
            return Err(AppError::unexpected("hermes.acp.protocol", err.to_string()));
        }
        Ok(resp.get("result").cloned().unwrap_or(Json::Null))
    }

    /// Send a JSON-RPC notification (no response expected).
    pub async fn notify(&self, method: &str, params: Json) -> Result<(), AppError> {
        let body =
            serde_json::to_vec(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
                .map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
        self.stdin_tx
            .send(encode_frame(&body))
            .await
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))
    }

    pub async fn kill(mut self) {
        let _ = self.child.kill().await;
    }
}

#[allow(dead_code)]
/// Dispatch one incoming NDJSON frame.
///
/// Frames are either:
/// - **Responses** (`"id"` present, `"method"` absent): resolved into `pending` map.
/// - **Notifications** (`"method"` present, `"id"` absent): translated to Tauri events.
/// - **Agent requests** (`"method"` + `"id"` present): not yet supported; silently ignored.
async fn dispatch_incoming(
    app: &AppHandle,
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    val: Json,
) {
    // Response: has numeric "id" and no "method"
    if let Some(id) = val.get("id").and_then(|v| v.as_u64()) {
        if val.get("method").is_none() {
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(val);
            }
            return;
        }
    }

    // Notification or agent request: must have "method"
    let Some(method) = val.get("method").and_then(|v| v.as_str()) else {
        return;
    };
    let params = val.get("params").cloned().unwrap_or(Json::Null);

    // Only handle session/update; agent-initiated requests (fs/*, terminal/*, session/request_permission)
    // are not yet implemented — silently ignore to avoid error spam.
    if method == "session/update" {
        // Shape: params.sessionId + params.update.{sessionUpdate, ...fields}
        let update = params.get("update").cloned().unwrap_or(Json::Null);
        let kind = update
            .get("sessionUpdate")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match kind {
            "available_commands_update" => {
                // probe-confirmed: update.availableCommands: [{name, description?}]
                let commands = update
                    .get("availableCommands")
                    .cloned()
                    .unwrap_or(Json::Array(vec![]));
                let _ = app.emit(
                    "hermes-agent:available-commands",
                    json!({ "commands": commands }),
                );
            }
            "agent_message_chunk" | "user_message_chunk" | "agent_thought_chunk" => {
                // schema-confirmed: ContentChunk.content: {type:"text", text: str}
                // (content may also be image/audio/resource; only text is forwarded)
                let chunk_kind = match kind {
                    "agent_message_chunk" => "agent",
                    "user_message_chunk" => "user",
                    _ => "thought",
                };
                if let Some(text) = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                {
                    let _ = app.emit(
                        "hermes-agent:chunk",
                        json!({ "kind": chunk_kind, "text": text }),
                    );
                }
            }
            "tool_call" => {
                // schema-confirmed: ToolCallStart extends ToolCall
                // fields: toolCallId (required), title (required), kind?, status?
                let _ = app.emit("hermes-agent:tool-call", &update);
            }
            "tool_call_update" => {
                // schema-confirmed: ToolCallUpdate — same fields, partial update
                let _ = app.emit("hermes-agent:tool-call-update", &update);
            }
            "plan" => {
                // schema-confirmed: PlanUpdate with entries array
                let entries = update
                    .get("entries")
                    .cloned()
                    .unwrap_or(Json::Array(vec![]));
                let _ = app.emit("hermes-agent:plan", json!({ "entries": entries }));
            }
            // Telemetry / bookkeeping — no UI action needed yet
            "usage_update"
            | "session_info_update"
            | "current_mode_update"
            | "config_option_update" => {}
            _ => {
                // Unknown discriminator: log for debugging
                let _ = app.emit(
                    "hermes-agent:error",
                    json!({
                        "kind": "unknown_session_update",
                        "value": kind
                    }),
                );
            }
        }
    }
}
