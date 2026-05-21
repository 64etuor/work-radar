-- Work Radar — schema v3 (Phase 3: Notion 승격 write 레일)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- (signal, target)당 created 승격은 최대 하나 — 동시 승격(더블클릭) / flush vs 수동 경합이
-- 중복 Notion 페이지·중복 created 행을 만드는 것을 DB 레벨에서 구조적으로 막는다(INVARIANT #3).
-- 실행 직렬화(in-process 게이트)와 함께 방어선을 이룬다. draft/failed 행에는 영향 없음(partial).

PRAGMA foreign_keys = ON;

CREATE UNIQUE INDEX idx_promotions_created_unique
  ON promotions(signal_id, target) WHERE status = 'created';
