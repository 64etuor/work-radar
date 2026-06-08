//! cmux notification bridge read model.
//!
//! This module models the local cmux -> notification hook layer as an observable
//! integration. Telegram and Slack share the common cmux identity model, but
//! transport-specific delivery/routing stays outside the common core.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CmuxBridgeTransport {
    Telegram,
    Slack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CmuxBridgeSessionState {
    Active,
    Archived,
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxBridgeRemoteRef {
    pub title: Option<String>,
    pub chat_id: Option<String>,
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxBridgeSession {
    pub transport: CmuxBridgeTransport,
    pub state: CmuxBridgeSessionState,
    pub session_id: Option<String>,
    pub surface: Option<String>,
    pub pane_name: Option<String>,
    pub workspace_title: Option<String>,
    pub cwd: Option<String>,
    pub remote: CmuxBridgeRemoteRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxBridgeSnapshot {
    pub transports: Vec<CmuxBridgeTransport>,
    pub sessions: Vec<CmuxBridgeSession>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramRegistryEntry {
    session_id: Option<String>,
    surface: Option<String>,
    pane_name: Option<String>,
    workspace_title: Option<String>,
    cwd: Option<String>,
    topic: Option<String>,
    chat_id: Option<serde_json::Value>,
    message_thread_id: Option<serde_json::Value>,
    closed: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct SlackRegistryEntry {
    session_id: Option<String>,
    surface: Option<String>,
    pane_name: Option<String>,
    workspace_title: Option<String>,
    cwd: Option<String>,
    topic: Option<String>,
    channel_id: Option<serde_json::Value>,
    thread_ts: Option<serde_json::Value>,
}

pub fn load_snapshot_from_dir(dir: &std::path::Path) -> Result<CmuxBridgeSnapshot, String> {
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();

    load_telegram_registry_file(
        &dir.join("cmux-telegram-topics.json"),
        "cmux-telegram-topics.json",
        CmuxBridgeSessionState::Active,
        &mut sessions,
        &mut warnings,
    );
    load_telegram_registry_file(
        &dir.join("cmux-telegram-completed-topics.json"),
        "cmux-telegram-completed-topics.json",
        CmuxBridgeSessionState::Archived,
        &mut sessions,
        &mut warnings,
    );
    load_slack_registry_file(
        &dir.join("cmux-slack-threads.json"),
        "cmux-slack-threads.json",
        CmuxBridgeSessionState::Active,
        &mut sessions,
        &mut warnings,
    );
    load_slack_registry_file(
        &dir.join("cmux-slack-completed-threads.json"),
        "cmux-slack-completed-threads.json",
        CmuxBridgeSessionState::Archived,
        &mut sessions,
        &mut warnings,
    );

    let mut transports = Vec::new();
    if sessions
        .iter()
        .any(|s| s.transport == CmuxBridgeTransport::Telegram)
    {
        transports.push(CmuxBridgeTransport::Telegram);
    }
    if sessions
        .iter()
        .any(|s| s.transport == CmuxBridgeTransport::Slack)
    {
        transports.push(CmuxBridgeTransport::Slack);
    }

    Ok(CmuxBridgeSnapshot {
        transports,
        sessions,
        warnings,
    })
}

pub fn claude_dir_for_home(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".claude")
}

fn load_telegram_registry_file(
    path: &std::path::Path,
    label: &str,
    state: CmuxBridgeSessionState,
    sessions: &mut Vec<CmuxBridgeSession>,
    warnings: &mut Vec<String>,
) {
    match std::fs::read_to_string(path) {
        Ok(json) => match parse_telegram_registry_with_state(&json, state) {
            Ok(mut parsed) => sessions.append(&mut parsed),
            Err(e) => warnings.push(format!("{label}: invalid registry json: {e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            warnings.push(format!("{label}: missing"));
        }
        Err(e) => warnings.push(format!("{label}: read failed: {e}")),
    }
}

#[cfg(test)]
fn parse_telegram_registry(json: &str) -> Result<Vec<CmuxBridgeSession>, serde_json::Error> {
    parse_telegram_registry_with_state(json, CmuxBridgeSessionState::Active)
}

fn parse_telegram_registry_with_state(
    json: &str,
    state: CmuxBridgeSessionState,
) -> Result<Vec<CmuxBridgeSession>, serde_json::Error> {
    let entries: std::collections::BTreeMap<String, TelegramRegistryEntry> =
        serde_json::from_str(json)?;
    let mut sessions = Vec::new();
    for (_key, entry) in entries {
        if entry.session_id.as_deref().unwrap_or("").trim().is_empty()
            && entry.surface.as_deref().unwrap_or("").trim().is_empty()
        {
            continue;
        }
        sessions.push(CmuxBridgeSession {
            transport: CmuxBridgeTransport::Telegram,
            state: match state {
                CmuxBridgeSessionState::Archived => CmuxBridgeSessionState::Archived,
                CmuxBridgeSessionState::Active | CmuxBridgeSessionState::Stale => {
                    if entry.closed.unwrap_or(false) {
                        CmuxBridgeSessionState::Archived
                    } else {
                        state
                    }
                }
            },
            session_id: clean_string(entry.session_id),
            surface: clean_string(entry.surface),
            pane_name: clean_string(entry.pane_name).map(|s| strip_activity_glyph(&s)),
            workspace_title: clean_string(entry.workspace_title),
            cwd: clean_string(entry.cwd),
            remote: CmuxBridgeRemoteRef {
                title: clean_string(entry.topic),
                chat_id: value_to_clean_string(entry.chat_id),
                thread_id: value_to_clean_string(entry.message_thread_id),
            },
        });
    }
    Ok(sessions)
}

fn load_slack_registry_file(
    path: &std::path::Path,
    label: &str,
    state: CmuxBridgeSessionState,
    sessions: &mut Vec<CmuxBridgeSession>,
    warnings: &mut Vec<String>,
) {
    match std::fs::read_to_string(path) {
        Ok(json) => match parse_slack_registry_with_state(&json, state) {
            Ok(mut parsed) => sessions.append(&mut parsed),
            Err(e) => warnings.push(format!("{label}: invalid registry json: {e}")),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            warnings.push(format!("{label}: missing"));
        }
        Err(e) => warnings.push(format!("{label}: read failed: {e}")),
    }
}

fn parse_slack_registry_with_state(
    json: &str,
    state: CmuxBridgeSessionState,
) -> Result<Vec<CmuxBridgeSession>, serde_json::Error> {
    let entries: std::collections::BTreeMap<String, SlackRegistryEntry> =
        serde_json::from_str(json)?;
    let mut sessions = Vec::new();
    for (_key, entry) in entries {
        if entry.session_id.as_deref().unwrap_or("").trim().is_empty()
            && entry.surface.as_deref().unwrap_or("").trim().is_empty()
        {
            continue;
        }
        sessions.push(CmuxBridgeSession {
            transport: CmuxBridgeTransport::Slack,
            state,
            session_id: clean_string(entry.session_id),
            surface: clean_string(entry.surface),
            pane_name: clean_string(entry.pane_name).map(|s| strip_activity_glyph(&s)),
            workspace_title: clean_string(entry.workspace_title),
            cwd: clean_string(entry.cwd),
            remote: CmuxBridgeRemoteRef {
                title: clean_string(entry.topic),
                chat_id: value_to_clean_string(entry.channel_id),
                thread_id: value_to_clean_string(entry.thread_ts),
            },
        });
    }
    Ok(sessions)
}

fn clean_string(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && !s.contains(['\t', '\r', '\n']))
}

fn value_to_clean_string(value: Option<serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(s) => clean_string(Some(s)),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn strip_activity_glyph(title: &str) -> String {
    let t = title.trim();
    let mut chars = t.chars();
    if let Some(first) = chars.clone().next() {
        let is_glyph = ('\u{2800}'..='\u{28FF}').contains(&first) || first == '✳';
        if is_glyph {
            chars.next();
            return chars.as_str().trim_start().to_string();
        }
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_completed_telegram_registry_into_common_sessions() {
        let json = r#"
        {
          "session:abc": {
            "session_id": "abc",
            "surface": "surface:3",
            "pane_name": "✳ Implement bridge",
            "workspace_title": "work-radar",
            "cwd": "/repo/work-radar",
            "topic": "WR v2 — Implement bridge",
            "chat_id": -100123,
            "message_thread_id": 456,
            "closed": true,
            "completed_reason": "done"
          }
        }
        "#;

        let sessions = parse_telegram_registry(json).expect("registry parses");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].transport, CmuxBridgeTransport::Telegram);
        assert_eq!(sessions[0].session_id.as_deref(), Some("abc"));
        assert_eq!(sessions[0].surface.as_deref(), Some("surface:3"));
        assert_eq!(sessions[0].pane_name.as_deref(), Some("Implement bridge"));
        assert_eq!(sessions[0].workspace_title.as_deref(), Some("work-radar"));
        assert_eq!(sessions[0].cwd.as_deref(), Some("/repo/work-radar"));
        assert_eq!(
            sessions[0].remote.title.as_deref(),
            Some("WR v2 — Implement bridge")
        );
        assert_eq!(sessions[0].remote.chat_id.as_deref(), Some("-100123"));
        assert_eq!(sessions[0].remote.thread_id.as_deref(), Some("456"));
        assert_eq!(sessions[0].state, CmuxBridgeSessionState::Archived);
    }

    #[test]
    fn bridge_transport_keeps_slack_separate_from_telegram() {
        assert_eq!(
            serde_json::to_string(&CmuxBridgeTransport::Telegram).expect("serialize"),
            "\"telegram\""
        );
        assert_eq!(
            serde_json::to_string(&CmuxBridgeTransport::Slack).expect("serialize"),
            "\"slack\""
        );
    }

    #[test]
    fn parser_skips_entries_without_cmux_identity() {
        let json = r#"
        {
          "bad": { "topic": "No session or surface", "chat_id": 1 },
          "good": { "surface": "surface:1", "topic": "Topic", "chat_id": 1 }
        }
        "#;

        let sessions = parse_telegram_registry(json).expect("registry parses");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].surface.as_deref(), Some("surface:1"));
    }

    #[test]
    fn loads_telegram_snapshot_from_active_and_completed_registries() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("cmux-telegram-topics.json"),
            r#"{
              "session:active": {
                "session_id": "active",
                "surface": "surface:1",
                "topic": "Active topic",
                "chat_id": 1
              }
            }"#,
        )
        .expect("write active");
        std::fs::write(
            dir.path().join("cmux-telegram-completed-topics.json"),
            r#"{
              "session:done": {
                "session_id": "done",
                "surface": "surface:2",
                "topic": "Done topic",
                "chat_id": 1,
                "closed": true
              }
            }"#,
        )
        .expect("write completed");
        std::fs::write(dir.path().join("cmux-slack-threads.json"), "{}")
            .expect("write slack active");
        std::fs::write(dir.path().join("cmux-slack-completed-threads.json"), "{}")
            .expect("write slack completed");

        let snapshot = load_snapshot_from_dir(dir.path()).expect("snapshot");

        assert_eq!(snapshot.sessions.len(), 2);
        assert_eq!(snapshot.transports, vec![CmuxBridgeTransport::Telegram]);
        assert_eq!(snapshot.sessions[0].state, CmuxBridgeSessionState::Active);
        assert_eq!(snapshot.sessions[1].state, CmuxBridgeSessionState::Archived);
        assert!(snapshot.warnings.is_empty());
    }

    #[test]
    fn completed_telegram_registry_is_archived_even_when_topic_close_failed() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("cmux-telegram-topics.json"), "{}").expect("write active");
        std::fs::write(
            dir.path().join("cmux-telegram-completed-topics.json"),
            r#"{
              "session:done": {
                "session_id": "done",
                "surface": "surface:2",
                "topic": "Done topic",
                "chat_id": 1,
                "message_thread_id": 2,
                "closed": false
              }
            }"#,
        )
        .expect("write completed");

        let snapshot = load_snapshot_from_dir(dir.path()).expect("snapshot");

        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].state, CmuxBridgeSessionState::Archived);
    }

    #[test]
    fn malformed_registry_warns_and_preserves_other_sessions() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("cmux-telegram-topics.json"), "{not json")
            .expect("write malformed active");
        std::fs::write(
            dir.path().join("cmux-telegram-completed-topics.json"),
            r#"{
              "session:done": {
                "session_id": "done",
                "surface": "surface:2",
                "topic": "Done topic",
                "chat_id": 1,
                "closed": false
              }
            }"#,
        )
        .expect("write completed");

        let snapshot = load_snapshot_from_dir(dir.path()).expect("snapshot");

        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].state, CmuxBridgeSessionState::Archived);
        assert_eq!(snapshot.warnings.len(), 3);
        assert!(snapshot
            .warnings
            .iter()
            .any(|w| w.contains("cmux-telegram-topics.json: invalid registry json")));
    }

    #[test]
    fn loads_slack_snapshot_from_active_and_completed_registries() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("cmux-telegram-topics.json"), "{}")
            .expect("write telegram active");
        std::fs::write(dir.path().join("cmux-telegram-completed-topics.json"), "{}")
            .expect("write telegram completed");
        std::fs::write(
            dir.path().join("cmux-slack-threads.json"),
            r#"{
              "session:active": {
                "session_id": "active",
                "surface": "surface:1",
                "pane_name": "Build bridge",
                "workspace_title": "work-radar",
                "cwd": "/repo/work-radar",
                "topic": "work-radar — Pane: Build bridge",
                "channel_id": "C123",
                "thread_ts": "1710000000.000100"
              }
            }"#,
        )
        .expect("write slack active");
        std::fs::write(
            dir.path().join("cmux-slack-completed-threads.json"),
            r#"{
              "session:done": {
                "session_id": "done",
                "surface": "surface:2",
                "topic": "Done thread",
                "channel_id": "C123",
                "thread_ts": "1710000000.000200"
              }
            }"#,
        )
        .expect("write slack completed");

        let snapshot = load_snapshot_from_dir(dir.path()).expect("snapshot");

        assert_eq!(snapshot.transports, vec![CmuxBridgeTransport::Slack]);
        assert_eq!(snapshot.sessions.len(), 2);
        assert_eq!(snapshot.sessions[0].transport, CmuxBridgeTransport::Slack);
        assert_eq!(snapshot.sessions[0].state, CmuxBridgeSessionState::Active);
        assert_eq!(snapshot.sessions[0].remote.chat_id.as_deref(), Some("C123"));
        assert_eq!(
            snapshot.sessions[0].remote.thread_id.as_deref(),
            Some("1710000000.000100")
        );
        assert_eq!(snapshot.sessions[1].transport, CmuxBridgeTransport::Slack);
        assert_eq!(snapshot.sessions[1].state, CmuxBridgeSessionState::Archived);
    }

    #[test]
    fn snapshot_reports_missing_registries_without_failing() {
        let dir = tempfile::tempdir().expect("tempdir");

        let snapshot = load_snapshot_from_dir(dir.path()).expect("snapshot");

        assert!(snapshot.sessions.is_empty());
        assert_eq!(snapshot.transports, Vec::<CmuxBridgeTransport>::new());
        assert_eq!(snapshot.warnings.len(), 4);
    }

    #[test]
    fn claude_dir_is_under_home() {
        assert_eq!(
            claude_dir_for_home(std::path::Path::new("/tmp/user")),
            std::path::PathBuf::from("/tmp/user/.claude")
        );
    }
}
