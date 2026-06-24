CREATE TABLE bookkeeping_budgets (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (length(month) = 7),
  category_code TEXT NOT NULL CHECK (length(trim(category_code)) > 0),
  limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK (length(currency) = 3),
  rollover INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX bookkeeping_budgets_scope_unique
  ON bookkeeping_budgets(COALESCE(project_id, ''), month, category_code);

CREATE INDEX bookkeeping_budgets_month_idx
  ON bookkeeping_budgets(month, project_id);
