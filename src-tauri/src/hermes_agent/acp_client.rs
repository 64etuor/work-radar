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
//! - `hermes-agent:tool-call`        — raw ACP `update` object (camelCase: `toolCallId`, `title`, `kind?`, `status?`)
//! - `hermes-agent:tool-call-update` — raw ACP `update` object (same camelCase shape, partial fields)
//! - `hermes-agent:plan`             — `{ entries: [{title, status, priority}] }`
//! - `hermes-agent:error`            — `{ kind: str, message: str }`

use crate::error::AppError;
use crate::hermes_agent::frame::{encode_frame, read_frame};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use specta::Type;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    pub tab_id: String,
    pub image_transport: ImageTransport,
    pub(crate) stdin_tx: mpsc::Sender<Vec<u8>>,
    pub(crate) pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    pub(crate) next_id: Arc<AtomicU64>,
    /// false until the first `session/prompt` is sent to THIS child. Used to gate the
    /// resume-replay preamble to a fresh child's first prompt (decoupled from spawn timing,
    /// so eager spawn in `open_tab` doesn't suppress replay).
    pub(crate) first_prompt_sent: Arc<AtomicBool>,
    child: Child,
}

#[allow(dead_code)]
impl AcpSession {
    pub async fn spawn(app: AppHandle, tab_id: String) -> Result<Self, AppError> {
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
        let first_prompt_sent = Arc::new(AtomicBool::new(false));

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
        let tab_id_r = tab_id.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let body = match read_frame(&mut reader).await {
                    Ok(b) => b,
                    Err(_) => {
                        emit_with_tab(
                            &app_r,
                            &tab_id_r,
                            "hermes-agent:error",
                            json!({ "kind": "io", "message": "acp stream closed" }),
                        );
                        // Drop all pending senders so in-flight request() calls wake
                        // immediately with RecvError instead of waiting out their timeout.
                        pending_r.lock().await.clear();
                        break;
                    }
                };
                let val = match serde_json::from_slice::<Json>(&body) {
                    Ok(v) => v,
                    Err(_) => {
                        emit_with_tab(
                            &app_r,
                            &tab_id_r,
                            "hermes-agent:error",
                            json!({ "kind": "parse", "message": "non-json frame" }),
                        );
                        continue;
                    }
                };
                dispatch_incoming(&app_r, &tab_id_r, &pending_r, val).await;
            }
        });

        // Build a "shell" session so request()/notify() can use stdin_tx during the
        // initialize + session/new handshake. On any early-return via `?`, this shell
        // drops; `kill_on_drop` on `child` reaps the agent process automatically.
        let session = AcpSession {
            session_id: String::new(),
            tab_id: tab_id.clone(),
            image_transport: ImageTransport::FilePath,
            stdin_tx,
            pending,
            next_id,
            first_prompt_sent,
            child,
        };

        // 1) initialize
        let init_result = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": { "fs": {}, "terminal": false }
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

        // A안 (Boule, spec §5.0): opt-in inject the governance MCP server into the
        // ACP `session/new` payload so Hermes loads it. Unset env → `[]` (today's
        // behaviour, no-op). Internal ACP payload → bindings.ts/specta unaffected (#4).
        let mcp_servers = governance_mcp_servers_from_env();
        let new_resp = session
            .request(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": mcp_servers }),
                10,
            )
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

        emit_with_tab(
            &app,
            &tab_id,
            "hermes-agent:session-ready",
            json!({ "session_id": &session_id }),
        );

        Ok(AcpSession {
            session_id,
            tab_id,
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
        // Drop all pending senders so any in-flight request() callers wake immediately.
        // stdin_tx drops with self, which closes the mpsc channel → writer task exits.
        self.pending.lock().await.clear();
    }
}

/// Read Boule opt-in env and build the `session/new` `mcpServers` array (A안).
///
/// `BOULE_GOVERNANCE_DIR` is the opt-in gate; `BOULE_NODE` optionally overrides
/// the node binary (absolute path) for GUI launches where PATH may lack node.
fn governance_mcp_servers_from_env() -> Vec<Json> {
    let dir = std::env::var("BOULE_GOVERNANCE_DIR").ok();
    let node = std::env::var("BOULE_NODE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "node".to_string());
    governance_mcp_servers(dir.as_deref(), &node)
}

/// Pure builder: governance dir (opt-in) → ACP stdio MCP descriptor(s).
///
/// - `dir` unset/empty → `vec![]` (identical to pre-A안 behaviour, no-op).
/// - `dir` set but `<dir>/src/mcp/server.ts` missing → `warn!` (path only) + `vec![]`
///   (graceful degrade, no retry — INVARIANT #5).
/// - otherwise → one `McpServerStdio` descriptor. Note ACP `env` is a **list**
///   `[{name,value}]` (differs from hermes config.yaml's dict — spec §5.0).
///
/// `dir`/`node` are injected (not read from env here) so this stays unit-testable.
fn governance_mcp_servers(dir: Option<&str>, node: &str) -> Vec<Json> {
    let Some(dir) = dir.filter(|d| !d.is_empty()) else {
        return vec![];
    };
    let server_ts = std::path::Path::new(dir).join("src/mcp/server.ts");
    if !server_ts.exists() {
        tracing::warn!(
            target: "boule.governance",
            governance_dir = %dir,
            "BOULE_GOVERNANCE_DIR set but src/mcp/server.ts missing; skipping MCP load"
        );
        return vec![];
    }
    let server_ts = server_ts.to_string_lossy().into_owned();
    let workspace = std::path::Path::new(dir)
        .join("workspace")
        .to_string_lossy()
        .into_owned();
    vec![json!({
        "name": "boule-governance",
        "command": node,
        "args": ["--experimental-strip-types", server_ts],
        "env": [{ "name": "BOULE_WORKSPACE", "value": workspace }],
    })]
}

/// Emit a Tauri event with `tabId` injected at the top level of payload.
/// `payload` MUST be a JSON object (or null → becomes {tabId}).
/// This is the single gateway for all hermes-agent:* event emits.
fn emit_with_tab(app: &AppHandle, tab_id: &str, event: &str, payload: Json) {
    let mut obj = match payload {
        Json::Object(m) => m,
        Json::Null => serde_json::Map::new(),
        other => {
            let mut m = serde_json::Map::new();
            m.insert("value".to_string(), other);
            m
        }
    };
    obj.insert("tabId".to_string(), Json::String(tab_id.to_string()));
    let _ = app.emit(event, Json::Object(obj));
}

/// Normalized "ask the user" payload emitted to the frontend (bespoke generic shape;
/// ACP semantics never cross the IPC boundary).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AskUserOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AskUser {
    /// Original JSON-RPC request id as an opaque JSON-serialized token (specta forbids
    /// i64/u64 crossing the IPC boundary). `build_ask_user_response` recovers the id's
    /// exact original JSON type from this token, so a numeric string ("7") stays a
    /// string and a number (7) stays a number — the frontend never inspects it.
    pub request_id: String,
    pub tool_name: Option<String>,
    pub options: Vec<AskUserOption>,
}

/// Translate an inbound ACP `session/request_permission` request frame into an `AskUser`.
/// Returns `None` for any other method, a frame without an id (a notification), or one
/// with no usable options. Tolerant: options missing `optionId` are skipped; a missing
/// `name` falls back to the `optionId` as the label (graceful degrade — the exact ACP
/// option schema is unverified pending the deferred live smoke).
pub(crate) fn parse_permission_request(val: &Json) -> Option<AskUser> {
    if val.get("method").and_then(|v| v.as_str()) != Some("session/request_permission") {
        return None;
    }
    // Serialize the id to its JSON text so its exact type survives the round-trip
    // (number 7 → "7", string "7" → "\"7\""); `build_ask_user_response` reverses this.
    let request_id = match val.get("id")? {
        id @ (Json::Number(_) | Json::String(_)) => serde_json::to_string(id).ok()?,
        _ => return None,
    };
    let params = val.get("params")?;
    let raw_options = params.get("options")?.as_array()?;
    let mut options = Vec::new();
    for opt in raw_options {
        let Some(option_id) = opt.get("optionId").and_then(|v| v.as_str()) else {
            continue;
        };
        let label = opt
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(option_id)
            .to_string();
        options.push(AskUserOption {
            id: option_id.to_string(),
            label,
        });
    }
    if options.is_empty() {
        return None;
    }
    let tool_name = params
        .get("toolCall")
        .and_then(|tc| tc.get("title"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(AskUser {
        request_id,
        tool_name,
        options,
    })
}

/// Build the JSON-RPC **response** body for an ask-user request. The `request_id` token
/// is the JSON-serialized original id (see `parse_permission_request`), so it is parsed
/// back to recover the id's exact JSON type — a numeric string stays a string, a number
/// stays a number. A token that isn't valid JSON (or not a string/number) falls back to
/// a string id (defensive). `cancelled` sends the ACP `cancelled` outcome (so a dismissed
/// card never hangs the agent).
pub(crate) fn build_ask_user_response(
    request_id: &str,
    option_id: &str,
    cancelled: bool,
) -> Vec<u8> {
    let id = serde_json::from_str::<Json>(request_id)
        .ok()
        .filter(|v| v.is_number() || v.is_string())
        .unwrap_or_else(|| json!(request_id));
    let outcome = if cancelled {
        json!({ "outcome": "cancelled" })
    } else {
        json!({ "outcome": "selected", "optionId": option_id })
    };
    let resp = json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": outcome } });
    serde_json::to_vec(&resp).unwrap_or_default()
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
    tab_id: &str,
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

    // Inbound agent *request*: the agent asks the user to choose (ACP
    // session/request_permission). Today other agent requests (fs/*, terminal/*) are
    // still silently ignored — out of scope. We translate this one into the bespoke
    // generic ask-user event; the user's choice returns via hermes_ask_user_respond.
    if let Some(ask) = parse_permission_request(&val) {
        let options: Vec<Json> = ask
            .options
            .iter()
            .map(|o| json!({ "id": o.id, "label": o.label }))
            .collect();
        emit_with_tab(
            app,
            tab_id,
            "hermes-agent:ask-user",
            json!({
                "requestId": ask.request_id,
                "toolName": ask.tool_name,
                "options": options,
            }),
        );
        return;
    }

    // session/request_permission is handled above; remaining agent-initiated requests
    // (fs/*, terminal/*) are not yet implemented — silently ignore to avoid error spam.
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
                emit_with_tab(
                    app,
                    tab_id,
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
                    emit_with_tab(
                        app,
                        tab_id,
                        "hermes-agent:chunk",
                        json!({ "kind": chunk_kind, "text": text }),
                    );
                }
            }
            "tool_call" => {
                // schema-confirmed: ToolCallStart extends ToolCall
                // fields: toolCallId (required), title (required), kind?, status?
                emit_with_tab(app, tab_id, "hermes-agent:tool-call", update);
            }
            "tool_call_update" => {
                // schema-confirmed: ToolCallUpdate — same fields, partial update
                emit_with_tab(app, tab_id, "hermes-agent:tool-call-update", update);
            }
            "plan" => {
                // schema-confirmed: PlanUpdate with entries array
                let entries = update
                    .get("entries")
                    .cloned()
                    .unwrap_or(Json::Array(vec![]));
                emit_with_tab(
                    app,
                    tab_id,
                    "hermes-agent:plan",
                    json!({ "entries": entries }),
                );
            }
            // Telemetry / bookkeeping — no UI action needed yet
            "usage_update"
            | "session_info_update"
            | "current_mode_update"
            | "config_option_update" => {}
            _ => {
                // Unknown discriminator: log for debugging
                emit_with_tab(
                    app,
                    tab_id,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn governance_mcp_servers_empty_when_dir_unset_or_blank() {
        assert!(governance_mcp_servers(None, "node").is_empty());
        assert!(governance_mcp_servers(Some(""), "node").is_empty());
    }

    #[test]
    fn governance_mcp_servers_empty_when_server_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().to_string_lossy().into_owned();
        // No src/mcp/server.ts created → graceful degrade to empty.
        assert!(governance_mcp_servers(Some(&dir), "node").is_empty());
    }

    #[test]
    fn governance_mcp_servers_one_entry_when_server_present() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mcp_dir = tmp.path().join("src").join("mcp");
        std::fs::create_dir_all(&mcp_dir).expect("mkdir");
        std::fs::write(mcp_dir.join("server.ts"), "// stub").expect("write");
        let dir = tmp.path().to_string_lossy().into_owned();

        let servers = governance_mcp_servers(Some(&dir), "/abs/node");
        assert_eq!(servers.len(), 1);
        let s = &servers[0];
        assert_eq!(s["name"], "boule-governance");
        assert_eq!(s["command"], "/abs/node");
        assert_eq!(s["args"][0], "--experimental-strip-types");
        assert!(s["args"][1]
            .as_str()
            .expect("args[1] str")
            .ends_with("src/mcp/server.ts"));
        // ACP env MUST be a list of {name,value} (not a dict) — spec §5.0.
        assert_eq!(s["env"][0]["name"], "BOULE_WORKSPACE");
        assert!(s["env"][0]["value"]
            .as_str()
            .expect("env value str")
            .ends_with("workspace"));
    }

    #[test]
    fn parse_permission_request_normalizes_a_well_formed_frame() {
        let val = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "session/request_permission",
            "params": {
                "sessionId": "s1",
                "toolCall": { "title": "Write file foo.txt" },
                "options": [
                    { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
                ]
            }
        });
        let ask = parse_permission_request(&val).expect("should parse");
        assert_eq!(ask.request_id, "7");
        assert_eq!(ask.tool_name.as_deref(), Some("Write file foo.txt"));
        assert_eq!(ask.options.len(), 2);
        assert_eq!(
            ask.options[0],
            AskUserOption {
                id: "allow".into(),
                label: "Allow".into()
            }
        );
        assert_eq!(ask.options[1].id, "reject");
    }

    #[test]
    fn parse_permission_request_label_falls_back_to_option_id_and_skips_malformed() {
        let val = json!({
            "id": "abc",
            "method": "session/request_permission",
            "params": { "options": [
                { "optionId": "ok" },               // no name → label = optionId
                { "name": "no id here" }             // no optionId → skipped
            ] }
        });
        let ask = parse_permission_request(&val).expect("should parse");
        assert_eq!(ask.request_id, "\"abc\""); // string id → JSON-serialized token (quoted)
        assert_eq!(ask.tool_name, None);
        assert_eq!(ask.options.len(), 1);
        assert_eq!(
            ask.options[0],
            AskUserOption {
                id: "ok".into(),
                label: "ok".into()
            }
        );
    }

    #[test]
    fn parse_permission_request_returns_none_for_irrelevant_or_empty() {
        // wrong method
        assert!(parse_permission_request(&json!({
            "id": 1, "method": "session/update", "params": {}
        }))
        .is_none());
        // missing id (a notification, not a request)
        assert!(parse_permission_request(&json!({
            "method": "session/request_permission", "params": { "options": [{"optionId":"x"}] }
        }))
        .is_none());
        // no usable options
        assert!(parse_permission_request(&json!({
            "id": 2, "method": "session/request_permission", "params": { "options": [] }
        }))
        .is_none());
    }

    #[test]
    fn build_ask_user_response_selected_echoes_numeric_id() {
        let bytes = build_ask_user_response("7", "allow", false);
        let v: Json = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(v["id"], json!(7)); // numeric id echoed as a number
        assert_eq!(v["result"]["outcome"]["outcome"], "selected");
        assert_eq!(v["result"]["outcome"]["optionId"], "allow");
    }

    #[test]
    fn build_ask_user_response_cancelled_omits_option_and_keeps_string_id() {
        let bytes = build_ask_user_response("abc", "ignored", true);
        let v: Json = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(v["id"], json!("abc")); // non-numeric id stays a string
        assert_eq!(v["result"]["outcome"]["outcome"], "cancelled");
        assert!(v["result"]["outcome"].get("optionId").is_none());
    }

    /// Round-trip a JSON *number* id through parse → build: must stay a number.
    #[test]
    fn ask_user_id_roundtrip_preserves_number_as_number() {
        let val = json!({
            "id": 7,
            "method": "session/request_permission",
            "params": { "options": [{ "optionId": "ok", "name": "OK" }] }
        });
        let ask = parse_permission_request(&val).expect("should parse");
        let bytes = build_ask_user_response(&ask.request_id, "ok", false);
        let v: Json = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(v["id"], json!(7));
    }

    /// Round-trip a numeric *string* id ("7") through parse → build: must stay a
    /// string. JSON-RPC requires the response id to equal the request id including
    /// its type, so coercing "7" → 7 would break correlation for such an agent.
    #[test]
    fn ask_user_id_roundtrip_preserves_numeric_string_as_string() {
        let val = json!({
            "id": "7",
            "method": "session/request_permission",
            "params": { "options": [{ "optionId": "ok", "name": "OK" }] }
        });
        let ask = parse_permission_request(&val).expect("should parse");
        let bytes = build_ask_user_response(&ask.request_id, "ok", false);
        let v: Json = serde_json::from_slice(&bytes).expect("valid json");
        assert_eq!(v["id"], json!("7")); // stays a STRING, not coerced to number 7
    }
}
