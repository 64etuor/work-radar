-- 사용자가 종료 잡(succeeded/failed/cancelled) 결과 모달을 닫아 "확인 완료"로 마킹한 시각.
-- 이전엔 localStorage(Set<runId>)로 클라이언트에서만 추적해, cap 트림/캐시 클리어/리인스톨
-- 시 acked 정보가 소실되어 잡이 바에 다시 나타나는 회귀가 있었다. SQLite SSOT(AGENTS.md
-- INVARIANT — "매트릭스/신호/승격/잡의 SSOT")로 일치시킨다. NULL = 아직 미확인.
ALTER TABLE agent_runs ADD COLUMN acked_at TEXT;
