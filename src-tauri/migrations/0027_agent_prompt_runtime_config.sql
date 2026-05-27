-- Internal agent prompt runtime config.
-- The existing `skills` table also stores in-app prompt templates; these
-- columns are for how each internal prompt is executed by Codex.

ALTER TABLE skills
  ADD COLUMN model TEXT;

ALTER TABLE skills
  ADD COLUMN reasoning_effort TEXT
    CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low', 'medium', 'high'));

ALTER TABLE skills
  ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0
    CHECK (fast_mode IN (0, 1));
