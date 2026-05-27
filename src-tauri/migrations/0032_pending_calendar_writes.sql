-- Phase: Today×Timeline merge PR 1 (PR 2에서 sync 워커가 사용).
-- spec §6: 같은 target+kind 후속 update는 머지 (UNIQUE로 보장).
-- staged=true payload는 워커가 skip → cross-cal 변경의 명시 Acceptance 게이트.

CREATE TABLE pending_calendar_writes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('create','patch','delete')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('signal','routine_check')),
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

CREATE INDEX idx_pending_due ON pending_calendar_writes(next_attempt_at);
