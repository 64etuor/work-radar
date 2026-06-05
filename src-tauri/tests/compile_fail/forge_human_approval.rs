// HumanApproval(사람-게이트 증거 토큰)을 crate **밖**에서 위조 시도 → 컴파일 실패해야 함.
//
// `HumanApproval`은 private 단위 필드 + 생성자 `from_ipc`가 `pub(in crate::commands)`이고,
// `commands` 모듈 자체가 crate-private(`mod commands;`)이다. 따라서 외부 crate(이 integration
// test)에서는 토큰도 그 생성자도 접근 불가 → approve/reject로의 비-사람(우회) 경로가 봉쇄됨을
// 컴파일 레벨로 증명한다(INVARIANT #1 type-wall, mint_outside.rs와 동형).
fn main() {
    let _ = work_radar_lib::commands::approval_grant::HumanApproval::from_ipc();
}
