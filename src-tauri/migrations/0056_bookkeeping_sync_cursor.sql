-- Per-source sync cursor + per-job ingest counts for "current-point-forward" polling. The cursor is
-- the durable SSOT (last seen point); sync_jobs counts are the per-run record. Hourly polling reads
-- the cursor, fetches only newer items (bounded), and advances the cursor on success — a failure
-- leaves the cursor unchanged so the next tick retries.

CREATE TABLE bookkeeping_sync_cursors (
  source TEXT NOT NULL CHECK (source IN ('ocr', 'gmail', 'csv')),
  scope_key TEXT NOT NULL,
  cursor_kind TEXT NOT NULL CHECK (cursor_kind IN ('gmail_history', 'internal_date')),
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, scope_key)
);

ALTER TABLE bookkeeping_sync_jobs ADD COLUMN scanned_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookkeeping_sync_jobs ADD COLUMN imported_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookkeeping_sync_jobs ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookkeeping_sync_jobs ADD COLUMN review_needed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookkeeping_sync_jobs ADD COLUMN failed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookkeeping_sync_jobs ADD COLUMN cursor_before TEXT;
ALTER TABLE bookkeeping_sync_jobs ADD COLUMN cursor_after TEXT;
