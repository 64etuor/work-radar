-- Phase T1: per-project ticker runtime state.
-- The app is the operator clock; this table stores only ticker settings/status.
CREATE TABLE project_ticker (
  project_id          TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  tick_enabled        INTEGER NOT NULL DEFAULT 0 CHECK (tick_enabled IN (0, 1)),
  interval_sec        INTEGER CHECK (interval_sec IS NULL OR interval_sec > 0),
  max_steps           INTEGER NOT NULL DEFAULT 1 CHECK (max_steps >= 1),
  next_due_at         TEXT,
  in_progress         INTEGER NOT NULL DEFAULT 0 CHECK (in_progress IN (0, 1)),
  last_started_at     TEXT,
  last_finished_at    TEXT,
  last_outcome        TEXT,
  last_exit_code      INTEGER,
  last_report_json    TEXT,
  attention_required  INTEGER NOT NULL DEFAULT 0 CHECK (attention_required IN (0, 1))
);

CREATE INDEX idx_project_ticker_due
  ON project_ticker(tick_enabled, attention_required, next_due_at)
  WHERE tick_enabled = 1;
