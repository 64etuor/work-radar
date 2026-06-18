CREATE TABLE bookkeeping_recurring_expenses (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  merchant TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 2147483647),
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK (length(currency) = 3),
  category TEXT NOT NULL CHECK (length(trim(category)) > 0),
  payment_method_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (payment_method_kind IN ('unknown','cash','card','bank_transfer','simple_pay')),
  payment_method_label TEXT,
  payment_method_last4 TEXT,
  expense_kind TEXT NOT NULL DEFAULT 'fixed'
    CHECK (expense_kind IN ('variable','fixed','subscription','installment')),
  schedule_day INTEGER NOT NULL CHECK (schedule_day >= 1 AND schedule_day <= 31),
  start_month TEXT NOT NULL CHECK (length(start_month) = 7),
  end_month TEXT CHECK (end_month IS NULL OR length(end_month) = 7),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','archived')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bookkeeping_recurring_expenses_status_idx
  ON bookkeeping_recurring_expenses(status, start_month);

CREATE TABLE bookkeeping_recurring_occurrences (
  id TEXT PRIMARY KEY,
  recurring_expense_id TEXT NOT NULL REFERENCES bookkeeping_recurring_expenses(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (length(month) = 7),
  due_date TEXT NOT NULL CHECK (length(due_date) = 10),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 2147483647),
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','posted','skipped')),
  transaction_id TEXT REFERENCES bookkeeping_transactions(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(recurring_expense_id, month)
);

CREATE INDEX bookkeeping_recurring_occurrences_month_idx
  ON bookkeeping_recurring_occurrences(month, due_date);

CREATE INDEX bookkeeping_recurring_occurrences_status_idx
  ON bookkeeping_recurring_occurrences(status, due_date);

ALTER TABLE bookkeeping_transactions
  ADD COLUMN payment_method_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (payment_method_kind IN ('unknown','cash','card','bank_transfer','simple_pay'));

ALTER TABLE bookkeeping_transactions
  ADD COLUMN payment_method_label TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN payment_method_last4 TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN expense_kind TEXT NOT NULL DEFAULT 'variable'
    CHECK (expense_kind IN ('variable','fixed','subscription','installment'));

ALTER TABLE bookkeeping_transactions
  ADD COLUMN recurring_expense_id TEXT REFERENCES bookkeeping_recurring_expenses(id) ON DELETE SET NULL;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN recurring_occurrence_id TEXT REFERENCES bookkeeping_recurring_occurrences(id) ON DELETE SET NULL;

CREATE INDEX bookkeeping_transactions_expense_kind_idx
  ON bookkeeping_transactions(expense_kind, spent_at DESC);

CREATE INDEX bookkeeping_transactions_recurring_expense_idx
  ON bookkeeping_transactions(recurring_expense_id, spent_at DESC)
  WHERE recurring_expense_id IS NOT NULL;
