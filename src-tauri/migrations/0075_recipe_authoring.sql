-- Recipe authoring 확장 (docs/plans/2026-07-26-recipe-authoring-workout.md).
-- 0073이 recipes/recipe_ingredients를 만들었으나 "에이전트가 내 입맛에 맞게 계속 수정"이
-- 구조적으로 불가능했다: instructions 단일 블롭(부분 수정 불가) · qty_g only(양념 단위 표현 불가)
-- · 개정 이력 없음(되돌리기 불가) · 맛 피드백이 레시피로 되먹임되지 않음.
--
-- 보존 원칙(0073에서 계승): 스냅샷 불변(과거 계획/기록의 영양은 재작성 불가) · append-only
-- (리비전도 되돌리기조차 새 rev를 append) · 계산은 결정론 커널.

-- 조리 단계. 표시용 단계번호는 쿼리타임 파생(ROW_NUMBER over sort_rank) —
-- UNIQUE(recipe_id, step_no)를 두면 중간 삽입/재정렬의 재번호 UPDATE가 자기 자신과 충돌한다
-- (SQLite에 deferred constraint 없음). sort_rank REAL이라 중간 삽입은 rank 평균으로 해결.
CREATE TABLE recipe_steps (
  id               TEXT PRIMARY KEY,
  recipe_id        TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  sort_rank        REAL NOT NULL,
  body             TEXT NOT NULL,
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_recipe_steps_recipe ON recipe_steps(recipe_id, sort_rank);

-- 단위 환산. food_id NULL = 전역 기본, 지정 = 그 식품 전용(밀도/개체 차이).
-- 커널 lookup: food-specific → 전역 → 실패(에러). 조용한 0 금지.
CREATE TABLE unit_conversions (
  id             TEXT PRIMARY KEY,
  unit           TEXT NOT NULL,
  food_id        TEXT REFERENCES foods(id) ON DELETE CASCADE,
  grams_per_unit REAL NOT NULL CHECK (grams_per_unit > 0),
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

-- UNIQUE(unit, food_id) 테이블 제약을 쓰면 안 된다 — SQLite는 UNIQUE에서 NULL을 서로 구별하므로
-- 전역 행(food_id IS NULL)이 무제한 중복되고, 아래 INSERT OR IGNORE seed가 재실행 시 중복을
-- 쌓아 커널 lookup이 비결정적으로 갈린다. 부분 유니크 인덱스 둘로 갈라야 실제로 막힌다.
CREATE UNIQUE INDEX uq_unit_conversions_global ON unit_conversions(unit) WHERE food_id IS NULL;
CREATE UNIQUE INDEX uq_unit_conversions_food ON unit_conversions(unit, food_id)
  WHERE food_id IS NOT NULL;

-- 전역 기본값 seed — 없으면 첫 레시피부터 환산이 막힌다.
-- ea/slice/clove는 식품별로 크게 다르므로 전역값은 **폴백일 뿐**이고 food 전용 행이 이긴다.
INSERT OR IGNORE INTO unit_conversions (id, unit, food_id, grams_per_unit, note) VALUES
  ('unitconv-global-g',     'g',     NULL, 1.0,   '기준 단위'),
  ('unitconv-global-ml',    'ml',    NULL, 1.0,   '물 기준 — 기름/시럽은 food 전용 행으로 덮어라'),
  ('unitconv-global-tsp',   'tsp',   NULL, 5.0,   '작은술'),
  ('unitconv-global-tbsp',  'tbsp',  NULL, 15.0,  '큰술'),
  ('unitconv-global-cup',   'cup',   NULL, 240.0, '컵(계량컵 240ml 기준)'),
  ('unitconv-global-pinch', 'pinch', NULL, 0.4,   '꼬집'),
  ('unitconv-global-ea',    'ea',    NULL, 50.0,  '개 — 폴백. 식품별로 반드시 덮어라'),
  ('unitconv-global-slice', 'slice', NULL, 20.0,  '장/조각 — 폴백'),
  ('unitconv-global-clove', 'clove', NULL, 5.0,   '쪽(마늘 기준)');

-- 개정 이력. snapshot_json = 그 리비전의 **결과 상태** 전문(메타+재료+단계).
-- 되돌리기는 과거 스냅샷을 새 rev로 재적용 — 이력을 재작성하지 않는다.
-- diff는 저장하지 않고 쿼리타임 계산(저장하면 스냅샷과 어긋날 수 있다).
CREATE TABLE recipe_revisions (
  id             TEXT PRIMARY KEY,
  recipe_id      TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  rev_no         INTEGER NOT NULL CHECK (rev_no > 0),
  snapshot_json  TEXT NOT NULL,
  change_summary TEXT,
  changed_by     TEXT NOT NULL DEFAULT 'user' CHECK (changed_by IN ('user','agent')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(recipe_id, rev_no)
) STRICT;

CREATE INDEX idx_recipe_revisions_recipe ON recipe_revisions(recipe_id, rev_no DESC);

-- 축별 맛 피드백. 축을 JSON 블롭이 아니라 인라인 컬럼으로 두는 것이 핵심 —
-- 에이전트가 AVG(salt_delta)를 SQL로 집계해 "간장을 줄인다"는 결정론적 근거를 얻는다
-- (foods가 영양을 인라인 컬럼으로 두고 EAV를 YAGNI 컷한 선례와 동일 판단).
-- 부호 규약: +는 "그 방향이 과했다"(salt_delta +2 = 너무 짰다), −는 "부족했다".
CREATE TABLE recipe_feedback (
  id             TEXT PRIMARY KEY,
  recipe_id      TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  rev_no         INTEGER CHECK (rev_no IS NULL OR rev_no > 0),
  meal_log_id    TEXT REFERENCES meal_logs(id) ON DELETE SET NULL,
  rating         INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  salt_delta     INTEGER CHECK (salt_delta IS NULL OR salt_delta BETWEEN -2 AND 2),
  spice_delta    INTEGER CHECK (spice_delta IS NULL OR spice_delta BETWEEN -2 AND 2),
  sweet_delta    INTEGER CHECK (sweet_delta IS NULL OR sweet_delta BETWEEN -2 AND 2),
  sour_delta     INTEGER CHECK (sour_delta IS NULL OR sour_delta BETWEEN -2 AND 2),
  richness_delta INTEGER CHECK (richness_delta IS NULL OR richness_delta BETWEEN -2 AND 2),
  doneness_delta INTEGER CHECK (doneness_delta IS NULL OR doneness_delta BETWEEN -2 AND 2),
  comment        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_recipe_feedback_recipe ON recipe_feedback(recipe_id, created_at DESC);

-- 재료 표기 단위. qty_g는 영양 계산 SSOT로 유지(NOT NULL CHECK > 0) — qty/unit은 표기 +
-- 입력 경로이고 커널이 환산해 qty_g를 채운다.
-- to_taste는 "간 맞춰서" 표기 플래그. 영양 계산은 여전히 qty_g(명목값)를 쓴다 —
-- to_taste를 영양에서 빼면 나트륨이 구조적으로 과소계상된다.
ALTER TABLE recipe_ingredients ADD COLUMN qty REAL CHECK (qty IS NULL OR qty > 0);
ALTER TABLE recipe_ingredients ADD COLUMN unit TEXT;
ALTER TABLE recipe_ingredients ADD COLUMN to_taste INTEGER NOT NULL DEFAULT 0
  CHECK (to_taste IN (0,1));

ALTER TABLE recipes ADD COLUMN source_url TEXT;
ALTER TABLE recipes ADD COLUMN yield_g REAL CHECK (yield_g IS NULL OR yield_g > 0);
ALTER TABLE recipes ADD COLUMN notes TEXT;
ALTER TABLE recipes ADD COLUMN rev_no INTEGER NOT NULL DEFAULT 1 CHECK (rev_no > 0);

-- 기존 instructions 블롭 → 줄 단위 단계로 백필(데이터 무손실). 이후 instructions는 **은퇴**:
-- 커맨드/MCP/모델 표면에서 제거하고 컬럼만 남긴다(STRICT 테이블 컬럼 DROP은 테이블 재생성이
-- 필요해 비용이 크다). 단계와 블롭이 동시에 "조리법 정본"이 되는 이중 진실원을 만들지 않는 게 목적.
-- char(13) 제거: CRLF 원문에서 \r이 단계 본문 끝에 남는 것을 막는다.
WITH RECURSIVE split(recipe_id, rest, line, idx) AS (
  SELECT id, instructions || char(10), '', 0
    FROM recipes
   WHERE instructions IS NOT NULL AND trim(instructions) <> ''
  UNION ALL
  SELECT recipe_id,
         substr(rest, instr(rest, char(10)) + 1),
         substr(rest, 1, instr(rest, char(10)) - 1),
         idx + 1
    FROM split
   WHERE instr(rest, char(10)) > 0
)
INSERT INTO recipe_steps (id, recipe_id, sort_rank, body)
SELECT lower(hex(randomblob(16))), recipe_id, idx * 1.0, trim(replace(line, char(13), ''))
  FROM split
 WHERE trim(replace(line, char(13), '')) <> ''
   -- sqlx 마이그레이터가 1회 실행을 보장하지만, seed INSERT가 섞인 마이그레이션이므로
   -- 재실행 시 단계가 중복 적립되지 않도록 방어한다(0019 선례의 멱등성 요구).
   AND NOT EXISTS (SELECT 1 FROM recipe_steps s WHERE s.recipe_id = split.recipe_id);
