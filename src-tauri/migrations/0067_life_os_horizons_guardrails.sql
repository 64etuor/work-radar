-- Life OS long-term direction and guardrails.
-- Scope: local SQLite SSOT for Mission horizons and quarterly defensive minima.

CREATE TABLE mission_horizons (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  horizon_kind TEXT NOT NULL CHECK (horizon_kind IN ('three_year','one_year','someday')),
  wsc_kind     TEXT CHECK (wsc_kind IN ('w','s','c')),
  area_keys    TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  sort_rank    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE objective_horizon_links (
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  horizon_id   TEXT NOT NULL REFERENCES mission_horizons(id) ON DELETE CASCADE,
  PRIMARY KEY (objective_id, horizon_id)
) STRICT;

CREATE TABLE okr_guardrails (
  id                 TEXT PRIMARY KEY,
  quarter            TEXT NOT NULL,
  area_key           TEXT NOT NULL,
  label              TEXT NOT NULL,
  target_kind        TEXT NOT NULL CHECK (target_kind IN ('routine_count','weekly_minutes','manual_check')),
  target_value       REAL,
  unit               TEXT,
  source_routine_ids TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
  sort_rank          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_guardrails_quarter ON okr_guardrails(quarter, sort_rank);
CREATE INDEX idx_horizons_status ON mission_horizons(status, sort_rank);
