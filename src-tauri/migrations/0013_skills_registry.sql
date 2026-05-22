-- Work Radar — schema v13 (Phase 20 #21: 스킬 공유 레지스트리)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 왜 필요한가:
--   인앱 에이전트 프롬프트(현 하드코딩 enrich/batch_enrich/ci_triage/pr_selfcheck)와 외부
--   Claude/Codex 스킬(~/.claude/skills/*/SKILL.md)을 **한 레지스트리**에서 보기/편집/토글한다.
--   잡 트리거는 binding으로 활성 인앱 프롬프트를 조회해 쓰되, 레지스트리가 비어 있거나 비활성이면
--   코드 상수로 폴백한다 — 기본 동작은 절대 바뀌지 않는다(레지스트리는 행위 무변경 오버레이).
--
-- INVARIANT #1/#2: 스킬(프롬프트) 편집은 codex가 내는 *제안 내용*만 바꾼다. 잡은 여전히 제안 레일 +
--   Acceptance 게이트(awaiting_approval)를 거치고, accept 코드는 suggested_*/proposal만 쓴다 —
--   스킬을 편집해도 자동 분류/자동 적용 경로는 절대 생기지 않는다(구조적 보호). 스킬은 자동 실행 안 됨.
-- INVARIANT #7: 인앱 프롬프트(편집 가능 템플릿)는 로컬 SQLite SSOT. 외부 스킬은 디스크가 SSOT이고
--   이 표는 source_path 포인터만 캐시한다(내용은 스캔 시 디스크에서 읽는다).
--
-- 토큰/비밀은 담지 않는다(프롬프트 템플릿은 비밀 아님).

PRAGMA foreign_keys = ON;

-- 스킬 레지스트리. kind = 'in_app_prompt'(편집 가능 잡 프롬프트) | 'external'(디스크 스킬 포인터).
CREATE TABLE skills (
  id          TEXT PRIMARY KEY,                          -- lower(hex(randomblob(16))). 인앱 시드는 'skill_<binding>' 고정.
  name        TEXT NOT NULL,                             -- 표시 이름.
  kind        TEXT NOT NULL CHECK (kind IN ('in_app_prompt','external')),
  prompt      TEXT,                                      -- in_app_prompt: 편집 가능 템플릿. external: NULL(디스크에서 읽음).
  binding     TEXT,                                      -- in_app_prompt: 잡 키(enrich/batch_enrich/ci_triage/pr_selfcheck). external: NULL.
  rail        TEXT,                                      -- 표시용 레일(suggestion). 결정 레일 침범 없음(표시 메타).
  enabled     INTEGER NOT NULL DEFAULT 1,                -- 0이면 잡 lookup이 폴백(코드 상수)을 쓴다.
  source_path TEXT,                                      -- external: SKILL.md 디렉터리/파일 경로. in_app: NULL.
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- binding당 인앱 프롬프트는 하나만(잡 lookup이 단일 활성 행을 찾도록). external은 binding NULL이라 자유.
CREATE UNIQUE INDEX idx_skills_binding ON skills (binding) WHERE binding IS NOT NULL;

-- 레지스트리 목록 핫패스: kind별 정렬 스캔.
CREATE INDEX idx_skills_kind ON skills (kind);
