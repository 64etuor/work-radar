//! Routines 도메인 — Google Calendar 동기화 보조 모듈.
//!
//! PR 1 범위: 순수 RRULE 매핑 함수 (`rrule`). IPC/네트워크는 후속 PR에서 추가.
//! 결정 이력: docs/adr/0005-routine-google-sync.md.
//! 플랜: docs/plans/2026-05-29-routine-google-sync.md.

// PR 1: pure mapping + tests. PR 2 IPC consumer가 붙기 전까지 라이브러리 외부 사용 없음
// → 모듈 단위 dead_code 허용. PR 2 머지 시 제거.
#[allow(dead_code)]
pub mod rrule;
