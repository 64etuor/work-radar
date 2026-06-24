CREATE TABLE bookkeeping_reconciliations (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  account TEXT NOT NULL CHECK (length(trim(account)) > 0),
  statement_date TEXT NOT NULL CHECK (length(statement_date) = 10),
  statement_balance_minor INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK (length(currency) = 3),
  reconciled_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bookkeeping_reconciliations_account_idx
  ON bookkeeping_reconciliations(project_id, account, currency, statement_date DESC);
