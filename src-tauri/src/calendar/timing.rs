//! Calendar sync timing constants.
//!
//! Local SQLite mirrors are updated immediately in `stage_calendar_write`; these
//! values only delay the background Google Calendar API flush.

/// Coalesces rapid Today timeline edits before the worker calls Google Calendar.
pub const GOOGLE_SYNC_DEBOUNCE_MS: i64 = 1_500;

/// Worker polling floor; `Notify` still wakes it immediately when queue rows change.
pub const SYNC_WORKER_TICK_MS: u64 = 200;
