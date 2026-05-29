//! Routines 도메인 — Google Calendar 동기화 보조 모듈.
//!
//! - `rrule`: 순수 RRULE/EXDATE 매핑 + Google `events.insert` 페이로드 part 변환.
//!   IPC 진입점은 `commands::routines::google_sync`.
//!
//! 결정 이력: docs/adr/0005-routine-google-sync.md.
//! 플랜: docs/plans/2026-05-29-routine-google-sync.md.

pub mod rrule;
