-- Calendar-sync unification (P2): allow routine MASTER series to use the same deferred write queue
-- as one-off events and per-day routine checks. SQLite cannot ALTER a CHECK constraint, so rebuild
-- the table (mirrors 0033) and preserve queued rows. Only the target_kind CHECK changes —
-- 'routine_master' is added (target_id = routine id, no `routine_id|date` pipe).

CREATE TABLE pending_calendar_writes_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('create','patch','delete')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('signal','routine_check','event','routine_master')),
  target_id       TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  event_id        TEXT,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(target_kind, target_id, kind)
);

INSERT INTO pending_calendar_writes_new
  (id, kind, target_kind, target_id, calendar_id, event_id, payload_json,
   attempts, next_attempt_at, last_error, created_at)
SELECT
  id, kind, target_kind, target_id, calendar_id, event_id, payload_json,
  attempts, next_attempt_at, last_error, created_at
FROM pending_calendar_writes;

DROP TABLE pending_calendar_writes;
ALTER TABLE pending_calendar_writes_new RENAME TO pending_calendar_writes;

CREATE INDEX idx_pending_due ON pending_calendar_writes(next_attempt_at);
