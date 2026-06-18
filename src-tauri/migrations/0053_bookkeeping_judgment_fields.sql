-- Bookkeeping judgment-pipeline foundation: income/expense direction, account, subcategory,
-- taxonomy codes + preserved raw label, time-of-day, per-field confidence, review reasons,
-- and duplicate linkage. Additive ALTERs only (no table rebuild): review_status enum is left
-- unchanged; a duplicate is review_status='ignored' AND duplicate_of_transaction_id IS NOT NULL.

ALTER TABLE bookkeeping_transactions
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'expense'
    CHECK (direction IN ('expense','income'));

ALTER TABLE bookkeeping_transactions
  ADD COLUMN account TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN subcategory TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN category_code TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN subcategory_code TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN raw_category TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN spent_at_time TEXT
    CHECK (spent_at_time IS NULL OR length(spent_at_time) = 8);

ALTER TABLE bookkeeping_transactions
  ADD COLUMN confidence REAL
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

ALTER TABLE bookkeeping_transactions
  ADD COLUMN field_confidence_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE bookkeeping_transactions
  ADD COLUMN review_reasons_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE bookkeeping_transactions
  ADD COLUMN duplicate_of_transaction_id TEXT
    REFERENCES bookkeeping_transactions(id) ON DELETE SET NULL;

-- Strongest dedup signals when a receipt carries them: order number / payment (approval) number.
ALTER TABLE bookkeeping_transactions
  ADD COLUMN order_no TEXT;

ALTER TABLE bookkeeping_transactions
  ADD COLUMN payment_no TEXT;

CREATE INDEX bookkeeping_transactions_direction_idx
  ON bookkeeping_transactions(direction, spent_at DESC);

CREATE INDEX bookkeeping_transactions_duplicate_of_idx
  ON bookkeeping_transactions(duplicate_of_transaction_id)
  WHERE duplicate_of_transaction_id IS NOT NULL;

CREATE INDEX bookkeeping_transactions_order_no_idx
  ON bookkeeping_transactions(order_no)
  WHERE order_no IS NOT NULL;

CREATE INDEX bookkeeping_transactions_payment_no_idx
  ON bookkeeping_transactions(payment_no)
  WHERE payment_no IS NOT NULL;
