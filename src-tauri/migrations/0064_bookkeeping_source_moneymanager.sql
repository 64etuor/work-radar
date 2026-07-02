-- Work Radar — 가계부 source 값에 'moneymanager' 추가 (bookkeeping CHECK 확장).
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 대상: 인라인 `CHECK (source IN (...))`을 가진 3개 테이블에 'moneymanager' 허용값 추가.
--   1) bookkeeping_transactions  (0051: manual/ocr/gmail/csv → + moneymanager)
--   2) bookkeeping_sync_jobs     (0051: ocr/gmail/csv → + moneymanager)
--   3) bookkeeping_sync_cursors  (0056: ocr/gmail/csv → + moneymanager)
--
-- ⚠️ FK-안전 재작성(데이터 무손실 — 0011 레시피와 동일한 이유): SQLite는 CHECK 제약을 ALTER 못 해
--   테이블을 rebuild해야 한다. 그런데 sqlx 0.8은 마이그레이션을 **트랜잭션 안에서** 실행하고,
--   `PRAGMA foreign_keys=OFF`는 트랜잭션 안에선 **no-op**이다(연결 기본값 foreign_keys=ON 유지).
--   FK가 켜진 채 `DROP TABLE bookkeeping_transactions`는 암시적 DELETE를 일으켜 인바운드
--   ON DELETE CASCADE 자식들(line_items 이력, category_overrides 이력)을 **통째로 지운다**.
--   → 그래서 bookkeeping_transactions를 참조하는 자식 3개도 함께 rebuild하고, 인바운드 FK 참조가
--   사라지는 순서로 drop한다(어떤 시점에도 CASCADE 삭제가 발화하지 않음). PRAGMA OFF는 의도 표기용(무해).
--
-- 인바운드 FK 목록 (grep 'REFERENCES bookkeeping_transactions'):
--   - bookkeeping_transaction_line_items.transaction_id      (0055, ON DELETE CASCADE)  → rebuild
--   - bookkeeping_category_overrides.transaction_id          (0054, ON DELETE CASCADE)  → rebuild
--   - bookkeeping_recurring_occurrences.transaction_id       (0052, ON DELETE SET NULL) → rebuild
--   - bookkeeping_transactions.duplicate_of_transaction_id   (0053, self-FK SET NULL)   → new 테이블이 스스로 참조
--
-- 순환 FK 주의: transactions.recurring_occurrence_id ↔ recurring_occurrences.transaction_id
--   (둘 다 SET NULL). SQLite FK는 즉시(immediate) 검사라 두 _new 테이블을 서로 채울 수 없다.
--   → occurrences_new를 transaction_id=NULL로 먼저 복사 → transactions_new 복사
--   (duplicate_of도 NULL로 — self-FK 행 순서 문제 회피) → 두 컬럼을 UPDATE로 복원.
--   drop 단계에서 옛 transactions↔옛 occurrences 사이의 SET NULL은 곧 drop될 옛 사본에만
--   닿으므로 무해하다(복사는 이미 끝났고, _new 테이블은 옛 이름을 참조하지 않는다).
--
-- bookkeeping_sync_jobs / bookkeeping_sync_cursors는 인바운드 FK가 없어 단순 rebuild.

PRAGMA foreign_keys = OFF;

------------------------------------------------------------------------------
-- 1) bookkeeping_transactions rebuild — 0051 + 0052 + 0053 + 0057 누적 DDL 전부 보존,
--    source CHECK에 'moneymanager' 추가.
------------------------------------------------------------------------------

CREATE TABLE bookkeeping_transactions_new (
  -- 0051 기본 컬럼
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('manual','ocr','gmail','csv','moneymanager')),
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
  reviewed_at TEXT,
  -- 0052 추가 컬럼
  payment_method_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (payment_method_kind IN ('unknown','cash','card','bank_transfer','simple_pay')),
  payment_method_label TEXT,
  payment_method_last4 TEXT,
  expense_kind TEXT NOT NULL DEFAULT 'variable'
    CHECK (expense_kind IN ('variable','fixed','subscription','installment')),
  recurring_expense_id TEXT REFERENCES bookkeeping_recurring_expenses(id) ON DELETE SET NULL,
  recurring_occurrence_id TEXT REFERENCES bookkeeping_recurring_occurrences_new(id) ON DELETE SET NULL,
  -- 0053 추가 컬럼
  direction TEXT NOT NULL DEFAULT 'expense'
    CHECK (direction IN ('expense','income')),
  account TEXT,
  subcategory TEXT,
  category_code TEXT,
  subcategory_code TEXT,
  raw_category TEXT,
  spent_at_time TEXT
    CHECK (spent_at_time IS NULL OR length(spent_at_time) = 8),
  confidence REAL
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  field_confidence_json TEXT NOT NULL DEFAULT '{}',
  review_reasons_json TEXT NOT NULL DEFAULT '[]',
  duplicate_of_transaction_id TEXT
    REFERENCES bookkeeping_transactions_new(id) ON DELETE SET NULL,
  order_no TEXT,
  payment_no TEXT,
  -- 0057 추가 컬럼
  deleted_at TEXT NULL
);

-- 순환 FK 상대편: bookkeeping_recurring_occurrences rebuild (0052 DDL 그대로, CHECK 변경 없음 —
-- transactions_new를 가리키게 하기 위한 rebuild).
CREATE TABLE bookkeeping_recurring_occurrences_new (
  id TEXT PRIMARY KEY,
  recurring_expense_id TEXT NOT NULL REFERENCES bookkeeping_recurring_expenses(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (length(month) = 7),
  due_date TEXT NOT NULL CHECK (length(due_date) = 10),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0 AND amount_minor <= 2147483647),
  currency TEXT NOT NULL DEFAULT 'KRW' CHECK (length(currency) = 3),
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','posted','skipped')),
  transaction_id TEXT REFERENCES bookkeeping_transactions_new(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(recurring_expense_id, month)
);

-- 복사 (즉시 FK 때문에 순환/자기참조 컬럼은 NULL로 넣고 뒤에 UPDATE로 복원).
INSERT INTO bookkeeping_recurring_occurrences_new
  (id, recurring_expense_id, month, due_date, amount_minor, currency, status,
   transaction_id, note, created_at, updated_at)
  SELECT id, recurring_expense_id, month, due_date, amount_minor, currency, status,
         NULL, note, created_at, updated_at
  FROM bookkeeping_recurring_occurrences;

INSERT INTO bookkeeping_transactions_new
  (id, project_id, source, source_ref, merchant, description, amount_minor, currency,
   spent_at, category, review_status, note, created_at, updated_at, reviewed_at,
   payment_method_kind, payment_method_label, payment_method_last4, expense_kind,
   recurring_expense_id, recurring_occurrence_id,
   direction, account, subcategory, category_code, subcategory_code, raw_category,
   spent_at_time, confidence, field_confidence_json, review_reasons_json,
   duplicate_of_transaction_id, order_no, payment_no, deleted_at)
  SELECT id, project_id, source, source_ref, merchant, description, amount_minor, currency,
         spent_at, category, review_status, note, created_at, updated_at, reviewed_at,
         payment_method_kind, payment_method_label, payment_method_last4, expense_kind,
         recurring_expense_id, recurring_occurrence_id,
         direction, account, subcategory, category_code, subcategory_code, raw_category,
         spent_at_time, confidence, field_confidence_json, review_reasons_json,
         NULL, order_no, payment_no, deleted_at
  FROM bookkeeping_transactions;

UPDATE bookkeeping_recurring_occurrences_new
  SET transaction_id =
    (SELECT o.transaction_id FROM bookkeeping_recurring_occurrences o
      WHERE o.id = bookkeeping_recurring_occurrences_new.id);

UPDATE bookkeeping_transactions_new
  SET duplicate_of_transaction_id =
    (SELECT t.duplicate_of_transaction_id FROM bookkeeping_transactions t
      WHERE t.id = bookkeeping_transactions_new.id);

-- CASCADE 자식들 rebuild (0055 / 0054 DDL 그대로, transactions_new를 참조).
CREATE TABLE bookkeeping_transaction_line_items_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES bookkeeping_transactions_new(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0 AND amount_minor <= 2147483647),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 100000),
  category_code TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO bookkeeping_transaction_line_items_new
  (id, transaction_id, name, amount_minor, quantity, category_code, sort_order, created_at)
  SELECT id, transaction_id, name, amount_minor, quantity, category_code, sort_order, created_at
  FROM bookkeeping_transaction_line_items;

CREATE TABLE bookkeeping_category_overrides_new (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES bookkeeping_transactions_new(id) ON DELETE CASCADE,
  from_code TEXT,
  to_code TEXT,
  from_subcategory_code TEXT,
  to_subcategory_code TEXT,
  actor TEXT NOT NULL DEFAULT 'user',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO bookkeeping_category_overrides_new
  (id, transaction_id, from_code, to_code, from_subcategory_code, to_subcategory_code,
   actor, reason, created_at)
  SELECT id, transaction_id, from_code, to_code, from_subcategory_code, to_subcategory_code,
         actor, reason, created_at
  FROM bookkeeping_category_overrides;

-- 옛 테이블 drop — 인바운드 CASCADE FK가 없는 것부터. line_items/overrides는 인바운드 없음.
-- 옛 transactions↔옛 occurrences의 상호 SET NULL은 곧 drop될 옛 사본에만 닿아 무해(복사 완료 후).
DROP TABLE bookkeeping_transaction_line_items;
DROP TABLE bookkeeping_category_overrides;
DROP TABLE bookkeeping_recurring_occurrences;
DROP TABLE bookkeeping_transactions;

-- rename — modern SQLite가 _new를 참조하던 FK들을 새 이름으로 갱신한다(0011과 동일).
ALTER TABLE bookkeeping_transactions_new RENAME TO bookkeeping_transactions;
ALTER TABLE bookkeeping_recurring_occurrences_new RENAME TO bookkeeping_recurring_occurrences;
ALTER TABLE bookkeeping_transaction_line_items_new RENAME TO bookkeeping_transaction_line_items;
ALTER TABLE bookkeeping_category_overrides_new RENAME TO bookkeeping_category_overrides;

-- 인덱스 재생성 (0051 + 0052 + 0053 + 0057 / 0055 / 0054 전부).
CREATE UNIQUE INDEX bookkeeping_transactions_source_ref_unique
  ON bookkeeping_transactions(source, source_ref)
  WHERE source_ref IS NOT NULL;
CREATE INDEX bookkeeping_transactions_spent_at_idx
  ON bookkeeping_transactions(spent_at);
CREATE INDEX bookkeeping_transactions_review_status_idx
  ON bookkeeping_transactions(review_status, spent_at DESC);
CREATE INDEX bookkeeping_transactions_category_month_idx
  ON bookkeeping_transactions(category, spent_at);
CREATE INDEX bookkeeping_transactions_expense_kind_idx
  ON bookkeeping_transactions(expense_kind, spent_at DESC);
CREATE INDEX bookkeeping_transactions_recurring_expense_idx
  ON bookkeeping_transactions(recurring_expense_id, spent_at DESC)
  WHERE recurring_expense_id IS NOT NULL;
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
CREATE INDEX bookkeeping_transactions_deleted_at_idx
  ON bookkeeping_transactions(deleted_at);

CREATE INDEX bookkeeping_recurring_occurrences_month_idx
  ON bookkeeping_recurring_occurrences(month, due_date);
CREATE INDEX bookkeeping_recurring_occurrences_status_idx
  ON bookkeeping_recurring_occurrences(status, due_date);

CREATE INDEX bookkeeping_line_items_tx_idx
  ON bookkeeping_transaction_line_items(transaction_id, sort_order);

CREATE INDEX bookkeeping_category_overrides_tx_idx
  ON bookkeeping_category_overrides(transaction_id, created_at DESC);

------------------------------------------------------------------------------
-- 2) bookkeeping_sync_jobs rebuild — 0051 + 0056 누적 DDL 보존, 인바운드 FK 없음 → 단순 rebuild.
------------------------------------------------------------------------------

CREATE TABLE bookkeeping_sync_jobs_new (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ocr','gmail','csv','moneymanager')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  started_at TEXT,
  finished_at TEXT,
  sanitized_error_code TEXT,
  sanitized_error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  scanned_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  review_needed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  cursor_before TEXT,
  cursor_after TEXT
);
INSERT INTO bookkeeping_sync_jobs_new
  (id, source, status, started_at, finished_at, sanitized_error_code, sanitized_error_message,
   created_at, updated_at, scanned_count, imported_count, duplicate_count, review_needed_count,
   failed_count, cursor_before, cursor_after)
  SELECT id, source, status, started_at, finished_at, sanitized_error_code, sanitized_error_message,
         created_at, updated_at, scanned_count, imported_count, duplicate_count, review_needed_count,
         failed_count, cursor_before, cursor_after
  FROM bookkeeping_sync_jobs;
DROP TABLE bookkeeping_sync_jobs;
ALTER TABLE bookkeeping_sync_jobs_new RENAME TO bookkeeping_sync_jobs;

CREATE INDEX bookkeeping_sync_jobs_status_idx
  ON bookkeeping_sync_jobs(status, updated_at DESC);

------------------------------------------------------------------------------
-- 3) bookkeeping_sync_cursors rebuild — 0056 DDL 보존, 인바운드 FK/인덱스 없음(복합 PK만).
------------------------------------------------------------------------------

CREATE TABLE bookkeeping_sync_cursors_new (
  source TEXT NOT NULL CHECK (source IN ('ocr', 'gmail', 'csv', 'moneymanager')),
  scope_key TEXT NOT NULL,
  cursor_kind TEXT NOT NULL CHECK (cursor_kind IN ('gmail_history', 'internal_date')),
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, scope_key)
);
INSERT INTO bookkeeping_sync_cursors_new
  (source, scope_key, cursor_kind, cursor_value, updated_at)
  SELECT source, scope_key, cursor_kind, cursor_value, updated_at
  FROM bookkeeping_sync_cursors;
DROP TABLE bookkeeping_sync_cursors;
ALTER TABLE bookkeeping_sync_cursors_new RENAME TO bookkeeping_sync_cursors;

PRAGMA foreign_keys = ON;
