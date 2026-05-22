-- Work Radar — schema v11 (Phase 16: Routines 강화)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 이 마이그레이션이 추가하는 것 (전부 로컬 routines — 외부 무관, INVARIANT #7 SQLite SSOT):
--   1) freq CHECK 확장: 'biweekly'/'monthly' 추가 (날짜 기준 occurrence).
--   2) anchor_date: biweekly 2주 주기·monthly 매월 day-of-month의 기준일 (YYYY-MM-DD). NULL 허용
--      (daily/weekly는 무관). biweekly/monthly 생성 시 채워진다.
--   3) rank: 드래그 정렬 순서(작을수록 위, 공용 useListReorder + reorder_routines). NULL=미정렬 → 끝.
--   4) time_of_day: 알림 발사 기준 시각 'HH:MM'(로컬). NULL=알림 없음.
--   5) reminder_offset_min: 발사를 시각보다 N분 앞당김(예: 30 = 30분 전). NULL/0=정시.
--
-- 알림: 시각이 있는 due 루틴은 `scheduled_notifications`에 (오늘 + time_of_day - offset) 행을
--   deterministic source_id('routine:{id}:{date}')로 INSERT OR IGNORE한다 → Phase 13 스케줄러가
--   bounded tick으로 발사한다(스케줄러 코드 무변경, INVARIANT #5). 멱등 — 하루 한 번만 enqueue.
--
-- ⚠️ FK-안전 재작성(데이터 무손실): SQLite는 CHECK 제약을 ALTER 못 해 routines를 rebuild해야 한다.
--   그런데 sqlx 0.8은 마이그레이션을 **트랜잭션 안에서** 실행하고, `PRAGMA foreign_keys=OFF`는
--   트랜잭션 안에선 **no-op**이다(연결 기본값 foreign_keys=ON 유지). FK가 켜진 채 `DROP TABLE routines`는
--   암시적 DELETE를 일으켜 `routine_checks(routine_id REFERENCES routines ON DELETE CASCADE)`를
--   **통째로 지운다(완료 이력 손실)**. → 그래서 routine_checks도 함께 rebuild하고, 인바운드 FK 참조가
--   사라지는 순서로 drop한다(어떤 시점에도 cascade가 발화하지 않음). PRAGMA OFF는 의도 표기용(무해).

PRAGMA foreign_keys = OFF;

-- 1) routines 새 스키마 (freq CHECK 확장 + 신규 컬럼). 기존 컬럼 보존 복사.
CREATE TABLE routines_new (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  freq                TEXT NOT NULL CHECK (freq IN ('daily','weekly','biweekly','monthly')),
  weekdays            TEXT,                          -- JSON 배열 (weekly/biweekly일 때 의미)
  anchor_date         TEXT,                          -- YYYY-MM-DD (biweekly 2주 주기·monthly day 기준)
  rank                INTEGER,                        -- 드래그 정렬(작을수록 위). NULL=끝.
  time_of_day         TEXT,                          -- 'HH:MM' (로컬). NULL=알림 없음.
  reminder_offset_min INTEGER,                        -- N분 전 발사. NULL/0=정시.
  area                TEXT CHECK (area IS NULL OR area IN
                        ('health','work','studies','environment','recreation','romance','family','friends','finances','other')),
  kind                TEXT CHECK (kind IS NULL OR kind IN ('personal','work')),
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO routines_new (id, project_id, title, freq, weekdays, area, kind, active, created_at)
  SELECT id, project_id, title, freq, weekdays, area, kind, active, created_at FROM routines;

-- 2) routine_checks를 routines_new를 가리키도록 rebuild(데이터 보존). 스키마는 0002와 동일.
CREATE TABLE routine_checks_new (
  id         TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines_new(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  done_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (routine_id, date)
);
INSERT INTO routine_checks_new (id, routine_id, date, done_at)
  SELECT id, routine_id, date, done_at FROM routine_checks;

-- 3) 옛 테이블 drop — routine_checks 먼저(인바운드 FK 없음), 그다음 routines(이제 참조 없음 → cascade 0).
DROP TABLE routine_checks;
DROP TABLE routines;

-- 4) rename. routines_new→routines 시 routine_checks_new의 FK 참조가 routines로 갱신된다(modern SQLite).
ALTER TABLE routines_new RENAME TO routines;
ALTER TABLE routine_checks_new RENAME TO routine_checks;

-- 5) 인덱스 재생성.
CREATE INDEX idx_routines_active ON routines(active);
CREATE INDEX idx_routines_rank ON routines(rank);
CREATE INDEX idx_routine_checks_routine ON routine_checks(routine_id);

PRAGMA foreign_keys = ON;
