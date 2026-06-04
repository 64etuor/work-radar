//! External Action Gate (Phase 0). 모든 외부 mutation 제안의 단일 초크포인트.
//!
//! INVARIANT #1/#2 기계화: 제안자(MCP/codex/hermes)는 `store::enqueue`로 proposal만 만들고,
//! 실행은 사용자 승인 경로(`store::approve`)가 mint하는 `Acceptance` 토큰을 요구하는
//! `ExternalConnector::execute`에서만 일어난다. 토큰 생성자는 private → 승인 없이 실행 불가.

pub mod audit;
pub mod store;

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

/// 승인 증거 토큰. **생성자 private** — `store::approve`만 mint한다.
/// 커넥터 `execute`가 이 참조를 요구 → 승인 없이 실행 호출이 타입상 불가능.
#[derive(Debug)]
pub struct Acceptance {
    action_id: String,
}

impl Acceptance {
    /// crate-internal mint. 승인 경로(store)에서만 호출. 외부 모듈은 생성 불가.
    pub(crate) fn mint(action_id: String) -> Self {
        Acceptance { action_id }
    }
    pub fn action_id(&self) -> &str {
        &self.action_id
    }
}

/// 외부 응답 메타(본문/시크릿 금지). 커넥터가 반환, store가 result 컬럼/audit에 기록.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    /// 외부 리소스 식별자(예: PR 번호, 페이지 id) — 식별자만, 본문 금지.
    pub external_ref: Option<String>,
    /// 감사 detail용 크기 힌트(bytes). PII 아님.
    pub bytes: Option<i64>,
}

/// 커넥터 실행 seam. `_gate: &Acceptance` 인자가 승인 강제(INVARIANT #2).
/// Phase 0는 구현체 없이 트레잇만 — `MockConnector`(test)와 Phase 2~5 실 커넥터가 impl.
#[allow(async_fn_in_trait)]
pub trait ExternalConnector {
    async fn execute(
        &self,
        action: &ExternalAction,
        _gate: &crate::external_actions::Acceptance,
    ) -> Result<ExecOutcome, crate::error::AppError>;
}

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
