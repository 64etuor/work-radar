//! `Acceptance::mint`이 external_actions 모듈 트리 밖에서 호출 불가함을 컴파일 레벨로 잠근다.
//!
//! Task 1.0(토큰 type-wall): mint은 `pub(in crate::external_actions)`라 같은 crate의 다른
//! 모듈(mcp/commands)·외부 integration-test crate 어디서도 호출하면 컴파일 실패해야 한다.
//! 아래 fixture가 의도대로 컴파일에 실패함을 trybuild가 검증한다.
#[test]
fn mint_is_unreachable_outside_module() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/mint_outside.rs");
}

/// `HumanApproval`(사람-게이트 증거 토큰)이 crate 밖에서 위조 불가함을 컴파일 레벨로 잠근다.
///
/// approve/reject가 이 토큰 참조를 요구하므로, 토큰을 만들 수 없는 호출자는 사람 게이트를
/// 우회할 수 없다(`crate::mcp` 등 제안 모듈 포함 — commands 트리 밖). fixture가 crate-외부에서
/// `from_ipc` 호출 → 컴파일 실패함을 검증한다(mint_outside와 동형 type-wall 회귀 가드).
#[test]
fn human_approval_is_unforgeable_outside_crate() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/forge_human_approval.rs");
}
