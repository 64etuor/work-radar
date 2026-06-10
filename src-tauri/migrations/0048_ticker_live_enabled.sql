-- Per-project LIVE opt-in (operator consent to spawn real sessions), replacing the
-- shell-env workflow for app-driven ticks. When 1, the app injects
-- BOULE_CONDUCTOR_MODE=live + BOULE_OBSERVER_MODE=live into the spawned boule
-- tick/snapshot child for THIS project only. Default 0 = fail-closed (stub adapter,
-- nothing spawns). Shell env stays as the global fallback for CLI/cron paths.
ALTER TABLE project_ticker
  ADD COLUMN live_enabled INTEGER NOT NULL DEFAULT 0 CHECK (live_enabled IN (0, 1));
