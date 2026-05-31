-- Work Radar — schema v40 (G1.5-PR1: 네트워크 설치 provenance)
-- 스키마 변경은 새 마이그레이션으로만(임의 ALTER 금지 — INVARIANT).
--
-- 왜: ADR-0006 레일 ③/④ — 네트워크로 설치한 managed 스킬의 출처(repo URL/ref/commit)와
-- per-skill auto-update opt-in을 기록한다. managed 스킬 콘텐츠는 디스크(skills-library)가 SSOT이고,
-- 이 표는 그 위의 관리 메타데이터(출처·opt-in·staging 상태)다. 시크릿/토큰은 담지 않는다.
PRAGMA foreign_keys = ON;

CREATE TABLE skill_source (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  provider         TEXT NOT NULL,                 -- 중앙 스토어 provider 세그먼트("claude" 등)
  name             TEXT NOT NULL,                 -- 중앙 스토어 스킬 dir 세그먼트
  source_url       TEXT NOT NULL,                 -- 사용자가 설치한 canonical repo ref(시크릿 아님)
  source_ref       TEXT,                          -- 요청 ref/branch/tag (NULL = 기본 브랜치)
  subpath          TEXT,                          -- monorepo 서브디렉터리(있으면)
  installed_commit TEXT NOT NULL,                 -- 설치/적용 시점 resolved SHA
  auto_update      INTEGER NOT NULL DEFAULT 0,    -- per-skill opt-in(G1.5-PR3에서 사용)
  staged_commit    TEXT,                          -- staging에 받아둔 SHA(적용 대기, NULL=없음)
  last_checked_at  TEXT,                          -- 마지막 upstream 확인 ISO8601 UTC
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, name)
);
