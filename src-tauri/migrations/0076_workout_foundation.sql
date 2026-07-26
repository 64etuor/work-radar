-- Workout 도메인 기반 (docs/plans/2026-07-26-recipe-authoring-workout.md §8).
--
-- **경계 결정 1: 계획·스케줄을 만들지 않는다.** 기존 `routines`(습관 트래킹 + 캘린더 미러)가
-- 이미 그 일을 한다. 이 도메인은 **실적 기록 + 체성분**만 소유한다.
-- `workout_sessions.routine_id` 링크도 두지 않는다 — KR↔루틴 자동집계에서 겪은 파생 이중계상
-- 위험을 반복하지 않기 위해서다(필요해지면 별도 결정으로 추가).
--
-- **경계 결정 2: `diet_goals`를 활동량으로 자동 수정하지 않는다.** 목표는 append-only 스냅샷이고
-- 파생 판단값 자동 설정은 결정레일 INVARIANT #1 위반이다. 식단↔운동 연동은 read-only 파생
-- (섭취 − BMR − 운동소모)뿐이다.

-- 종목 라이브러리. met = MET 계수(소모 kcal = MET × 체중kg × 시간h — 결정론 커널).
CREATE TABLE exercises (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  modality       TEXT NOT NULL DEFAULT 'strength'
                 CHECK (modality IN ('strength','cardio','mobility','sport')),
  primary_muscle TEXT,
  equipment      TEXT,
  met            REAL CHECK (met IS NULL OR met > 0),
  source         TEXT NOT NULL DEFAULT 'manual',
  source_ref     TEXT,
  archived       INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_exercises_name ON exercises(name);

-- 검색 별칭(foods/food_aliases와 같은 패턴 — normalized UNIQUE).
CREATE TABLE exercise_aliases (
  id          TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  normalized  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(normalized)
) STRICT;

CREATE INDEX idx_exercise_aliases_exercise ON exercise_aliases(exercise_id);

-- 운동 세션 = "이 날 이 시간에 운동했다"는 관측 사실. 계획이 아니다.
CREATE TABLE workout_sessions (
  id                 TEXT PRIMARY KEY,
  date               TEXT NOT NULL,
  started_at         TEXT,
  ended_at           TEXT,
  title              TEXT,
  perceived_exertion INTEGER
                     CHECK (perceived_exertion IS NULL OR perceived_exertion BETWEEN 1 AND 10),
  note               TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_workout_sessions_date ON workout_sessions(date DESC, created_at DESC);

-- 세트. 근력은 reps+weight_kg, 유산소는 duration_sec+distance_m — 한 테이블에 모아두고
-- 종목 modality가 어느 축을 읽을지 정한다(개인용 규모에서 테이블 분리는 YAGNI).
CREATE TABLE workout_sets (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise_id  TEXT NOT NULL REFERENCES exercises(id),
  sort_rank    INTEGER NOT NULL DEFAULT 0,
  reps         INTEGER CHECK (reps IS NULL OR reps > 0),
  weight_kg    REAL CHECK (weight_kg IS NULL OR weight_kg >= 0),
  duration_sec INTEGER CHECK (duration_sec IS NULL OR duration_sec > 0),
  distance_m   REAL CHECK (distance_m IS NULL OR distance_m > 0),
  rest_sec     INTEGER CHECK (rest_sec IS NULL OR rest_sec >= 0),
  rpe          INTEGER CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX idx_workout_sets_session ON workout_sets(session_id, sort_rank);
CREATE INDEX idx_workout_sets_exercise ON workout_sets(exercise_id, created_at DESC);

-- 체성분 시계열. 체중은 변하므로 프로필이 아니라 여기에 쌓인다.
CREATE TABLE body_metrics (
  id                 TEXT PRIMARY KEY,
  measured_on        TEXT NOT NULL,
  weight_kg          REAL CHECK (weight_kg IS NULL OR weight_kg > 0),
  body_fat_pct       REAL CHECK (body_fat_pct IS NULL OR (body_fat_pct >= 0 AND body_fat_pct < 100)),
  skeletal_muscle_kg REAL CHECK (skeletal_muscle_kg IS NULL OR skeletal_muscle_kg > 0),
  waist_cm           REAL CHECK (waist_cm IS NULL OR waist_cm > 0),
  note               TEXT,
  source             TEXT NOT NULL DEFAULT 'manual',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- 같은 날 재측정은 갱신(하루 한 행) — 체중 추이 이동평균이 중복 측정에 흔들리지 않게.
  UNIQUE(measured_on)
) STRICT;

CREATE INDEX idx_body_metrics_measured ON body_metrics(measured_on DESC);

-- 변하지 않는 신체 정보(BMR 계산 입력). 단일행 — id는 sentinel로 고정한다.
CREATE TABLE body_profile (
  id         TEXT PRIMARY KEY CHECK (id = 'singleton'),
  birth_year INTEGER CHECK (birth_year IS NULL OR (birth_year > 1900 AND birth_year < 2200)),
  height_cm  REAL CHECK (height_cm IS NULL OR height_cm > 0),
  sex        TEXT CHECK (sex IS NULL OR sex IN ('male','female','other')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

-- 사용자 제공값(2026-07-26): 1987년생 / 171cm / 남성, 현재 체중 69kg.
-- 체중은 프로필이 아니라 시계열의 첫 행으로 들어간다(측정일 = 제공 시점, 명시 리터럴 —
-- date('now')는 UTC라 로컬 날짜와 어긋날 수 있다).
-- seed INSERT가 있으므로 `0019` 선례에 따라 멱등성 테스트 대상이다.
INSERT OR IGNORE INTO body_profile (id, birth_year, height_cm, sex)
VALUES ('singleton', 1987, 171.0, 'male');

INSERT OR IGNORE INTO body_metrics (id, measured_on, weight_kg, source, note)
VALUES ('bodymetric-seed-2026-07-26', '2026-07-26', 69.0, 'seed', '초기 등록값');
