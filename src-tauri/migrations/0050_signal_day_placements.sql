-- signal_day_placements — 시그널의 날짜별 타임라인 배치 (1일 1블록).
--
-- 배경: signals.scheduled_at/scheduled_duration은 카드당 단일 값이라 (a) 어제 배치한
-- 미완료 카드를 오늘 다시 배치할 수 없고(블록은 그 날짜에 스코프, 트레이는 NULL만 표시),
-- (b) 재배치가 이전 기록을 덮어써 누적 시간 집계가 불가능했다.
-- routine_checks(routine_id, date) 패턴을 시그널에 적용한다.
--
-- SSOT: 렌더링·집계는 이 테이블. signals.scheduled_at/linked_*는 "최신 배치 + Google
-- 미러 커서"로 유지(워커/absorb 의존). 스펙: docs/superpowers/specs/2026-06-12-signal-day-placements-design.md
CREATE TABLE signal_day_placements (
  id           TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,             -- YYYY-MM-DD (로컬, start_at 앞 10글자와 일치)
  start_at     TEXT NOT NULL,             -- 로컬 ISO "YYYY-MM-DDTHH:MM:SS" (scheduled_at과 동일 포맷)
  duration_min INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(signal_id, date)
);

CREATE INDEX idx_signal_day_placements_date ON signal_day_placements(date);

-- 백필: 기존 단일 배치를 그 날짜의 placement 행으로 승계.
-- scheduled_at은 로컬 ISO — 날짜는 항상 앞 10글자(substr 1-based).
INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min)
SELECT lower(hex(randomblob(16))), id, substr(scheduled_at, 1, 10), scheduled_at, scheduled_duration
  FROM signals
 WHERE scheduled_at IS NOT NULL AND scheduled_duration IS NOT NULL;
