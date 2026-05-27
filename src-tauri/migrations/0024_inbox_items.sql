-- Work Radar — schema v24 (Unified Inbox foundation)
-- Local operational memory for user-visible alerts, AI escalations, workflow
-- failures, review requests, reminders, and native notification mirrors.
--
-- INVARIANT #1: Inbox is not a decision rail. Rows may recommend, summarize,
-- deep-link, or expose actions, but they never auto-classify matrix quadrants.
-- INVARIANT #7: Inbox read/dismiss/grouping state is local SQLite SSOT.

PRAGMA foreign_keys = ON;

CREATE TABLE inbox_items (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source              TEXT NOT NULL,
  source_id           TEXT,
  group_key           TEXT,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL DEFAULT '',
  summary             TEXT,
  priority            TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  severity            TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','read','dismissed','archived')),
  unread              INTEGER NOT NULL DEFAULT 1 CHECK (unread IN (0,1)),
  related_entity_type TEXT,
  related_entity_id   TEXT,
  action_payload      TEXT,
  read_at             TEXT,
  dismissed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_inbox_source_dedup
  ON inbox_items(source, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX idx_inbox_status_updated
  ON inbox_items(status, unread, updated_at DESC);

CREATE INDEX idx_inbox_project
  ON inbox_items(project_id, updated_at DESC);

CREATE INDEX idx_inbox_group
  ON inbox_items(group_key, updated_at DESC)
  WHERE group_key IS NOT NULL;
