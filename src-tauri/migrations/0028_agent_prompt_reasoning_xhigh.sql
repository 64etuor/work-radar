-- Extend internal prompt reasoning effort to match current Codex catalog.
-- SQLite cannot alter a column CHECK constraint in place, so rebuild skills.

PRAGMA foreign_keys = ON;

CREATE TABLE skills_new (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('in_app_prompt','external')),
  prompt           TEXT,
  binding          TEXT,
  rail             TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  source_path      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  model            TEXT,
  reasoning_effort TEXT
    CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high', 'xhigh')),
  fast_mode        INTEGER NOT NULL DEFAULT 0 CHECK (fast_mode IN (0, 1))
);

INSERT INTO skills_new (
  id,
  name,
  kind,
  prompt,
  binding,
  rail,
  enabled,
  source_path,
  created_at,
  updated_at,
  model,
  reasoning_effort,
  fast_mode
)
SELECT
  id,
  name,
  kind,
  prompt,
  binding,
  rail,
  enabled,
  source_path,
  created_at,
  updated_at,
  model,
  reasoning_effort,
  fast_mode
FROM skills;

DROP TABLE skills;

ALTER TABLE skills_new RENAME TO skills;

CREATE UNIQUE INDEX idx_skills_binding ON skills (binding) WHERE binding IS NOT NULL;
CREATE INDEX idx_skills_kind ON skills (kind);
