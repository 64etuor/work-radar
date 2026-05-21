-- Work Radar — Phase 10b (Google Calendar 캘린더 선택)
-- 프로젝트별 "포함할 캘린더" 선택 목록. INVARIANT #7: 선택 목록은 로컬 SQLite SSOT
-- (이벤트는 ambient — 영속 안 함; 토큰/secret/refresh_token은 keychain, 여기 아님).
-- 스키마 변경은 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT). 0005가 projects를 확장한 선례.

-- JSON 배열 문자열, e.g. '[{"id":"primary","summary":"내 캘린더"}]'. NULL/빈 목록이면 fetch 결과 없음.
ALTER TABLE projects ADD COLUMN google_calendar_ids TEXT;
