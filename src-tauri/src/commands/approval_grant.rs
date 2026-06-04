//! 사람-게이트 증거 토큰(`HumanApproval`). External Action Gate의 실행 경로를 **사용자 승인
//! IPC**에 컴파일 레벨로 한정한다(INVARIANT #1 type-wall, `Acceptance::mint`과 동형).
//!
//! 왜: `external_actions::store::{approve,reject}`는 같은 crate 안에서 호출 가능하다. 제안
//! 생성자 모듈(`crate::mcp` 등 외부 에이전트 표면)이 `approve`를 직접 부르면 사람 게이트를
//! 우회해 커넥터를 실행시킬 수 있다(현재는 review+문서로만 금지). 이를 타입으로 봉쇄한다:
//!
//! - `approve`/`reject`는 `&HumanApproval` 참조를 **요구**한다.
//! - `HumanApproval`은 private 단위 필드 → 외부에서 구조체 리터럴로 못 만든다.
//! - 유일한 생성자 [`HumanApproval::from_ipc`]가 `pub(in crate::commands)` → **commands 모듈
//!   트리(=사람 승인 IPC)만** mint할 수 있다. `crate::mcp`는 commands 밖이라 호출 시 컴파일 에러.
//!
//! `external_actions::store`(crate-root 형제 모듈)는 이 타입을 **이름은 댈 수 있어도**(private
//! `mod commands`는 crate-root 후손에게 보임) **생성은 못 한다**(`from_ipc` 가시성 차단). 즉
//! 토큰을 "받아 통과"시킬 뿐, 스스로 만들 수 없다.
//!
//! crate-외부 노출 회귀는 `tests/compile_fail/forge_human_approval.rs`(trybuild)가 잠근다.

/// 사용자 승인 IPC에서 발급되는 실행 허가 증거. `approve`/`reject`가 참조를 요구한다.
/// 필드 private + 생성자 `pub(in crate::commands)` → commands 트리 밖에서 위조 불가.
pub struct HumanApproval(());

impl HumanApproval {
    /// 사람 승인 IPC 명령 전용 발급자. `crate::commands` 모듈 트리 밖(예: `crate::mcp`)에서
    /// 호출하면 컴파일 에러 — approve/reject로의 비-사람 경로를 타입으로 막는다.
    pub(in crate::commands) fn from_ipc() -> Self {
        HumanApproval(())
    }

    /// 단위 테스트 전용 발급자(crate `cfg(test)` 빌드에서만). 별도 trybuild crate는
    /// non-test로 컴파일되므로 이 생성자가 보이지 않아 type-wall 검증을 약화하지 않는다.
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        HumanApproval(())
    }
}
