-- Per-transaction line items. A transaction keeps a single `amount_minor` total; line items are an
-- optional itemized breakdown. A sum mismatch is surfaced as a review reason (not a hard reject) —
-- the CFO judgment may legitimately differ (rounding, discounts, partial OCR).

CREATE TABLE bookkeeping_transaction_line_items (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES bookkeeping_transactions(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0 AND amount_minor <= 2147483647),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 100000),
  category_code TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bookkeeping_line_items_tx_idx
  ON bookkeeping_transaction_line_items(transaction_id, sort_order);
