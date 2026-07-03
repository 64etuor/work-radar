-- Mission / OKR backend foundation.
-- Scope: local SQLite SSOT for Mission -> quarterly Objectives -> Key Results -> weekly check-ins.
-- No signals schema changes; objectives link to existing signals by area/project metadata at query time.

CREATE TABLE missions (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  statement  TEXT NOT NULL,
  note       TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE objectives (
  id                 TEXT PRIMARY KEY,
  quarter            TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  sort_rank          INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  closed_reflection  TEXT,
  linked_area_keys   TEXT NOT NULL DEFAULT '[]',
  linked_project_ids TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_objectives_quarter ON objectives(quarter, sort_rank);
CREATE INDEX idx_objectives_status ON objectives(status);

CREATE TABLE key_results (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('metric','milestone')),
  target_value  REAL,
  current_value REAL,
  unit          TEXT,
  milestones    TEXT,
  sort_rank     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_key_results_objective ON key_results(objective_id, sort_rank);

CREATE TABLE okr_check_ins (
  id             TEXT PRIMARY KEY,
  key_result_id  TEXT NOT NULL REFERENCES key_results(id) ON DELETE CASCADE,
  week_start     TEXT NOT NULL,
  value_snapshot REAL NOT NULL,
  confidence     TEXT NOT NULL CHECK (confidence IN ('on_track','at_risk','off_track')),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(key_result_id, week_start)
) STRICT;

CREATE INDEX idx_okr_check_ins_key_result ON okr_check_ins(key_result_id, week_start);
