-- Work Radar — schema v9 (Phase 13: 백그라운드 스케줄러 알림 큐)
-- 스키마 변경은 새 마이그레이션 파일로만 (임의 ALTER 금지 — INVARIANT).
--
-- 왜 필요한가:
--   트레이 상주 + 백그라운드 스케줄러 스파인의 SSOT. 스케줄러가 bounded interval로 틱하며
--   `fire_at <= now AND fired_at IS NULL` 행을 골라 네이티브 알림을 발사하고 fired_at을 찍는다.
--   상태가 SQLite에 있으므로 (1) 재부팅 후에도 다음 발사가 복구되고 (2) 한 번 발사한 행은
--   다시 발사되지 않는다(멱등).
--
-- 제네릭 source/source_id: Phase 16(routines)·Phase 20(CI)이 행을 INSERT하기만 하면
--   스파인이 발사한다(스케줄러 코드 무변경). source = 발신 도메인 태그(예: 'routine','ci','test').
--
-- INVARIANT #5: 스케줄러는 fixed interval tick — busy-loop/무한 retry 없음(코드에서 강제).
-- INVARIANT #7: 예약 알림 상태는 로컬 SQLite SSOT. 토큰/외부 무관.

PRAGMA foreign_keys = ON;

CREATE TABLE scheduled_notifications (
  id         TEXT PRIMARY KEY,            -- lower(hex(randomblob(16)))
  fire_at    TEXT NOT NULL,               -- 발사 예정 시각 (datetime('now') 호환 UTC 'YYYY-MM-DD HH:MM:SS')
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL,               -- 발신 도메인 ('routine'|'ci'|'test'…)
  source_id  TEXT,                        -- 발신 도메인 내 식별자 (dedup/포커스용, nullable)
  fired_at   TEXT,                        -- 발사 완료 시각 (NULL = 미발사). 한 번 찍히면 재발사 안 함.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- due-query 핫패스(매 틱): 미발사 + fire_at 정렬 스캔.
CREATE INDEX idx_scheduled_notifications_due
  ON scheduled_notifications (fired_at, fire_at);
