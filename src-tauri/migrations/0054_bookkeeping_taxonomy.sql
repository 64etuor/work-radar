-- Bookkeeping category taxonomy (seeded reference) + merchant/label aliases + category override
-- history. category_code on transactions is a SOFT reference (validated in Rust, no hard FK) so an
-- in-flight Hermes write with a stale/unknown code never fails at the DB layer.

CREATE TABLE bookkeeping_category_taxonomy (
  code TEXT PRIMARY KEY,
  parent_code TEXT REFERENCES bookkeeping_category_taxonomy(code) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX bookkeeping_category_taxonomy_parent_idx
  ON bookkeeping_category_taxonomy(parent_code, sort_order);

CREATE TABLE bookkeeping_category_alias (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL CHECK (length(trim(pattern)) > 0),
  match_kind TEXT NOT NULL CHECK (match_kind IN ('merchant', 'raw_label', 'domain')),
  category_code TEXT NOT NULL,
  subcategory_code TEXT,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'user', 'agent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (match_kind, pattern)
);

CREATE TABLE bookkeeping_category_overrides (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES bookkeeping_transactions(id) ON DELETE CASCADE,
  from_code TEXT,
  to_code TEXT,
  from_subcategory_code TEXT,
  to_subcategory_code TEXT,
  actor TEXT NOT NULL DEFAULT 'user',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX bookkeeping_category_overrides_tx_idx
  ON bookkeeping_category_overrides(transaction_id, created_at DESC);

-- Seed: top-level categories (parent_code NULL) + subcategories. Codes are stable ascii slugs that
-- already match the legacy free-text `category` values (food/transport/shopping/housing/health/work);
-- labels are Korean. The unmapped sentinel is the single code 'uncategorized' shown as '미분류'.
INSERT INTO bookkeeping_category_taxonomy (code, parent_code, label, sort_order) VALUES
  ('food', NULL, '식비', 10),
  ('food_dining', 'food', '외식', 11),
  ('food_cafe', 'food', '카페', 12),
  ('food_delivery', 'food', '배달', 13),
  ('food_grocery', 'food', '식료품', 14),
  ('transport', NULL, '교통', 20),
  ('transport_public', 'transport', '대중교통', 21),
  ('transport_taxi', 'transport', '택시', 22),
  ('transport_fuel', 'transport', '주유·충전', 23),
  ('shopping', NULL, '쇼핑', 30),
  ('shopping_daily', 'shopping', '생활용품', 31),
  ('shopping_clothing', 'shopping', '의류', 32),
  ('shopping_electronics', 'shopping', '전자기기', 33),
  ('subscription', NULL, '구독·SW', 40),
  ('health', NULL, '의료·건강', 50),
  ('housing', NULL, '주거·관리비', 60),
  ('work', NULL, '업무비', 70),
  ('income', NULL, '수입', 80),
  ('income_salary', 'income', '급여', 81),
  ('income_allowance', 'income', '용돈', 82),
  ('income_other', 'income', '기타', 83),
  ('uncategorized', NULL, '미분류', 999);

-- Seed aliases mapping common raw labels (the user's export uses emoji+Korean subcategory labels) to
-- codes. raw_label aliases are matched after emoji/whitespace normalization in Rust.
INSERT INTO bookkeeping_category_alias (id, pattern, match_kind, category_code, subcategory_code, confidence, source) VALUES
  (lower(hex(randomblob(16))), '생활용품', 'raw_label', 'shopping', 'shopping_daily', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '의류', 'raw_label', 'shopping', 'shopping_clothing', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '전자기기', 'raw_label', 'shopping', 'shopping_electronics', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '외식', 'raw_label', 'food', 'food_dining', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '카페', 'raw_label', 'food', 'food_cafe', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '배달', 'raw_label', 'food', 'food_delivery', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '식료품', 'raw_label', 'food', 'food_grocery', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '건강', 'raw_label', 'health', NULL, 0.85, 'seed'),
  (lower(hex(randomblob(16))), '대중교통', 'raw_label', 'transport', 'transport_public', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '택시', 'raw_label', 'transport', 'transport_taxi', 0.9, 'seed'),
  (lower(hex(randomblob(16))), '용돈', 'raw_label', 'income', 'income_allowance', 0.9, 'seed');
