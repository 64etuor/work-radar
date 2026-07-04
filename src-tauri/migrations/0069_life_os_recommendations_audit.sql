-- Durable Life OS recommendations and audit events.
-- AI/recommendation output remains proposal state; user action accepts or dismisses.

CREATE TABLE life_os_recommendations (
  id            TEXT PRIMARY KEY,
  snapshot_id   TEXT REFERENCES life_os_snapshots(id) ON DELETE CASCADE,
  week_start    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('weekly_focus','guardrail_recovery','q1_prevention','q3_containment','decision_task','shrink_focus')),
  title         TEXT NOT NULL,
  reason        TEXT,
  source_kind   TEXT CHECK (source_kind IS NULL OR source_kind IN ('signal','objective','key_result','horizon','pattern','sprint','manual')),
  source_id     TEXT,
  confidence    INTEGER NOT NULL DEFAULT 60 CHECK (confidence >= 0 AND confidence <= 100),
  payload_json  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','dismissed')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE life_os_audit_events (
  id           TEXT PRIMARY KEY,
  week_start   TEXT NOT NULL,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('weekly_focus','recommendation','guardrail','signal','sprint')),
  target_id    TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('done','dismissed','too_large','wrong_priority','blocked','accurate')),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_life_os_recommendations_week ON life_os_recommendations(week_start, status, kind);
CREATE INDEX idx_life_os_recommendations_snapshot ON life_os_recommendations(snapshot_id);
CREATE INDEX idx_life_os_audit_events_week ON life_os_audit_events(week_start, created_at);
