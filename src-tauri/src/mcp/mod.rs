//! work-radar 앱 내장 stdio MCP 서버(External Action Gate Phase 1, **proposal-only by default**).
//!
//! 외부 AI 에이전트(Claude Code / Codex / Hermes)가 `work-radar --mcp-stdio`로 spawn해 등록한다.
//! - read 툴  = DB 조회(메타만 — 토큰/payload 본문 미노출).
//! - 외부 서비스 write tool = `store::enqueue`만 호출(제안 생성). 커넥터 `execute`/`Acceptance::mint`
//!   경로 **없음** — 모듈 경계 + Task 1.0 토큰 type-wall(`pub(in crate::external_actions)`)로 컴파일 강제.
//!
//! 승인/실행은 work-radar GUI(같은 DB의 승인 패널)와 Rust 커넥터(Phase 2~5)가 담당한다.
//!
//! ## 모듈 지도
//!
//! - `tools/` — 도메인별 툴 표면. 각 모듈이 자기 DTO·정제 로직·스키마 테스트를 소유한다.
//! - `write_routing` — 외부 서비스 write의 proposal-only 단일 관문.
//! - `run` — `--mcp-stdio` 진입점.
//!
//! **툴 추가 = 해당 도메인 모듈 + `WrServer::tool_router()` + `surface_tests`의 이름 스냅샷.**
//! 세 곳이 함께 바뀌지 않으면 테스트가 깨진다(표면 drift 방지, mcp-server-conventions §8).

pub mod run;
pub mod tools;
pub(crate) mod write_routing;

#[cfg(test)]
mod surface_tests;

use rmcp::handler::server::router::tool::ToolRouter;
use rmcp::{tool_handler, ServerHandler};
use serde::Serialize;

use crate::db::Db;
use crate::models::ProjectKind;

// 통합 테스트(`tests/mcp_roundtrip.rs`)와 기존 호출부가 `work_radar_lib::mcp::{...}`로 접근하던
// DTO 표면을 그대로 유지한다 — 모듈 분할은 순수 이동이며 공개 경로를 바꾸지 않는다.
pub use tools::bookkeeping::*;
pub use tools::bookkeeping_budgets::*;
pub use tools::bookkeeping_transactions::*;
pub use tools::calendar::*;
pub use tools::diet::*;
pub use tools::diet_manage::*;
pub use tools::github::*;
pub use tools::gmail::*;
pub use tools::notion::*;
pub use tools::okr::*;
pub use tools::queue::*;
pub use tools::reading::*;
pub use tools::signals::*;
pub use tools::today::*;
pub use tools::workout::*;

/// MCP 서버 상태 — 앱과 동일한 SQLite 풀을 보유(별도 DB 아님).
#[derive(Clone)]
pub struct WrServer {
    pub db: Db,
}

impl WrServer {
    /// 전체 MCP 툴 표면 = 도메인 라우터의 합. `#[tool_handler]`의 `router` 기본값이
    /// `Self::tool_router()`이므로 이 함수가 서버가 광고하는 툴 목록의 단일 진실원이다.
    /// 런타임 동적 registration은 없다(rug pull 방어 — mcp-server-conventions §1).
    pub fn tool_router() -> ToolRouter<Self> {
        Self::tool_router_queue()
            + Self::tool_router_github()
            + Self::tool_router_notion()
            + Self::tool_router_calendar()
            + Self::tool_router_gmail()
            + Self::tool_router_bookkeeping()
            + Self::tool_router_bookkeeping_budgets()
            + Self::tool_router_bookkeeping_transactions()
            + Self::tool_router_diet()
            + Self::tool_router_diet_manage()
            + Self::tool_router_reading()
            + Self::tool_router_signals()
            + Self::tool_router_okr()
            + Self::tool_router_today()
            + Self::tool_router_workout()
    }
}

#[tool_handler]
impl ServerHandler for WrServer {}

/// Serialize a closed serde enum to its wire string (e.g. BookkeepingDirection → "expense").
pub(crate) fn enum_wire_string<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// 사용자 자유 텍스트를 read 툴 표면에 실을 때의 상한(§6: tool output에 장문 echo 금지 —
/// output도 다음 툴의 injection 입력이 될 수 있다). char 경계에서 자른다(바이트 슬라이스 금지).
///
/// 반환 길이는 **항상 `max_chars` 이하**다 — 잘릴 때는 말줄임표까지 포함해서 센다.
/// (예전엔 `max_chars`개를 취한 뒤 "…"를 덧붙여 `max_chars + 1`이 나왔고, 필드 doc의 "≤N"이 거짓이었다.)
pub(crate) fn truncate_preview(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    if max_chars == 0 {
        return String::new();
    }
    text.chars().take(max_chars - 1).collect::<String>() + "…"
}

/// 'YYYY-MM-DD'를 강제하고 파싱한다(§2 — 자유 문자열을 좁힌다). 하위 스토어는 대개 문자열 비교라
/// 잘못된 날짜가 조용히 빈 결과가 된다 — caller는 그걸 "그날 아무것도 없다"로 오해한다.
#[allow(clippy::result_large_err)]
pub(crate) fn parse_iso_date(raw: &str) -> Result<chrono::NaiveDate, rmcp::ErrorData> {
    chrono::NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").map_err(|_| {
        rmcp::ErrorData::invalid_params(format!("date must be YYYY-MM-DD (got: {raw})"), None)
    })
}

/// ProjectKind → 안정 라벨 문자열(MCP 표면 전용 — serde 태그와 동일 의미).
pub(crate) fn project_kind_str(kind: ProjectKind) -> &'static str {
    match kind {
        ProjectKind::Personal => "personal",
        ProjectKind::Work => "work",
    }
}

/// 툴 에러 → rmcp internal-error 매핑. **PII-free**: AppError.code만 노출/기록하고
/// message/payload 본문은 절대 넣지 않는다. trace_id는 로그 상관용으로 stderr에만.
/// stderr 기록(stdout 아님 — stdout은 MCP 프로토콜 전용)으로 삼킨 에러가 완전히 안 보이는 일은 없게 한다.
pub(crate) fn mcp_tool_error(tool: &str, e: &crate::error::AppError) -> rmcp::ErrorData {
    eprintln!(
        "[work-radar mcp-stdio] {tool} error: code={} trace_id={}",
        e.code, e.trace_id
    );
    rmcp::ErrorData::internal_error(format!("tool error ({})", e.code), None)
}

#[cfg(test)]
mod preview_tests {
    use super::truncate_preview;

    #[test]
    fn preview_never_exceeds_the_advertised_char_budget() {
        assert_eq!(truncate_preview("abc", 5), "abc", "짧으면 그대로");
        assert_eq!(truncate_preview("abcde", 5), "abcde", "경계는 무손실");
        assert_eq!(truncate_preview("abcdef", 5), "abcd…", "말줄임표 포함 5자");
        assert_eq!(truncate_preview("abcdef", 5).chars().count(), 5);
        assert_eq!(truncate_preview("", 0), "");
        assert_eq!(
            truncate_preview("a", 0),
            "",
            "0 예산이면 빈 문자열(패닉 금지)"
        );
    }

    /// 멀티바이트에서 바이트 슬라이스로 패닉하지 않고 char 단위로 자른다.
    #[test]
    fn preview_cuts_on_char_boundaries() {
        let korean = "가나다라마";
        assert_eq!(truncate_preview(korean, 3), "가나…");
        assert_eq!(truncate_preview(korean, 3).chars().count(), 3);
        let emoji = "👩‍🚀🚀🚀🚀";
        assert!(truncate_preview(emoji, 2).chars().count() <= 2);
    }
}
