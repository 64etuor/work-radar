-- Phase: Today×Timeline merge PR 1.
-- 카드를 시간축에 배치하기 위한 필드. spec §D8: 카드가 정본, Google은 mirror.
-- - scheduled_at: RFC3339 UTC. NULL=미배치 (트레이에 남음).
-- - scheduled_duration: 분.
-- - linked_event_id / linked_calendar_id: Google mirror 핸들. delete 후 NULL.

ALTER TABLE signals ADD COLUMN scheduled_at        TEXT;
ALTER TABLE signals ADD COLUMN scheduled_duration  INTEGER;
ALTER TABLE signals ADD COLUMN linked_event_id     TEXT;
ALTER TABLE signals ADD COLUMN linked_calendar_id  TEXT;

CREATE INDEX idx_signals_scheduled
  ON signals(scheduled_at) WHERE scheduled_at IS NOT NULL;
