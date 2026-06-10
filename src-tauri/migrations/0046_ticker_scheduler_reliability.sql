-- Ticker scheduler reliability: bounded infra-failure escalation + scheduler heartbeat.
-- consecutive_failures counts back-to-back infra-class tick failures (spawn/timeout/parse/
-- readiness/infra); at the threshold the row raises attention_required, which removes it from
-- the auto due-scan (bounded retry, terminal failure surfaced). Reset to 0 on any success or
-- governance outcome.
ALTER TABLE project_ticker
  ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

-- Single-row heartbeat written by the app-bound ticker scheduler on every wake. Lets the
-- Control Room distinguish "scheduler alive" from "scheduler dead/disabled" (previously
-- invisible outside tracing logs).
CREATE TABLE ticker_scheduler_status (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_wake_at  TEXT NOT NULL,
  scan_ok       INTEGER NOT NULL CHECK (scan_ok IN (0, 1)),
  runner_ok     INTEGER NOT NULL CHECK (runner_ok IN (0, 1)),
  runner_error  TEXT,
  fired         INTEGER NOT NULL DEFAULT 0
);
