-- Work Radar — schema v37 (Routines → Google Calendar opt-in sync)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT #7).
--
-- 이 마이그레이션이 추가하는 것:
--   1) routines에 sync 미러 컬럼(google_calendar_id / google_event_id) + duration_min(분).
--   2) 풍부 monthly 패턴: monthly_pattern(day_of_month|nth_weekday) + monthly_nth_week(-1..5).
--   3) routine_exdates 테이블 — "오늘 빼기" 로컬 SSOT. Google EXDATE와 양방향 일치.
--
-- 결정 로그: docs/adr/0005-routine-google-sync.md (ADR-0005).
-- 플랜: docs/plans/2026-05-29-routine-google-sync.md §2.
--
-- sync-pair invariant (google_event_id ↔ google_calendar_id)는 row-level CHECK 대신
-- application-level 가드 + 단위 테스트로 유지(0011 같은 routines rebuild 비용 회피).
-- 결정 이력: docs/decisions.md 2026-05-29 항목.

-- 1) routines: sync mirror + duration + monthly pattern.
ALTER TABLE routines ADD COLUMN google_calendar_id TEXT;       -- NULL = local-only
ALTER TABLE routines ADD COLUMN google_event_id TEXT;          -- master recurring event id
ALTER TABLE routines ADD COLUMN duration_min INTEGER;          -- NULL → fallback 30
ALTER TABLE routines ADD COLUMN monthly_pattern TEXT
  CHECK (monthly_pattern IS NULL OR monthly_pattern IN ('day_of_month','nth_weekday'));
ALTER TABLE routines ADD COLUMN monthly_nth_week INTEGER
  CHECK (monthly_nth_week IS NULL OR (monthly_nth_week BETWEEN -1 AND 5 AND monthly_nth_week != 0));
-- nth_week 의미: 1=첫째, 2=둘째, 3=셋째, 4=넷째, 5=다섯째(존재 시), -1=마지막.

-- 2) EXDATE 저장(local SSOT). 'YYYY-MM-DD'로 저장 — Google EXDATE 송신 시 time_of_day와
--    결합해 'YYYYMMDDTHHMMSS'로 변환(routines::rrule::exdate_local).
CREATE TABLE routine_exdates (
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (routine_id, date)
);
CREATE INDEX idx_routine_exdates_routine ON routine_exdates(routine_id);
