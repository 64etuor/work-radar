//! 승인 토큰 경계. `mint`은 external_actions 모듈 트리 안에서만 호출 가능(`store::approve`).
//! 밖(mcp/commands 등)에서의 mint/직접 execute는 컴파일 불가 — INVARIANT #1/#2 type-wall.
//!
//! Task 1.0(Phase 1 진입): Phase 0의 `pub(crate)` mint를 `pub(in crate::external_actions)`로
//! 좁혀, 같은 crate에 들어오는 `mcp` 모듈조차 토큰을 위조하지 못하게 한다(trybuild로 잠금).

use serde::{Deserialize, Serialize};
use specta::Type;

/// 승인 증거 토큰. **생성자 module-private** — `store::approve`만 mint한다.
/// 커넥터 `execute`가 이 참조를 요구 → 승인 없이 실행 호출이 타입상 불가능.
#[derive(Debug)]
pub struct Acceptance {
    // action_id는 승인된 액션 식별자를 토큰에 묶어 운반한다(감사 상관/검증용). Phase 0는
    // NoopConnector가 읽지 않지만 Phase 2~5 실 커넥터가 `gate.action_id()`로 읽는다 →
    // 프로덕션 빌드에선 아직 미사용이라 not(test) dead_code 허용(audit_log.rs 관례).
    #[cfg_attr(not(test), allow(dead_code))]
    action_id: String,
}

impl Acceptance {
    /// external_actions 모듈 트리 전용 mint. 외부 모듈(mcp/commands 등)에서 호출 시 컴파일 에러.
    pub(in crate::external_actions) fn mint(action_id: String) -> Self {
        Acceptance { action_id }
    }
    /// 승인된 액션 id. Phase 2~5 커넥터가 외부 호출 상관/멱등에 사용.
    #[cfg_attr(not(test), allow(dead_code))]
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
        action: &crate::external_actions::ExternalAction,
        _gate: &Acceptance,
    ) -> Result<ExecOutcome, crate::error::AppError>;
}
