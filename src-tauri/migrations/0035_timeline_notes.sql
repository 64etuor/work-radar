-- 0035 timeline_notes — Today 타임라인 카드(signal/routine/event)에 사용자 메모 1개 저장.
-- PK = (target_kind, target_id, date) — 같은 대상이라도 날짜별 메모 분리(루틴/이벤트 일별 인스턴스 지원,
-- signal은 scheduledAt 날짜로 자연 분리). target_kind는 닫힌 enum(=TimelineNoteTarget) — CHECK로 DB 가드.
-- target_id 인코딩:
--   signal:  signals.id
--   routine: routines.id
--   event:   '{calendar_id}:{event_id}' — 캘린더 mirror event 식별자(스코프 정본은 합성키).

CREATE TABLE IF NOT EXISTS timeline_notes (
    target_kind TEXT NOT NULL CHECK (target_kind IN ('signal', 'routine', 'event')),
    target_id   TEXT NOT NULL,
    date        TEXT NOT NULL, -- 'YYYY-MM-DD' (로컬, 프런트 주입 — UTC 경계 어긋남 방지)
    body        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (target_kind, target_id, date)
);

-- date 단위 조회(Today 뷰가 하루치 전체 메모 일괄 로드용) 보조 인덱스.
CREATE INDEX IF NOT EXISTS idx_timeline_notes_date ON timeline_notes(date);
