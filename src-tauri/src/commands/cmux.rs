//! cmux 워크스페이스 상태 — best-effort, 표시 전용.
//!
//! INVARIANT #1: cmux 데이터는 표시 전용(display-only). 결정 레일(분류/승격/실행)에 절대 사용 금지.
//! 바이너리 부재·타임아웃·비-0 종료 모두 Ok(available:false)로 graceful 처리 — 에러로 올리지 않는다.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;
use crate::platform::{self, OptionalIntegration};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxWorkspace {
    pub reference: String,
    pub title: String,
    /// cmux `claude_code` 상태 태그 값("Running"/"Needs input" 등). cmux가 추적하는 권위 신호.
    /// 태그가 없으면 None = 해당 워크스페이스에 (cmux가 인지하는) 활성 에이전트 없음 → idle.
    pub agent_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CmuxStatus {
    pub available: bool,
    pub workspaces: Vec<CmuxWorkspace>,
}

/// 워크스페이스/서피스 제목 앞의 활동 글리프를 제거한다.
/// cmux는 실행 중이면 점자 스피너(U+2800–U+28FF), 입력 대기 등이면 `✳`(U+2733)를 제목 앞에 붙인다.
/// 글리프는 표시 노이즈라 제거하고, 활성 판정은 별도 `claude_code` 상태 태그(권위 신호)로 한다.
pub(crate) fn strip_activity_glyph(title: &str) -> String {
    let t = title.trim();
    let mut chars = t.chars();
    if let Some(first) = chars.clone().next() {
        let is_glyph = ('\u{2800}'..='\u{28FF}').contains(&first) || first == '✳';
        if is_glyph {
            chars.next(); // 글리프 1자 소비
            return chars.as_str().trim_start().to_string();
        }
    }
    t.to_string()
}

/// `cmux top --format tsv` stdout → CmuxWorkspace 목록.
/// TSV 컬럼: cpu_percent, memory_bytes, process_count, kind, ref, parent_ref, title.
/// - `kind=workspace` 행 → 워크스페이스(ref·제목, 글리프 제거).
/// - `kind=tag` 이고 ref에 `:tag:claude_code` 포함 → 그 워크스페이스(parent_ref)의 에이전트 상태.
///   cmux가 추적하는 claude_code 상태 태그가 `selected`(포커스 탭)보다 훨씬 정확한 활성 신호다.
pub(crate) fn parse_cmux_top(stdout: &str) -> Vec<CmuxWorkspace> {
    let mut out: Vec<CmuxWorkspace> = Vec::new();
    let mut statuses: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for line in stdout.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 7 {
            continue;
        }
        let kind = cols[3];
        let reference = cols[4];
        let parent = cols[5];
        let title = cols[6];
        match kind {
            "workspace" => out.push(CmuxWorkspace {
                reference: reference.to_string(),
                title: strip_activity_glyph(title),
                agent_status: None,
            }),
            "tag" if reference.contains(":tag:claude_code") => {
                let value = title.trim();
                if !value.is_empty() {
                    statuses.insert(parent.to_string(), value.to_string());
                }
            }
            _ => {}
        }
    }

    // 태그 상태를 해당 워크스페이스(parent ref = "workspace:<n>")에 병합.
    for w in out.iter_mut() {
        if let Some(s) = statuses.get(&w.reference) {
            w.agent_status = Some(s.clone());
        }
    }
    out
}

/// cmux 바이너리 경로를 찾는다. PATH의 `cmux` 우선(검증용 `--version`), 없으면 Applications 번들 경로.
/// 둘 다 없으면 None.
fn resolve_cmux_bin() -> Option<std::path::PathBuf> {
    if !platform::supports_integration(platform::current_host(), OptionalIntegration::Cmux) {
        return None;
    }
    let known = [std::path::PathBuf::from(
        "/Applications/cmux.app/Contents/Resources/bin/cmux",
    )];
    platform::process_executable_candidates("cmux", &known)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// cmux 워크스페이스 상태 조회 (best-effort, 표시 전용).
/// 바이너리 부재·타임아웃·비-0 종료 → Ok(available:false, []) — 절대 Err 아님.
#[tauri::command]
#[specta::specta]
pub async fn cmux_status() -> Result<CmuxStatus, AppError> {
    let unavailable = CmuxStatus {
        available: false,
        workspaces: vec![],
    };

    let Some(bin) = resolve_cmux_bin() else {
        return Ok(unavailable);
    };

    // `cmux top`은 워크스페이스 + claude_code 상태 태그(권위 활성 신호)를 한 번에 준다.
    // process accounting이 섞여 list-workspaces보다 무겁지만 폴링이 15s라 허용(timeout 5s).
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(&bin)
            .args(["top", "--format", "tsv"])
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            Ok(CmuxStatus {
                available: true,
                workspaces: parse_cmux_top(&stdout),
            })
        }
        // 타임아웃, 비-0 종료, IO 오류 모두 graceful
        _ => Ok(unavailable),
    }
}

/// cmux 워크스페이스로 포커스 이동 (best-effort — 네비 보조, INVARIANT #1 결정 레일 무관).
/// `cmux select-workspace --workspace <ref>`. 바이너리 부재·실패는 graceful(Ok(false), 에러 아님).
#[tauri::command]
#[specta::specta]
pub async fn cmux_focus_workspace(reference: String) -> Result<bool, AppError> {
    let Some(bin) = resolve_cmux_bin() else {
        return Ok(false);
    };
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::process::Command::new(&bin)
            .args(["select-workspace", "--workspace", &reference])
            .output(),
    )
    .await;
    Ok(matches!(result, Ok(Ok(o)) if o.status.success()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_glyph_braille_spinner() {
        // 점자 스피너(running) 글리프 제거.
        assert_eq!(
            strip_activity_glyph("⠐ Execute NS cutover"),
            "Execute NS cutover"
        );
    }

    #[test]
    fn strip_glyph_attention_star() {
        // ✳(needs input 등) 글리프 제거.
        assert_eq!(
            strip_activity_glyph("✳ Review refactoring"),
            "Review refactoring"
        );
    }

    #[test]
    fn strip_glyph_none_passthrough() {
        assert_eq!(strip_activity_glyph("WORK RADAR"), "WORK RADAR");
        assert_eq!(strip_activity_glyph("~/Projects/Mono"), "~/Projects/Mono");
    }

    /// 헬퍼: TSV 한 행(7 컬럼) 생성.
    fn row(kind: &str, reference: &str, parent: &str, title: &str) -> String {
        format!("0.0\t0\t1\t{kind}\t{reference}\t{parent}\t{title}\n")
    }

    #[test]
    fn parse_top_tags_mapped_to_workspaces() {
        let mut tsv = String::new();
        tsv.push_str(&row("total", "total", "", ""));
        tsv.push_str(&row("window", "window:1", "total", ""));
        tsv.push_str(&row(
            "workspace",
            "workspace:6",
            "window:1",
            "⠐ Execute NS cutover",
        ));
        tsv.push_str(&row(
            "tag",
            "workspace:UUID6:tag:claude_code",
            "workspace:6",
            "Running",
        ));
        tsv.push_str(&row("workspace", "workspace:2", "window:1", "WORK RADAR"));
        tsv.push_str(&row(
            "workspace",
            "workspace:5",
            "window:1",
            "✳ Review mirrorless",
        ));
        tsv.push_str(&row(
            "tag",
            "workspace:UUID5:tag:claude_code",
            "workspace:5",
            "Needs input",
        ));

        let ws = parse_cmux_top(&tsv);
        assert_eq!(ws.len(), 3);

        assert_eq!(ws[0].reference, "workspace:6");
        assert_eq!(ws[0].title, "Execute NS cutover"); // 글리프 제거
        assert_eq!(ws[0].agent_status.as_deref(), Some("Running"));

        // 태그 없는 워크스페이스 → None(idle).
        assert_eq!(ws[1].reference, "workspace:2");
        assert_eq!(ws[1].title, "WORK RADAR");
        assert_eq!(ws[1].agent_status, None);

        assert_eq!(ws[2].reference, "workspace:5");
        assert_eq!(ws[2].title, "Review mirrorless");
        assert_eq!(ws[2].agent_status.as_deref(), Some("Needs input"));
    }

    #[test]
    fn parse_top_ignores_non_claude_tags_and_short_rows() {
        let mut tsv = String::new();
        tsv.push_str(&row("workspace", "workspace:1", "window:1", "Solo"));
        // 다른 태그(claude_code 아님) → 무시.
        tsv.push_str(&row("tag", "workspace:X:tag:other", "workspace:1", "Busy"));
        // 7 컬럼 미만 → 스킵.
        tsv.push_str("garbage\tline\n");

        let ws = parse_cmux_top(&tsv);
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].reference, "workspace:1");
        assert_eq!(ws[0].agent_status, None);
    }

    #[test]
    fn parse_top_empty_input() {
        assert!(parse_cmux_top("").is_empty());
    }
}
