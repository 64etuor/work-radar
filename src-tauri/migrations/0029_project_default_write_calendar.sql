-- Phase: Today×Timeline merge PR 1.
-- 프로젝트별 "일정 생성 기본 캘린더" id. drop 시 카드의 project를 통해 조회된다.
-- NULL = 미설정 → 프런트가 드롭 시 popover로 선택을 요구하고 첫 선택을 저장.
-- googleCalendarIds(JSON array)에 없는 id면 무효 → 프런트에서 NULL 취급.

ALTER TABLE projects ADD COLUMN default_write_calendar_id TEXT;
