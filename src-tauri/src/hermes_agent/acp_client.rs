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
use std::path::Path;
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
    pub async fn spawn(
        app: AppHandle,
        tab_id: String,
        mcp_servers: Vec<Json>,
    ) -> Result<Self, AppError> {
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

        // The caller injects Work Radar's built-in MCP plus any project-bound Boule servers.
        // The renderer cannot supply or alter this internal ACP payload.
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

/// Resolve the boule-governance MCP descriptor(s) for a Hermes tab from its PROJECT binding.
///
/// - tab unbound (or session row absent) → `[]` (no-op, today's default).
/// - bound project has no enabled local repo → warn + `[]` (chat still works).
/// - `<repo>/.boule/mcp.json` missing/unreadable/unparseable → warn + `[]` (graceful degrade,
///   no retry — INVARIANT #5). Run `boule init --repo <p>` to materialize it.
///
/// The repo path is ALWAYS resolved from the DB (never renderer-supplied — same INVARIANT as
/// the ticker, plan §6); the generated mcp.json is the canonical per-repo policy env, so this
/// stays in lockstep with the `claude --mcp-config .boule/mcp.json` path.
pub(crate) async fn governance_mcp_servers_for_tab(db: &crate::db::Db, tab_id: &str) -> Vec<Json> {
    let Ok(Some(project_id)) =
        crate::hermes_agent::session_store::project_id_inner(db, tab_id).await
    else {
        return vec![];
    };
    let repo = match crate::governance::ticker::resolve_project_repo_path(db, &project_id).await {
        Ok(path) => path,
        Err(e) => {
            tracing::warn!(
                target: "boule.governance",
                %project_id,
                error = %e,
                "hermes session bound to a project without a local repo; skipping MCP load"
            );
            return vec![];
        }
    };
    let mcp_json_path = repo.join(".boule").join("mcp.json");
    let raw = match tokio::fs::read_to_string(&mcp_json_path).await {
        Ok(raw) => raw,
        Err(e) => {
            tracing::warn!(
                target: "boule.governance",
                path = %mcp_json_path.display(),
                error = %e,
                "no readable .boule/mcp.json for bound project; run `boule init` — skipping MCP load"
            );
            return vec![];
        }
    };
    // GUI launches may lack node on PATH — resolve an absolute node for `command: "node"`.
    let node_override = crate::governance::ticker::resolve_node_bin()
        .await
        .map(|p| p.to_string_lossy().into_owned());
    if node_override.is_none() {
        tracing::warn!(
            target: "boule.governance",
            "no node binary resolved; MCP descriptor keeps bare \"node\" (may fail under GUI PATH)"
        );
    }
    acp_mcp_servers_from_boule_mcp_json(&raw, node_override.as_deref())
}

const HERMES_MCP_CALLER_ENV: &str = "WORK_RADAR_MCP_CALLER";
const WORK_RADAR_DB_ENV: &str = "WORK_RADAR_DEV_DB";

pub(crate) async fn hermes_mcp_servers_for_tab(
    db: &crate::db::Db,
    tab_id: &str,
    executable: &Path,
    db_path: &Path,
) -> Vec<Json> {
    let mut servers = vec![work_radar_mcp_server(executable, db_path)];
    servers.extend(governance_mcp_servers_for_tab(db, tab_id).await);
    servers
}

fn work_radar_mcp_server(executable: &Path, db_path: &Path) -> Json {
    json!({
        "name": "work-radar",
        "command": executable.to_string_lossy(),
        "args": ["--mcp-stdio"],
        "env": [
            { "name": HERMES_MCP_CALLER_ENV, "value": "hermes" },
            { "name": WORK_RADAR_DB_ENV, "value": db_path.to_string_lossy() }
        ],
    })
}

/// Pure: a repo's generated `.boule/mcp.json` ({"mcpServers": {<name>: {command, args, env{}}}})
/// → ACP `session/new` `mcpServers` array. ACP `env` is a **list** `[{name,value}]` (differs
/// from mcp.json's dict — spec §5.0). `node_override` (absolute path) replaces a bare
/// `"node"` command so GUI launches without PATH still spawn. Malformed input → `[]`.
pub(crate) fn acp_mcp_servers_from_boule_mcp_json(
    raw: &str,
    node_override: Option<&str>,
) -> Vec<Json> {
    let Ok(parsed) = serde_json::from_str::<Json>(raw) else {
        return vec![];
    };
    let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (name, spec) in servers {
        let Some(command) = spec.get("command").and_then(|v| v.as_str()) else {
            continue;
        };
        let command = match node_override {
            Some(node) if command == "node" => node.to_string(),
            _ => command.to_string(),
        };
        let args = spec.get("args").cloned().unwrap_or_else(|| json!([]));
        let mut env_list: Vec<Json> = spec
            .get("env")
            .and_then(|v| v.as_object())
            .map(|envs| {
                envs.iter()
                    .filter(|(k, _)| k.as_str() != HERMES_MCP_CALLER_ENV)
                    .filter_map(|(k, v)| v.as_str().map(|val| json!({ "name": k, "value": val })))
                    .collect()
            })
            .unwrap_or_default();
        if is_work_radar_mcp_stdio(&command, &args) {
            env_list.push(json!({ "name": HERMES_MCP_CALLER_ENV, "value": "hermes" }));
        }
        out.push(json!({
            "name": name,
            "command": command,
            "args": args,
            "env": env_list,
        }));
    }
    out
}

fn is_work_radar_mcp_stdio(command: &str, args: &Json) -> bool {
    let has_mcp_stdio = args
        .as_array()
        .is_some_and(|items| items.iter().any(|v| v.as_str() == Some("--mcp-stdio")));
    has_mcp_stdio
        && command
            .rsplit('/')
            .next()
            .is_some_and(|bin| bin.contains("work-radar"))
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
    use crate::commands::shared::test_support::fresh_db;

    #[test]
    fn built_in_work_radar_mcp_pins_executable_database_and_caller() {
        let server = work_radar_mcp_server(
            std::path::Path::new("/Applications/Work Radar.app/Contents/MacOS/work-radar"),
            std::path::Path::new("/app-data/work-radar.db"),
        );
        assert_eq!(server["name"], "work-radar");
        assert_eq!(
            server["command"],
            "/Applications/Work Radar.app/Contents/MacOS/work-radar"
        );
        assert_eq!(server["args"], json!(["--mcp-stdio"]));
        assert_eq!(
            server["env"],
            json!([
                { "name": HERMES_MCP_CALLER_ENV, "value": "hermes" },
                { "name": "WORK_RADAR_DEV_DB", "value": "/app-data/work-radar.db" }
            ])
        );
    }

    #[tokio::test]
    async fn unbound_tab_still_receives_the_built_in_work_radar_mcp() {
        let db = fresh_db().await;
        let servers = hermes_mcp_servers_for_tab(
            &db,
            "unbound-tab",
            Path::new("/opt/work-radar"),
            Path::new("/data/work-radar.db"),
        )
        .await;
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "work-radar");
    }

    #[test]
    fn acp_servers_empty_on_malformed_or_missing_mcp_servers() {
        assert!(acp_mcp_servers_from_boule_mcp_json("not json", None).is_empty());
        assert!(acp_mcp_servers_from_boule_mcp_json("{}", None).is_empty());
        assert!(acp_mcp_servers_from_boule_mcp_json(r#"{"mcpServers": {}}"#, None).is_empty());
    }

    #[test]
    fn acp_servers_converts_env_dict_to_acp_list_and_overrides_bare_node() {
        let raw = r#"{
          "mcpServers": {
            "boule-governance": {
              "command": "node",
              "args": ["--experimental-strip-types", "/install/governance/src/mcp/server.ts"],
              "env": { "BOULE_WORKSPACE": "/repo/.boule/workspace", "BOULE_AUTONOMY_LEVEL": "dispatch" }
            }
          }
        }"#;
        let servers = acp_mcp_servers_from_boule_mcp_json(raw, Some("/abs/node"));
        assert_eq!(servers.len(), 1);
        let s = &servers[0];
        assert_eq!(s["name"], "boule-governance");
        assert_eq!(s["command"], "/abs/node"); // bare "node" → absolute override (GUI PATH)
        assert_eq!(s["args"][1], "/install/governance/src/mcp/server.ts");
        // ACP env MUST be a list of {name,value} (not a dict) — spec §5.0.
        let env = s["env"].as_array().expect("env list");
        assert!(env
            .iter()
            .any(|e| e["name"] == "BOULE_WORKSPACE" && e["value"] == "/repo/.boule/workspace"));
        assert!(env
            .iter()
            .any(|e| e["name"] == "BOULE_AUTONOMY_LEVEL" && e["value"] == "dispatch"));
        assert!(
            !env.iter().any(|e| e["name"] == HERMES_MCP_CALLER_ENV),
            "governance node MCP server does not get work-radar direct-write marker"
        );
    }

    #[test]
    fn acp_servers_keeps_non_node_command_untouched() {
        let raw = r#"{"mcpServers": {"x": {"command": "/usr/local/bin/work-radar", "args": ["--mcp-stdio"]}}}"#;
        let servers = acp_mcp_servers_from_boule_mcp_json(raw, Some("/abs/node"));
        assert_eq!(servers[0]["command"], "/usr/local/bin/work-radar");
        assert_eq!(
            servers[0]["env"],
            json!([{ "name": HERMES_MCP_CALLER_ENV, "value": "hermes" }])
        );
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
