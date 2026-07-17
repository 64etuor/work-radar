-- Diet domain foundation (docs/plans/2026-07-17-diet-domain.md).
-- Scope: local SQLite SSOT for foods/goals/recipes/meal plans/intake logs/pantry lots/grocery orders.
-- Principles carried from the PRD: nutrition snapshots are immutable at plan/log time,
-- pantry mutations are append-only events (FEFO consumption), goals are append-only versions.
-- No checkout/payment path — grocery_orders is a record-keeping ledger only.

-- 표준 식품. 100g당 영양을 인라인 컬럼으로 보존(개인용 — EAV nutrient 테이블은 YAGNI).
-- source/source_ref로 출처(manual / kfind / rda …)를 남긴다.
CREATE TABLE foods (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  food_type            TEXT NOT NULL DEFAULT 'ingredient'
                       CHECK (food_type IN ('ingredient','product','dish')),
  preparation          TEXT,
  default_serving_g    REAL,
  kcal_per_100g        REAL NOT NULL CHECK (kcal_per_100g >= 0),
  protein_g_per_100g   REAL NOT NULL DEFAULT 0 CHECK (protein_g_per_100g >= 0),
  fat_g_per_100g       REAL NOT NULL DEFAULT 0 CHECK (fat_g_per_100g >= 0),
  carb_g_per_100g      REAL NOT NULL DEFAULT 0 CHECK (carb_g_per_100g >= 0),
  fiber_g_per_100g     REAL,
  sodium_mg_per_100g   REAL,
  source               TEXT NOT NULL DEFAULT 'manual',
  source_ref           TEXT,
  archived             INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_foods_name ON foods(name);

-- 검색 별칭('닭 정육', '순살 닭다리' …). normalized = lower + 공백 정리(커맨드가 계산).
CREATE TABLE food_aliases (
  id         TEXT PRIMARY KEY,
  food_id    TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  alias      TEXT NOT NULL,
  normalized TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(normalized)
) STRICT;

CREATE INDEX idx_food_aliases_food ON food_aliases(food_id);

-- 영양 목표 — append-only 버전. 활성 목표 = effective_date <= 오늘 중 최신.
-- 과거 계획/기록은 생성 시점 스냅샷을 들고 있으므로 목표 변경이 이력을 바꾸지 않는다.
CREATE TABLE diet_goals (
  id                    TEXT PRIMARY KEY,
  effective_date        TEXT NOT NULL,
  calorie_target        REAL NOT NULL CHECK (calorie_target > 0),
  calorie_tolerance_pct REAL NOT NULL DEFAULT 10 CHECK (calorie_tolerance_pct >= 0),
  protein_min_g         REAL CHECK (protein_min_g >= 0),
  fat_min_g             REAL CHECK (fat_min_g >= 0),
  carb_target_g         REAL CHECK (carb_target_g >= 0),
  fiber_min_g           REAL CHECK (fiber_min_g >= 0),
  note                  TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_diet_goals_effective ON diet_goals(effective_date DESC, created_at DESC);

-- 레시피. 영양은 저장하지 않고 재료에서 쿼리타임 계산(커널) — 계획/기록에 넣는 순간만 스냅샷.
CREATE TABLE recipes (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  servings     REAL NOT NULL DEFAULT 1 CHECK (servings > 0),
  cook_minutes INTEGER,
  meal_tags    TEXT NOT NULL DEFAULT '[]',
  instructions TEXT,
  archived     INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_recipes_name ON recipes(name);

CREATE TABLE recipe_ingredients (
  id        TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  food_id   TEXT NOT NULL REFERENCES foods(id),
  qty_g     REAL NOT NULL CHECK (qty_g > 0),
  optional  INTEGER NOT NULL DEFAULT 0 CHECK (optional IN (0,1)),
  note      TEXT,
  sort_rank INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id, sort_rank);

-- 식단 계획. 생성 시점 활성 목표를 스냅샷(calorie_target/protein_min_g) — 이후 목표 변경 무영향.
CREATE TABLE meal_plans (
  id             TEXT PRIMARY KEY,
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  calorie_target REAL,
  protein_min_g  REAL,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date)
) STRICT;

CREATE INDEX idx_meal_plans_window ON meal_plans(start_date, end_date);

CREATE TABLE planned_meals (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  meal_type      TEXT NOT NULL CHECK (meal_type IN
                 ('breakfast','lunch','dinner','snack','pre_workout','post_workout','free')),
  scheduled_time TEXT,
  status         TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','eaten','partial','skipped')),
  eaten_at       TEXT,
  note           TEXT,
  sort_rank      INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX idx_planned_meals_plan_date ON planned_meals(plan_id, date, sort_rank);

-- 계획 항목. recipe_id XOR food_id. kcal/protein 등은 **추가 시점 스냅샷**(커널 계산값) —
-- 이후 food/recipe 수정이 과거 계획의 영양 수치를 바꾸지 않는다.
CREATE TABLE planned_meal_items (
  id              TEXT PRIMARY KEY,
  planned_meal_id TEXT NOT NULL REFERENCES planned_meals(id) ON DELETE CASCADE,
  recipe_id       TEXT REFERENCES recipes(id),
  food_id         TEXT REFERENCES foods(id),
  servings        REAL CHECK (servings > 0),
  qty_g           REAL CHECK (qty_g > 0),
  kcal            REAL NOT NULL CHECK (kcal >= 0),
  protein_g       REAL NOT NULL DEFAULT 0 CHECK (protein_g >= 0),
  fat_g           REAL NOT NULL DEFAULT 0 CHECK (fat_g >= 0),
  carb_g          REAL NOT NULL DEFAULT 0 CHECK (carb_g >= 0),
  note            TEXT,
  CHECK ((recipe_id IS NULL) <> (food_id IS NULL)),
  CHECK ((recipe_id IS NULL AND qty_g IS NOT NULL) OR (food_id IS NULL AND servings IS NOT NULL))
) STRICT;

CREATE INDEX idx_planned_meal_items_meal ON planned_meal_items(planned_meal_id);

-- 실제 섭취 단일 원장. 계획 연결은 optional(자유 외식/간식 기록 가능). 영양은 기록 시점 스냅샷.
-- 일일 실적 = date 기준 합산. satisfaction/fullness = 1..5 피드백(선호 학습 신호).
CREATE TABLE meal_logs (
  id              TEXT PRIMARY KEY,
  date            TEXT NOT NULL,
  at              TEXT NOT NULL,
  planned_meal_id TEXT REFERENCES planned_meals(id) ON DELETE SET NULL,
  recipe_id       TEXT REFERENCES recipes(id),
  food_id         TEXT REFERENCES foods(id),
  description     TEXT,
  servings        REAL CHECK (servings > 0),
  qty_g           REAL CHECK (qty_g > 0),
  kcal            REAL NOT NULL CHECK (kcal >= 0),
  protein_g       REAL NOT NULL DEFAULT 0 CHECK (protein_g >= 0),
  fat_g           REAL NOT NULL DEFAULT 0 CHECK (fat_g >= 0),
  carb_g          REAL NOT NULL DEFAULT 0 CHECK (carb_g >= 0),
  satisfaction    INTEGER CHECK (satisfaction BETWEEN 1 AND 5),
  fullness        INTEGER CHECK (fullness BETWEEN 1 AND 5),
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_meal_logs_date ON meal_logs(date, at);

-- 재고는 로트 단위(같은 우유라도 입고일 다르면 별도 행). 차감은 FEFO(커널) + append-only 이벤트.
CREATE TABLE pantry_lots (
  id              TEXT PRIMARY KEY,
  food_id         TEXT NOT NULL REFERENCES foods(id),
  location        TEXT NOT NULL DEFAULT 'pantry'
                  CHECK (location IN ('fridge','freezer','pantry','other')),
  acquired_on     TEXT NOT NULL,
  expires_on      TEXT,
  opened_on       TEXT,
  initial_qty_g   REAL NOT NULL CHECK (initial_qty_g > 0),
  remaining_qty_g REAL NOT NULL CHECK (remaining_qty_g >= 0),
  order_line_id   TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_pantry_lots_food ON pantry_lots(food_id, expires_on);

CREATE TABLE pantry_events (
  id          TEXT PRIMARY KEY,
  lot_id      TEXT NOT NULL REFERENCES pantry_lots(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('purchased','consumed','adjusted','wasted','expired')),
  delta_g     REAL NOT NULL,
  reason      TEXT,
  meal_log_id TEXT REFERENCES meal_logs(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_pantry_events_lot ON pantry_events(lot_id, created_at);

-- 주문 내역 원장(기록 전용 — 체크아웃/결제 경로 없음). merchant는 자유 텍스트(coupang/kurly/offline …).
-- 금액은 KRW 정수.
CREATE TABLE grocery_orders (
  id                TEXT PRIMARY KEY,
  merchant          TEXT NOT NULL,
  ordered_at        TEXT NOT NULL,
  external_order_no TEXT,
  total_krw         INTEGER CHECK (total_krw >= 0),
  shipping_krw      INTEGER CHECK (shipping_krw >= 0),
  status            TEXT NOT NULL DEFAULT 'ordered'
                    CHECK (status IN ('ordered','delivered','cancelled')),
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_grocery_orders_ordered_at ON grocery_orders(ordered_at DESC);

-- 주문 라인. food_id 링크는 optional(장보기 계산에 쓰임 — 미입고 pending 차감).
-- receive_order_line 커맨드가 pantry lot 생성 + received=1 + purchased 이벤트를 만든다.
CREATE TABLE grocery_order_lines (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES grocery_orders(id) ON DELETE CASCADE,
  product_name   TEXT NOT NULL,
  food_id        TEXT REFERENCES foods(id),
  quantity       REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  total_g        REAL CHECK (total_g > 0),
  unit_price_krw INTEGER CHECK (unit_price_krw >= 0),
  line_total_krw INTEGER CHECK (line_total_krw >= 0),
  received       INTEGER NOT NULL DEFAULT 0 CHECK (received IN (0,1)),
  note           TEXT
) STRICT;

CREATE INDEX idx_grocery_order_lines_order ON grocery_order_lines(order_id);
CREATE INDEX idx_grocery_order_lines_food ON grocery_order_lines(food_id) WHERE food_id IS NOT NULL;
