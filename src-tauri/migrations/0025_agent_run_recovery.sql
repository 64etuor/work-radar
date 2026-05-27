-- Work Radar — schema v25 (agent run recovery)
-- Adds heartbeat/recovery metadata so jobs can be reconciled after app restart
-- or process loss. State remains SQLite SSOT.

PRAGMA foreign_keys = ON;

ALTER TABLE agent_runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE agent_runs ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN lock_path TEXT;

CREATE INDEX idx_agent_runs_recovery
  ON agent_runs(status, heartbeat_at, started_at);
