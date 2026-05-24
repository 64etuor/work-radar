-- PR B: PR Radar 표시 전용 전환. ticket_key_pattern 컬럼 제거(0008 DROP COLUMN 선례).
ALTER TABLE projects DROP COLUMN ticket_key_pattern;
ALTER TABLE repos DROP COLUMN ticket_key_pattern;
