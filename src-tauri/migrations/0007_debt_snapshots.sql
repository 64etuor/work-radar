-- Work Radar — schema v7 (Phase 11a: Work Debt 일별 스냅샷)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 왜 필요한가:
--   Work Debt 지표(미분류·Q1 overdue·stale backlog·cleanup·PR attention)는 *현재 상태*만
--   집계 가능하다 — signals.updated_at이 덮여서 일별 부채 수준을 사후 재구성할 수 없다.
--   Weekly review(#11c)의 "부채 추세"를 위해 하루 1회 멱등 스냅샷을 남긴다.
--
-- INVARIANT #3: append 아님 — date PK로 upsert(같은 날 재방문은 최신값으로 갱신, 중복 0).
-- INVARIANT #7: 로컬 상태 메트릭의 SSOT(로컬 SQLite). Notion/외부 무관, 토큰 미포함.
-- 추세는 *전진 누적*이다(백필 없음) — Today 운영 뷰를 처음 연 날부터 채워진다.

PRAGMA foreign_keys = ON;

CREATE TABLE debt_snapshots (
  date           TEXT PRIMARY KEY,            -- YYYY-MM-DD (로컬 날짜)
  unclassified   INTEGER NOT NULL DEFAULT 0,  -- quadrant=unclassified active (today 레일 밖)
  q1_overdue     INTEGER NOT NULL DEFAULT 0,  -- q1_do_now active & 생성 ≥ 1일 경과
  stale_backlog  INTEGER NOT NULL DEFAULT 0,  -- active & 생성 ≥ 14일 경과 (today 레일 밖)
  cleanup_needed INTEGER NOT NULL DEFAULT 0,  -- type=cleanup active
  pr_attention   INTEGER NOT NULL DEFAULT 0,  -- 매트릭스로 escalate된 github_pr 신호 수
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
