-- KR ↔ 루틴 연결 (Mission/OKR): 루틴 완료가 KR 진행으로 자동 집계된다.
-- 집계는 쿼리타임 파생(저장값 아님) — 입력은 매일 루틴 체크 한 곳으로 수렴하고,
-- 루틴이 지워지면 링크만 풀린다(ON DELETE SET NULL, KR 무손상).
ALTER TABLE key_results ADD COLUMN routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL;

CREATE INDEX idx_key_results_routine_id
  ON key_results(routine_id)
  WHERE routine_id IS NOT NULL;
