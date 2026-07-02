-- Work Radar — MoneyManager(.mmbak) 자동 임포트 옵션 (단일 row, id=1).
-- news_options(0020) 패턴: id=1 CHECK + 멱등 seed. 추가 전용 — 기존 테이블 무변경.
--
--   watch_dir            : .mmbak 백업이 쌓이는 감시 폴더(Google Drive 동기화 폴더 등). NULL=미설정.
--   project_id           : 자동 임포트가 귀속될 프로젝트(선택). 프로젝트 삭제 시 NULL로.
--   auto_import_enabled  : 0/1. 1이면 스케줄러 tick이 24h 게이트로 최신 백업을 자동 임포트.
--   last_auto_import_at  : 마지막 자동 임포트 시각('YYYY-MM-DD HH:MM:SS' UTC).
--                          실패해도 찍는다 — 다음 시도는 24h 뒤(bounded retry, storm 방지).

CREATE TABLE bookkeeping_mmbak_options (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    watch_dir TEXT,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    auto_import_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auto_import_enabled IN (0, 1)),
    last_auto_import_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

INSERT INTO bookkeeping_mmbak_options(id) VALUES (1) ON CONFLICT DO NOTHING;
