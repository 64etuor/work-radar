-- Work Radar — schema v41 (External Action Gate Phase 0)
-- 스키마 변경은 새 마이그레이션으로만(임의 ALTER 금지 — INVARIANT).
--
-- 왜: 외부 서비스 쓰기(Notion/GitHub/Gmail/Calendar)를 AI가 '제안'하되 실행은 사용자 승인 후
-- Rust 커넥터만 — 그 단일 초크포인트 큐. external_actions = 제안/승인 상태머신.
-- external_action_audit = append-only 감사(PII/시크릿 금지: service/bytes 등 메타만).
PRAGMA foreign_keys = ON;

CREATE TABLE external_actions (
  id          TEXT PRIMARY KEY,                  -- lower(hex(randomblob(16))) — acceptances 관례
  kind        TEXT NOT NULL,                     -- "github.comment" | "gmail.send" | "notion.update" | ...
  project_ref TEXT,                              -- credential_ref(토큰 격리) — nullable
  payload     TEXT NOT NULL,                     -- 검증된 JSON. PII 가능 → 로컬 SQLite만, 로그 금지
  preview     TEXT,                              -- 사람-친화 요약(승인 패널 표시용) — nullable
  origin      TEXT NOT NULL,                     -- "mcp:<agent>" | "codex:<run_id>" | "hermes:<tab>"
  status      TEXT NOT NULL,                     -- awaiting_approval | executing | succeeded | failed | rejected
  result      TEXT,                              -- 외부 응답 메타(id/크기, 본문 금지) — nullable
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT                               -- 승인/거절 시각 — nullable
);

-- 대기 큐 조회 핫패스(오래된 것 먼저 = FIFO 승인).
CREATE INDEX idx_external_actions_status ON external_actions (status, created_at);

CREATE TABLE external_action_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id   TEXT NOT NULL,                     -- external_actions.id (append-only, FK 미강제: 감사 보존)
  event       TEXT NOT NULL,                     -- "enqueued" | "approved" | "executed" | "rejected" | "failed"
  detail      TEXT,                              -- "service=github,bytes=412" — 시크릿/본문 금지
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_external_action_audit_created ON external_action_audit (created_at DESC);
