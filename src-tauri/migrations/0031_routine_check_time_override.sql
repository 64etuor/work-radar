-- Phase: Today×Timeline merge PR 1.
-- spec §D10: 루틴 시간 변경은 "오늘 인스턴스만". 내일은 정의의 time_of_day로 복귀.
-- routine_checks는 (routine_id, date) 단위 행이라 여기에 override + linked event 저장.
-- (테이블명은 routine_checks(plural) — 0002/0011 마이그레이션 참조.)

ALTER TABLE routine_checks ADD COLUMN time_override      TEXT;
ALTER TABLE routine_checks ADD COLUMN linked_event_id    TEXT;
ALTER TABLE routine_checks ADD COLUMN linked_calendar_id TEXT;
