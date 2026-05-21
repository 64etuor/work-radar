-- Work Radar — schema v2 (Phase 1: Capture Board)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 이 마이그레이션이 추가하는 것:
--   1) signals 확장: kind(개인/업무 힌트), area/suggested_area(라이프 도메인, Phase 9 AI),
--      today_for_date/today_done_at/today_rank (Today 레일 멤버십·완료·정렬, 로컬 상태).
--   2) routines + routine_checks: 반복 작업(루틴) 영역 (WorkSignal/매트릭스와 별개 엔티티).

PRAGMA foreign_keys = ON;

-- ── signals 확장 ─────────────────────────────────────────────────────────────
-- kind: 개인/업무 힌트 (입력 맨앞 토큰 마커 > 세그먼트 토글 > 기본 업무).
--   Phase 2에서 projectId로 reconcile. NULL 허용(미지정).
ALTER TABLE signals ADD COLUMN kind TEXT
  CHECK (kind IS NULL OR kind IN ('personal','work'));

-- area: 라이프 도메인 (사람 확정값). 닫힌 taxonomy (Wheel of Life + other).
--   Phase 1은 데이터 필드만; AI 추론(suggested_area)·칩 표시는 Phase 9 enrich.
ALTER TABLE signals ADD COLUMN area TEXT
  CHECK (area IS NULL OR area IN
    ('health','work','studies','environment','recreation','romance','family','friends','finances','other'));

-- suggested_area: AI 추론 힌트 (제안 레일, truth 아님). Phase 1은 항상 NULL.
ALTER TABLE signals ADD COLUMN suggested_area TEXT
  CHECK (suggested_area IS NULL OR suggested_area IN
    ('health','work','studies','environment','recreation','romance','family','friends','finances','other'));

-- Today 레일 멤버십 (로컬 승격, Acceptance 불요).
--   today_for_date: Today로 옮긴 날(YYYY-MM-DD). NULL = Today 아님(매트릭스/미분류에 있음).
--     이월돼도 불변 → 경과일 카운터 +N = (오늘 − today_for_date) + 1 의 기준점.
--   today_done_at: Today에서 완료 체크한 날(YYYY-MM-DD). 완료는 다음날 이월 안 됨.
--   today_rank: Today 레일 내 정렬 순서(작을수록 위).
ALTER TABLE signals ADD COLUMN today_for_date TEXT;
ALTER TABLE signals ADD COLUMN today_done_at  TEXT;
ALTER TABLE signals ADD COLUMN today_rank     INTEGER;

CREATE INDEX idx_signals_today ON signals(today_for_date) WHERE today_for_date IS NOT NULL;

-- ── routines — 반복 작업(루틴). 보드 우측 하단 영역. ───────────────────────────
-- 스케줄: 매일(daily) 또는 매주 특정 요일(weekly + weekdays). 오늘 해당분만 표시.
-- WorkSignal/매트릭스와 별개 엔티티(반복은 결정 큐에 안 쌓임).
CREATE TABLE routines (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  freq       TEXT NOT NULL CHECK (freq IN ('daily','weekly')),
  weekdays   TEXT,                          -- JSON 배열, e.g. '["wed","fri"]' (weekly일 때만 의미)
  area       TEXT CHECK (area IS NULL OR area IN
               ('health','work','studies','environment','recreation','romance','family','friends','finances','other')),
  kind       TEXT CHECK (kind IS NULL OR kind IN ('personal','work')),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_routines_active ON routines(active);

-- routine_checks — 날짜별 완료 (append/delete). 다음날 새 date라 자동 리셋(재등장).
CREATE TABLE routine_checks (
  id         TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,                 -- YYYY-MM-DD (로컬 날짜)
  done_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (routine_id, date)
);
CREATE INDEX idx_routine_checks_routine ON routine_checks(routine_id);
