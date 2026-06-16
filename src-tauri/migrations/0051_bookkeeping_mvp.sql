CREATE TABLE bookkeeping_transactions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','ocr','gmail','csv')),
  source_ref TEXT,
  merchant TEXT NOT NULL CHECK (length(trim(merchant)) > 0),
  description TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 2147483647),
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK (length(currency) = 3),
  spent_at TEXT NOT NULL CHECK (length(spent_at) = 10),
  category TEXT NOT NULL CHECK (length(trim(category)) > 0),
  review_status TEXT NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('needs_review','approved','ignored')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE UNIQUE INDEX bookkeeping_transactions_source_ref_unique
  ON bookkeeping_transactions(source, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX bookkeeping_transactions_spent_at_idx
  ON bookkeeping_transactions(spent_at);

CREATE INDEX bookkeeping_transactions_review_status_idx
  ON bookkeeping_transactions(review_status, spent_at DESC);

CREATE INDEX bookkeeping_transactions_category_month_idx
  ON bookkeeping_transactions(category, spent_at);

CREATE TABLE bookkeeping_audit_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction','sync_job')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bookkeeping_audit_entity_idx
  ON bookkeeping_audit_log(entity_type, entity_id, created_at DESC);

CREATE TABLE bookkeeping_sync_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ocr','gmail','csv')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  started_at TEXT,
  finished_at TEXT,
  sanitized_error_code TEXT,
  sanitized_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bookkeeping_sync_jobs_status_idx
  ON bookkeeping_sync_jobs(status, updated_at DESC);
