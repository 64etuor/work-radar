-- Work Radar — schema v39 (G1: 스킬 매니저 감사 로그)
-- 스키마 변경은 새 마이그레이션으로만(임의 ALTER 금지 — INVARIANT).
--
-- 왜: ADR-0006 레일 ① — 중앙 라이브러리에 대한 모든 쓰기(import/remove/…)는 가역·감사 가능해야 한다.
-- append-only 기록. PII/시크릿 금지: detail에는 경로/action/크기만, frontmatter 본문·토큰 절대 금지.
PRAGMA foreign_keys = ON;

CREATE TABLE skill_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,                       -- "import" | "remove" (G1.5에서 install/update 등 추가)
  target_kind TEXT NOT NULL,                       -- "managed_skill"
  target_ref  TEXT NOT NULL,                       -- 중앙 스토어 경로(시크릿 아님)
  source_ref  TEXT,                                -- 원본 외부 경로(import 시) — nullable
  detail      TEXT,                                -- 비밀-free 메모(예: "files=3,bytes=1024") — nullable
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 시간순 조회 핫패스(최근 먼저).
CREATE INDEX idx_skill_audit_created ON skill_audit_log (created_at DESC);
