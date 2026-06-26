-- Work Radar — schema v61 (Routines: 활성 기간 = 시작일 + 종료일)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT #7).
--
-- 이 마이그레이션이 추가하는 것 (전부 로컬 routines — 외부 무관, INVARIANT #7 SQLite SSOT):
--   1) start_date: 루틴 활성 구간의 시작일 (YYYY-MM-DD). NULL = 하한 없음(= 기존 동작).
--   2) end_date:   루틴 활성 구간의 종료일 (YYYY-MM-DD, inclusive). NULL = 무기한(= 기존 동작).
--
-- 의미: 구간 밖 날짜는 루틴이 "due 아님"으로 처리된다(요일 게이팅과 동일). 정본은 순수
--   due-calc `routine_due_on`(schedule.rs)이 start/end 게이트로 강제 → 오늘 목록·트래킹·주간이
--   한 곳에서 일관. 둘 다 NULL이면 기존 무기한 동작과 정확히 동일(행동 변화 0).
--
-- 형식(YYYY-MM-DD)·순서(end >= start) 검증은 애플리케이션(crud::validate_active_period)이
--   보증한다 — SQLite CHECK로 날짜 형식 강제는 부적절(monthly nth_week 교차검증과 동일 패턴).
--   순수 additive ADD COLUMN이라 0011 같은 FK-안전 테이블 rebuild 불필요.

ALTER TABLE routines ADD COLUMN start_date TEXT;  -- 'YYYY-MM-DD', NULL = 하한 없음
ALTER TABLE routines ADD COLUMN end_date   TEXT;  -- 'YYYY-MM-DD' inclusive, NULL = 무기한
