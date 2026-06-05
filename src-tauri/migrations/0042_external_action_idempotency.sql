-- Work Radar — schema v42 (External Action Gate: idempotency)
-- 스키마 변경은 새 마이그레이션으로만(임의 ALTER 금지 — 이 ALTER는 마이그레이션 경유라 허용).
--
-- 왜: Phase 2~5 MCP write 툴이 재시도(타임아웃/네트워크 등)로 **동일 제안을 다시 enqueue**하면
-- 중복 pending 액션이 쌓여, 사용자가 같은 외부 쓰기(예: PR 코멘트)를 두 번 승인할 수 있다.
-- idempotency_key로 "활성(awaiting_approval|executing) 동일 제안"을 1건으로 dedup한다.
-- 터미널(succeeded|failed|rejected) 도달 후 같은 키의 재제안은 **허용**(새 행) — 부분 유니크
-- 인덱스가 활성 상태에서만 유일성을 강제하므로, 끝난 제안을 다시 보내는 정당한 경우를 막지 않는다.
-- key가 NULL이면(키 미지정 제안) dedup 대상 아님 — 부분 인덱스 WHERE에서 제외.
--
-- ⚠️ 'executing'이 활성 집합에 포함된다 = 실행 중 키를 잠근다(중복 실행 방지). 이는 crash-orphan
-- reaper(PR-C: 시동 시 'executing' 좀비 → failed)가 있어야 안전하다 — reaper 없이 실행 중 크래시가
-- 나면 그 키가 영구히 잠긴다. **실 idempotency_key를 쓰는 Phase 2 커넥터는 reaper 선행이 전제.**
PRAGMA foreign_keys = ON;

ALTER TABLE external_actions ADD COLUMN idempotency_key TEXT;

-- 활성 제안에 한해 idempotency_key 유일. NULL·터미널 행은 인덱스에서 제외(부분 인덱스).
CREATE UNIQUE INDEX idx_external_actions_idem_active
  ON external_actions (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('awaiting_approval', 'executing');
