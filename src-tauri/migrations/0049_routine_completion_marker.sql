-- routine_checks.completed_at — 완료 전용 마커.
--
-- 배경: routine_checks는 0002에서 순수 "완료" 테이블이었다(행 존재 = 완료,
-- done_at = 완료 시각). 0031이 time_override/linked_event_id/linked_calendar_id를
-- 같은 테이블에 얹으면서, 캘린더 배치(ensure_routine_check_row)와 시각 override INSERT도
-- done_at NOT NULL DEFAULT(datetime('now'))로 행을 만들어 "완료"로 오인됐다 —
-- 루틴을 캘린더에 배치하거나 시각을 바꾸면 체크박스가 켜지고, 체크 해제 시
-- 링크/override 행까지 삭제됐다.
--
-- 완료를 link/override와 분리하기 위해 nullable 완료 마커를 추가한다.
-- 신 의미: done = (completed_at IS NOT NULL). done_at은 레거시(NOT NULL DEFAULT 유지,
-- 더는 done 판정에 읽지 않음).
ALTER TABLE routine_checks ADD COLUMN completed_at TEXT;

-- 백필: link/override가 전혀 없는 기존 행 = 진짜 완료 기록 → done_at을 completed_at으로 승계.
-- link/override가 있는 행은 완료로 단정할 수 없으므로(배치/override 목적일 수 있음) NULL 유지
-- — 이는 과거 false-done 표시를 교정한다(scheduled≠done).
UPDATE routine_checks
   SET completed_at = done_at
 WHERE linked_event_id IS NULL
   AND linked_calendar_id IS NULL
   AND time_override IS NULL;

-- done 판정용 부분 인덱스(listing/weekly/tracking 읽기 경로).
CREATE INDEX IF NOT EXISTS idx_routine_checks_completed
  ON routine_checks(routine_id, date)
  WHERE completed_at IS NOT NULL;
