//! Calendar sync timing constants.
//!
//! Local SQLite mirrors are updated immediately in `stage_calendar_write`; these
//! values only delay the background Google Calendar API flush.

/// Coalesces rapid Today timeline edits before the worker calls Google Calendar.
pub const GOOGLE_SYNC_DEBOUNCE_MS: i64 = 1_500;

/// Worker polling floor; `Notify` still wakes it immediately when queue rows change.
pub const SYNC_WORKER_TICK_MS: u64 = 200;

/// Terminal(3회 실패) 큐 행의 보존 기간 — 마지막 실패(next_attempt_at)로부터 이 시간이 지나면
/// 워커가 위생 삭제한다(P6 GC). 행은 사용자가 원인을 고쳐 명시 retry/cancel 할 수 있게
/// 보존되지만, 무기한 방치되면 큐가 "반쯤만 bounded"가 된다(감사 smell #10). 7일 노출이면 충분.
pub const PENDING_TERMINAL_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
