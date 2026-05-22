//! cmux 워크스페이스 상태 — best-effort, 표시 전용.
//!
//! INVARIANT #1: cmux 데이터는 표시 전용(display-only). 결정 레일(분류/승격/실행)에 절대 사용 금지.
//! 바이너리 부재·타임아웃·비-0 종료 모두 Ok(available:false)로 graceful 처리 — 에러로 올리지 않는다.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxWorkspace {
    pub reference: String,
    pub title: String,
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxStatus {
    pub available: bool,
    pub workspaces: Vec<CmuxWorkspace>,
}

/// `cmux list-workspaces` stdout → CmuxWorkspace 목록.
/// 순수 파서: 빈 줄 건너뜀, `* ` 접두 = selected, `workspace:<n>` ref 추출,
/// 나머지 = 제목(leading `✳ ` glyph · trailing ` [selected]` 제거).
pub(crate) fn parse_cmux_workspaces(stdout: &str) -> Vec<CmuxWorkspace> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // selected 마커
        let (selected, rest) = if let Some(s) = line.strip_prefix("* ") {
            (true, s)
        } else {
            // 비-selected 줄은 선행 공백 있을 수 있음
            (false, line.trim_start_matches(' '))
        };

        // `workspace:<n>` ref 추출
        let Some(ws_pos) = rest.find("workspace:") else {
            continue;
        };
        let after_ws = &rest[ws_pos..];
        // ref = "workspace:<n>" (공백까지)
        let ref_end = after_ws
            .find(|c: char| c.is_whitespace())
            .unwrap_or(after_ws.len());
        let reference = after_ws[..ref_end].to_string();

        // 제목: ref 이후 공백 두 개 건너뜀
        let title_raw = after_ws[ref_end..].trim_start();
        // 선행 ✳ glyph 제거 (U+2733 + 공백 또는 단독)
        let title_after_glyph = title_raw
            .strip_prefix("✳ ")
            .or_else(|| title_raw.strip_prefix('✳'))
            .unwrap_or(title_raw);
        // 후행 ` [selected]` 제거
        let title = title_after_glyph
            .strip_suffix(" [selected]")
            .unwrap_or(title_after_glyph)
            .trim()
            .to_string();

        out.push(CmuxWorkspace {
            reference,
            title,
            selected,
        });
    }
    out
}

/// cmux 바이너리 경로를 찾는다. PATH의 `cmux` 우선(검증용 `--version`), 없으면 Applications 번들 경로.
/// 둘 다 없으면 None.
fn resolve_cmux_bin() -> Option<std::path::PathBuf> {
    // 1) PATH에서 `cmux` 검색: `/usr/bin/env cmux --version` 으로 존재 확인 후 절대 경로 획득
    //    (which 크레이트 없이 OS 경로 탐색)
    let path_dirs = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_dirs) {
        let candidate = dir.join("cmux");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // 2) Applications 번들 고정 경로
    let bundle = std::path::PathBuf::from("/Applications/cmux.app/Contents/Resources/bin/cmux");
    if bundle.exists() {
        return Some(bundle);
    }
    None
}

/// cmux 워크스페이스 상태 조회 (best-effort, 표시 전용).
/// 바이너리 부재·타임아웃·비-0 종료 → Ok(available:false, []) — 절대 Err 아님.
#[tauri::command]
#[specta::specta]
pub async fn cmux_status() -> Result<CmuxStatus, String> {
    let unavailable = CmuxStatus {
        available: false,
        workspaces: vec![],
    };

    let Some(bin) = resolve_cmux_bin() else {
        return Ok(unavailable);
    };

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::process::Command::new(&bin)
            .arg("list-workspaces")
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(CmuxStatus {
                available: true,
                workspaces: parse_cmux_workspaces(&stdout),
            })
        }
        // 타임아웃, 비-0 종료, IO 오류 모두 graceful
        _ => Ok(unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_selected_workspace() {
        let stdout = "* workspace:1  WORK RADAR  [selected]\n";
        let ws = parse_cmux_workspaces(stdout);
        assert_eq!(ws.len(), 1);
        assert!(ws[0].selected);
        assert_eq!(ws[0].reference, "workspace:1");
        assert_eq!(ws[0].title, "WORK RADAR");
    }

    #[test]
    fn parse_unselected_with_glyph() {
        let stdout = "  workspace:8  ✳ Some title\n";
        let ws = parse_cmux_workspaces(stdout);
        assert_eq!(ws.len(), 1);
        assert!(!ws[0].selected);
        assert_eq!(ws[0].reference, "workspace:8");
        assert_eq!(ws[0].title, "Some title");
    }

    #[test]
    fn parse_multiple_workspaces() {
        let stdout =
            "* workspace:1  WORK RADAR  [selected]\n  workspace:8  ✳ Some title\n  workspace:2  Other\n";
        let ws = parse_cmux_workspaces(stdout);
        assert_eq!(ws.len(), 3);
        assert!(ws[0].selected);
        assert_eq!(ws[0].reference, "workspace:1");
        assert_eq!(ws[0].title, "WORK RADAR");
        assert!(!ws[1].selected);
        assert_eq!(ws[1].reference, "workspace:8");
        assert_eq!(ws[1].title, "Some title");
        assert!(!ws[2].selected);
        assert_eq!(ws[2].reference, "workspace:2");
        assert_eq!(ws[2].title, "Other");
    }

    #[test]
    fn parse_empty_input() {
        let ws = parse_cmux_workspaces("");
        assert!(ws.is_empty());
    }

    #[test]
    fn parse_empty_lines_ignored() {
        let stdout = "\n  workspace:3  Hello\n\n";
        let ws = parse_cmux_workspaces(stdout);
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].title, "Hello");
    }
}
