-- Work Radar — schema v4 (Phase 4: GitHub PR Radar — read 레일)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- PR Radar 항목은 매 폴링마다 GitHub에서 새로 fetch되는 ambient 상태라 별도 영속 테이블이 없다.
-- (임계치 넘는 것만 signals로 escalate되어 dedup upsert/auto-resolve — INVARIANT #3/#4.)
-- 단, "수동 self-check"는 GitHub 상태가 아니라 사람이 누른 로컬 결정이라 영속이 필요하다.
-- 행 존재 = 해당 PR이 self-check됨 (routine_checks와 같은 날짜/존재 기반 패턴).

PRAGMA foreign_keys = ON;

CREATE TABLE pr_self_checks (
  id             TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,          -- 'owner/repo'
  pr_number      INTEGER NOT NULL,
  checked_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (repo_full_name, pr_number)
);
CREATE INDEX idx_pr_self_checks_repo ON pr_self_checks(repo_full_name);
