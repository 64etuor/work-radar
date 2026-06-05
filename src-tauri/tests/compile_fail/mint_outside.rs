// external_actions 모듈 트리 **밖**(integration test crate)에서 mint 호출 → 컴파일 실패해야 함.
// `Acceptance` 타입 자체는 pub이라 보이지만, `mint`은 `pub(in crate::external_actions)`라
// 이 위치에서 접근 불가 = "private function `mint`" 에러로 컴파일이 실패한다(type-wall).
fn main() {
    let _ = work_radar_lib::external_actions::Acceptance::mint("x".into());
}
