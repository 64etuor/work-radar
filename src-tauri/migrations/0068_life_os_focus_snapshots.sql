-- Life OS weekly focus, sprint-cycle bridge, and recommendation snapshots.
-- Weekly focus is durable planning state; sprint config remains the countdown/display config.

CREATE TABLE weekly_focuses (
  id                 TEXT PRIMARY KEY,
  week_start         TEXT NOT NULL,
  title              TEXT NOT NULL,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('signal','objective','key_result','horizon','pattern','sprint','manual')),
  source_id          TEXT,
  objective_id       TEXT REFERENCES objectives(id) ON DELETE SET NULL,
  key_result_id      TEXT REFERENCES key_results(id) ON DELETE SET NULL,
  horizon_id         TEXT REFERENCES mission_horizons(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'selected' CHECK (status IN ('proposed','selected','done','missed','dismissed','shrunk')),
  estimated_minutes  INTEGER,
  reason             TEXT,
  must_do_signal_ids TEXT NOT NULL DEFAULT '[]',
  not_do_signal_ids  TEXT NOT NULL DEFAULT '[]',
  guardrail_ids      TEXT NOT NULL DEFAULT '[]',
  shrink_count       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE sprint_cycles (
  id                 TEXT PRIMARY KEY,
  sprint_key         TEXT NOT NULL UNIQUE,
  start_at           TEXT NOT NULL,
  end_at             TEXT NOT NULL,
  interval_days      INTEGER NOT NULL,
  anchor_weekday     TEXT NOT NULL,
  anchor_time        TEXT NOT NULL,
  goal               TEXT,
  weekly_focus_id    TEXT REFERENCES weekly_focuses(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE TABLE life_os_snapshots (
  id                  TEXT PRIMARY KEY,
  week_start          TEXT NOT NULL,
  quarter             TEXT NOT NULL,
  range_start         TEXT NOT NULL,
  range_end           TEXT NOT NULL,
  diagnosis_json      TEXT NOT NULL,
  recommendation_json TEXT,
  source_hash         TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (week_start, quarter, source_hash)
) STRICT;

CREATE TABLE life_os_dismissals (
  id           TEXT PRIMARY KEY,
  week_start   TEXT NOT NULL,
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('signal','pattern','guardrail','objective','horizon')),
  target_key   TEXT NOT NULL,
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (week_start, target_kind, target_key)
) STRICT;

CREATE INDEX idx_weekly_focuses_week ON weekly_focuses(week_start, status);
CREATE UNIQUE INDEX idx_weekly_focus_selected_unique
  ON weekly_focuses(week_start)
  WHERE status = 'selected';
CREATE INDEX idx_sprint_cycles_status ON sprint_cycles(status, end_at);
CREATE INDEX idx_life_os_snapshots_week ON life_os_snapshots(week_start, quarter);
