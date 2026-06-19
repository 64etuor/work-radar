ALTER TABLE bookkeeping_transactions ADD COLUMN deleted_at TEXT NULL;

CREATE INDEX bookkeeping_transactions_deleted_at_idx
  ON bookkeeping_transactions(deleted_at);
