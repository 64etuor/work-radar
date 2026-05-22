-- Work Radar — schema v12 (Phase 20 #15: Hermes 메신저 브리지)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 왜 필요한가:
--   외부 Hermes 에이전트를 Telegram Bot API류 메신저 브리지로 제어한다. 봇 토큰은 keychain에만
--   저장되고(여기 DB는 평문 토큰을 절대 담지 않는다 — INVARIANT), 비밀 아닌 상태(chat_id·
--   getUpdates offset)만 로컬 SQLite SSOT로 둔다. 앱 레벨 단일 브리지(Hermes = 외부 에이전트 하나)라
--   `hermes_bridge`는 id='singleton' 한 행만 쓴다.
--
--   `hermes_messages`는 제어 surface(채팅형 뷰)가 보여줄 송·수신 로그다. 수신은 INVARIANT #5에 따라
--   bounded(단발 getUpdates) — 무한 long-poll 없음. update_id는 dedup/offset 전진의 기준이다.
--
-- INVARIANT: 봇 토큰은 keychain만(평문/렌더러/DB 금지). #5: 수신은 단발 bounded(스케줄/사용자가 cadence
--   결정). #7: chat_id·offset·메시지 로그는 로컬 SQLite SSOT(내용 자체는 Telegram이 SSOT).

PRAGMA foreign_keys = ON;

-- 앱 레벨 단일 브리지 설정(비밀 아님 — 토큰은 keychain). id='singleton' 한 행만.
CREATE TABLE hermes_bridge (
  id          TEXT PRIMARY KEY DEFAULT 'singleton',   -- 단일 브리지(외부 Hermes 하나) — 항상 'singleton'.
  chat_id     TEXT NOT NULL,                          -- Telegram chat_id (메시지 라우팅 대상, 비밀 아님).
  last_offset INTEGER NOT NULL DEFAULT 0,             -- 마지막으로 소비한 getUpdates update_id. 다음 호출은 +1부터.
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 송·수신 메시지 로그(제어 surface 표시용). 토큰 미포함.
CREATE TABLE hermes_messages (
  id         TEXT PRIMARY KEY,                         -- lower(hex(randomblob(16)))
  direction  TEXT NOT NULL CHECK (direction IN ('sent','received')),
  text       TEXT NOT NULL DEFAULT '',
  update_id  INTEGER,                                  -- 수신 메시지의 Telegram update_id(송신은 NULL). dedup 기준.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 같은 update를 두 번 기록하지 않도록(중복 fetch 멱등). 송신(update_id NULL)은 UNIQUE 제약에서 자유.
CREATE UNIQUE INDEX idx_hermes_messages_update ON hermes_messages (update_id)
  WHERE update_id IS NOT NULL;

-- 제어 surface 핫패스: 최신 메시지 정렬 스캔.
CREATE INDEX idx_hermes_messages_created ON hermes_messages (created_at);
