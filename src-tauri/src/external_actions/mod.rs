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
}

impl ExternalAction {
    /// DB `kind` 컬럼 문자열(예: "noop", 후속 "github.comment").
    pub fn kind_str(&self) -> &'static str {
        match self {
            ExternalAction::Noop { .. } => "noop",
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
    }
}
