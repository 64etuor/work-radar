//! External Action Gate (Phase 0). 모든 외부 mutation 제안의 단일 초크포인트.
//!
//! INVARIANT #1/#2 기계화: 제안자(MCP/codex/hermes)는 `store::enqueue`로 proposal만 만들고,
//! 실행은 사용자 승인 경로(`store::approve`)가 mint하는 `Acceptance` 토큰을 요구하는
//! `ExternalConnector::execute`에서만 일어난다. 토큰 생성자는 private → 승인 없이 실행 불가.

pub mod audit;
mod gate;
pub mod store;

pub use gate::{Acceptance, ExecOutcome, ExternalConnector};

use serde::{Deserialize, Serialize};
use specta::Type;

/// 외부 액션 종류 + 검증된 payload. 변형 추가 = 새 커넥터 비용 전부.
/// Phase 0는 enum 골격만 — payload 필드는 커넥터 PR(2~5)에서 채운다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum ExternalAction {
    /// Phase 0 라운드트립/테스트용 no-op. 커넥터 PR에서 실 변형으로 대체/확장.
    Noop { note: String },
    /// GitHub 이슈/PR에 코멘트(Phase 2 write). `repo`="owner/repo", `issue_number`=이슈/PR 번호.
    GithubIssueComment {
        repo: String,
        issue_number: u64,
        body: String,
    },
    /// GitHub 이슈 생성(Phase 2 write).
    GithubCreateIssue {
        repo: String,
        title: String,
        body: String,
    },
    /// Notion DB에 페이지 생성(Phase 3 write, AI-origin). `db_id`=대상 데이터베이스(원시 ID/URL —
    /// 커넥터가 정규화), `title`=페이지 제목. 사람-origin 카드 승격(`promote_to_notion`)은 기존 경로
    /// 유지 — 이 변형은 외부 에이전트 제안만 게이트로 흘린다(spec §4 이중 경로).
    NotionCreatePage { db_id: String, title: String },
}

impl ExternalAction {
    /// DB `kind` 컬럼 문자열(dispatch/표시 라벨 — payload JSON의 serde 태그와는 별개).
    pub fn kind_str(&self) -> &'static str {
        match self {
            ExternalAction::Noop { .. } => "noop",
            ExternalAction::GithubIssueComment { .. } => "github.issue_comment",
            ExternalAction::GithubCreateIssue { .. } => "github.create_issue",
            ExternalAction::NotionCreatePage { .. } => "notion.create_page",
        }
    }
}

// `Acceptance` / `ExecOutcome` / `ExternalConnector` 정의는 private 서브모듈 `gate`로
// 이동했다(Task 1.0 토큰 경화). 위 `pub use gate::{...}`로 import 경로는 그대로 유지된다.

#[cfg(test)]
mod token_tests {
    use super::*;

    #[test]
    fn acceptance_carries_action_id() {
        let a = Acceptance::mint("abc".into());
        assert_eq!(a.action_id(), "abc");
    }

    #[test]
    fn external_action_kind_str_is_stable() {
        let a = ExternalAction::Noop { note: "x".into() };
        assert_eq!(a.kind_str(), "noop");
        let n = ExternalAction::NotionCreatePage {
            db_id: "db".into(),
            title: "t".into(),
        };
        assert_eq!(n.kind_str(), "notion.create_page");
    }
}
