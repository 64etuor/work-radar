-- Work Radar — schema v1 (Phase 0)
-- SSOT: 이 SQLite DB가 매트릭스 상태·신호·승격 이력·에이전트 잡의 SSOT.
-- Notion = 백로그/안건 *내용*의 SSOT (여기엔 미러/링크만).
-- 스키마 변경은 반드시 새 마이그레이션 파일로만 (임의 ALTER 금지).

PRAGMA foreign_keys = ON;

-- 1) projects — 최상위 그룹 (개인/업무). 토큰은 keychain(credential_ref)으로만 참조.
CREATE TABLE projects (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('personal','work')),
  notion_backlog_db_id TEXT,
  notion_agenda_db_id  TEXT,
  ticket_key_pattern   TEXT,                 -- join key, e.g. 'MIR-DEV-\d+'
  credential_ref       TEXT NOT NULL,        -- keychain 키 (평문 토큰 저장 금지)
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2) repos — project별 여러 레포 (github remote 또는 local path).
CREATE TABLE repos (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL CHECK (provider IN ('github','local')),
  remote_url         TEXT,
  local_path         TEXT,                   -- Codex worktree 베이스
  default_branch     TEXT NOT NULL DEFAULT 'main',
  ticket_key_pattern TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_repos_project ON repos(project_id);

-- 3) signals — 매트릭스 결정 큐. quadrant(사람 결정) vs suggested_quadrant(파생 힌트) 분리.
--    system/PR/Hermes 신호는 dedup_key로 upsert (append 아님).
CREATE TABLE signals (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  body               TEXT,
  source             TEXT NOT NULL CHECK (source IN
                       ('braindump','notion_backlog','notion_agenda','github_pr','calendar','hermes','system')),
  type               TEXT NOT NULL CHECK (type IN
                       ('thought','task_candidate','decision_candidate','pr_attention',
                        'agent_alert','meeting_prep','stale','mismatch','cleanup')),
  -- 사람 결정값. 카드는 항상 unclassified로 진입 (INVARIANT: 결정 레일은 사람만).
  quadrant           TEXT NOT NULL DEFAULT 'unclassified' CHECK (quadrant IN
                       ('q1_do_now','q2_schedule','q3_quick_contain','q4_drop','unclassified')),
  suggested_quadrant TEXT,                   -- 파생 힌트 (truth 아님, 언제든 재계산)
  suggestion_reason  TEXT,
  dedup_key          TEXT,                   -- 안정적 upsert 키, e.g. 'pr:42:ci_failed'
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN
                       ('new','classified','promoted','linked','done','snoozed','archived')),
  snooze_until       TEXT,
  links              TEXT,                   -- JSON: { notionBacklogId, githubPrUrl, ... }
  snapshot           TEXT,                   -- JSON: { prState, notionState } (drift 비교용)
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_signals_dedup ON signals(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX idx_signals_project  ON signals(project_id);
CREATE INDEX idx_signals_quadrant ON signals(quadrant);
CREATE INDEX idx_signals_status   ON signals(status);

-- 4) promotions — append-only (undo/audit). 카드→Notion/Today/Calendar 승격 이력.
CREATE TABLE promotions (
  id                  TEXT PRIMARY KEY,
  signal_id           TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  target              TEXT NOT NULL CHECK (target IN ('notion_backlog','notion_agenda','today','calendar')),
  status              TEXT NOT NULL CHECK (status IN ('draft','confirmed','created','failed')),
  draft_payload       TEXT NOT NULL,         -- JSON
  created_external_id TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_promotions_signal ON promotions(signal_id);

-- 5) agent_runs — Codex/Hermes/Claude 잡. bounds(timeout/turns/cost)는 강제 (INVARIANT).
CREATE TABLE agent_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  engine       TEXT NOT NULL CHECK (engine IN ('codex','hermes','claude')),
  kind         TEXT NOT NULL,
  rail         TEXT NOT NULL CHECK (rail IN ('suggestion','execution')),
  trigger      TEXT,                          -- JSON: { signalId, promotionId, prUrl }
  repo_id      TEXT REFERENCES repos(id) ON DELETE SET NULL,
  workdir      TEXT,                          -- 코드 잡 worktree
  sandbox      TEXT NOT NULL CHECK (sandbox IN ('read_only','workspace_write')), -- danger_full 금지
  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
                 ('proposed','awaiting_approval','running','succeeded','failed','cancelled')),
  timeout_sec  INTEGER NOT NULL,
  max_turns    INTEGER NOT NULL,
  cost_cap_usd REAL NOT NULL,
  retry_key    TEXT,                          -- 재트리거 체인 캡
  retry_count  INTEGER NOT NULL DEFAULT 0,
  proposal     TEXT,                          -- JSON (suggestion 산출물)
  result       TEXT,                          -- JSON: { diffPath, prUrl, externalId }
  cost_tokens  INTEGER,
  cost_usd     REAL,
  log_path     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX idx_agent_runs_project ON agent_runs(project_id);
CREATE INDEX idx_agent_runs_status  ON agent_runs(status);

-- 6) acceptances — 외부 변경의 유일한 관문, append-only (INVARIANT: Acceptance 게이트).
CREATE TABLE acceptances (
  id              TEXT PRIMARY KEY,
  agent_run_id    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  accepted_fields TEXT NOT NULL,              -- JSON
  target          TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_acceptances_run ON acceptances(agent_run_id);

-- FTS5 전역 검색 (signals 본문/제목). external-content 테이블 + sync 트리거.
CREATE VIRTUAL TABLE signals_fts USING fts5(
  title,
  body,
  content='signals',
  content_rowid='rowid'
);

CREATE TRIGGER signals_fts_ai AFTER INSERT ON signals BEGIN
  INSERT INTO signals_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER signals_fts_ad AFTER DELETE ON signals BEGIN
  INSERT INTO signals_fts(signals_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER signals_fts_au AFTER UPDATE ON signals BEGIN
  INSERT INTO signals_fts(signals_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO signals_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
