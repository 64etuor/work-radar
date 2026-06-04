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
