//! signals / signals_fts 테이블 데이터 접근 레이어(백로그 F). 모든 signals SQL의 단일 소유자.
//! Approach A: 커맨드에서 verbatim 이전 — 동작 무변경. 백로그 G(테이블 분리)는 이 모듈만 바꾼다.

/// signals 행 → WorkSignal 매핑 컬럼 목록(기존 shared.rs에서 이전).
/// FromRow는 이름으로 매핑 → 순서 무관.
pub(crate) const SIGNAL_COLS: &str =
    "id, project_id, title, body, source, type, quadrant, suggested_quadrant, \
     kind, area, suggested_area, status, snooze_until, today_for_date, today_done_at, today_rank, \
     impact_high, regret, created_at, updated_at";
