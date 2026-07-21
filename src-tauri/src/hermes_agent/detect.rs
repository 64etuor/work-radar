use crate::error::AppError;
use crate::platform::{self, OptionalIntegration};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HermesDetectResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub acp_ready: bool,
    pub error: Option<String>,
}

pub fn parse_version(s: &str) -> Option<String> {
    s.split_whitespace()
        .find(|tok| tok.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(String::from)
}

async fn run_with_timeout(cmd: &mut Command, secs: u64) -> Option<std::process::Output> {
    timeout(Duration::from_secs(secs), cmd.output())
        .await
        .ok()
        .and_then(|r| r.ok())
}

pub async fn detect() -> Result<HermesDetectResult, AppError> {
    if !platform::supports_integration(platform::current_host(), OptionalIntegration::Hermes) {
        return Ok(HermesDetectResult {
            installed: false,
            version: None,
            path: None,
            acp_ready: false,
            error: Some("Hermes is not supported on this platform".into()),
        });
    }

    let mut detected = None;
    for candidate in platform::process_executable_candidates("hermes", &[]) {
        let mut version_cmd = Command::new(&candidate);
        version_cmd.arg("--version");
        if let Some(output) = run_with_timeout(&mut version_cmd, 5).await {
            detected = Some((candidate, output));
            break;
        }
    }
    let Some((hermes_bin, out)) = detected else {
        return Ok(HermesDetectResult {
            installed: false,
            version: None,
            path: None,
            acp_ready: false,
            error: Some("hermes binary not found in PATH".into()),
        });
    };
    if !out.status.success() {
        return Ok(HermesDetectResult {
            installed: false,
            version: None,
            path: None,
            acp_ready: false,
            error: Some(String::from_utf8_lossy(&out.stderr).to_string()),
        });
    }
    let version_text = String::from_utf8_lossy(&out.stdout);
    let version = parse_version(&version_text);

    let path = Some(hermes_bin.to_string_lossy().into_owned());

    // 3. acp ready
    let mut acp_cmd = Command::new(&hermes_bin);
    acp_cmd.arg("acp").arg("--check");
    let acp_out = run_with_timeout(&mut acp_cmd, 5).await;
    let acp_ready = acp_out.as_ref().is_some_and(|o| o.status.success());

    let error = if !acp_ready {
        acp_out
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stderr).trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    Ok(HermesDetectResult {
        installed: true,
        version,
        path,
        acp_ready,
        error,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_detect() -> Result<HermesDetectResult, AppError> {
    detect().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_version_extracts_numeric_token() {
        assert_eq!(parse_version("hermes 0.42.1\n"), Some("0.42.1".to_string()));
        assert_eq!(
            parse_version("Hermes Agent 0.42.1-rc1"),
            Some("0.42.1-rc1".to_string())
        );
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("no numbers here"), None);
    }
}
