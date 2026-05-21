-- Work Radar — Phase 6 (Notion↔PR status mismatch 감지)
-- 프로젝트별 "완료(done)"로 볼 Notion 상태 이름 목록 (사용자 결정: configurable done names).
-- mismatch 판정 기준 = PR merged인데 Notion 상태가 이 목록에 없으면 drift.
-- 스키마 변경은 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT). 0002가 signals를 확장한 선례.

-- JSON 배열 문자열, e.g. '["Done","완료","Shipped"]'. NULL/미설정이면 mismatch 감지 비활성(noise 0).
ALTER TABLE projects ADD COLUMN notion_done_statuses TEXT;
