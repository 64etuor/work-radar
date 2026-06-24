ALTER TABLE bookkeeping_category_alias
  ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE bookkeeping_category_alias
  ADD COLUMN last_used_at TEXT;
