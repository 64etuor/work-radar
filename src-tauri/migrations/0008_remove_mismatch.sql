-- Phase 12a — remove MISMATCH feature (Phase 6 폐기, 사용자 결정).
DELETE FROM signals WHERE type = 'mismatch';
ALTER TABLE projects DROP COLUMN notion_done_statuses;
ALTER TABLE signals DROP COLUMN snapshot;
