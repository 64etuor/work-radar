//! signals / signals_fts 테이블 데이터 접근 레이어(백로그 F). 모든 signals SQL의 단일 소유자.
//! Approach A: 커맨드에서 verbatim 이전 — 동작 무변경. 백로그 G(테이블 분리)는 이 모듈만 바꾼다.

use crate::db::Db;
use crate::models::{CreateSignalInput, Quadrant, SignalStatus, WorkSignal};

/// signals 행 → WorkSignal 매핑 컬럼 목록(기존 shared.rs에서 이전).
/// FromRow는 이름으로 매핑 → 순서 무관.
pub(crate) const SIGNAL_COLS: &str =
    "id, project_id, title, body, source, type, quadrant, suggested_quadrant, \
     kind, area, suggested_area, status, snooze_until, today_for_date, today_done_at, today_rank, \
     impact_high, regret, created_at, updated_at";

/// braindump 입력 정규화 (dedup 키 기준). 소문자 + 공백 정리.
fn normalize(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

// ── 코어 CRUD / dedup ─────────────────────────────────────────────────────────

/// 한 줄 braindump → 미분류 카드 생성.
/// INVARIANT #1: 항상 `unclassified`로 진입한다 (자동 분류 없음).
/// INVARIANT #3: 같은 입력은 dedup 키로 합쳐진다 (append 아님, upsert).
pub(crate) async fn insert_signal(
    db: &Db,
    input: &CreateSignalInput,
) -> Result<WorkSignal, sqlx::Error> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(sqlx::Error::Protocol("empty signal title".into()));
    }
    let dedup_key = format!("braindump:{}", normalize(title));

    // dedup: 동일 입력이 이미 있으면 touch 후 반환 (합쳐짐). 미태깅이면 project_id 보강.
    let existing = sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET updated_at = datetime('now'), project_id = COALESCE(project_id, ?2) \
         WHERE dedup_key = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&dedup_key)
    .bind(&input.project_id)
    .fetch_optional(db)
    .await?;
    if let Some(sig) = existing {
        return Ok(sig);
    }

    sqlx::query_as::<_, WorkSignal>(&format!(
        "INSERT INTO signals (id, project_id, title, source, type, quadrant, kind, dedup_key, status) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, 'braindump', 'thought', 'unclassified', ?3, ?4, 'new') \
         RETURNING {SIGNAL_COLS}"
    ))
    .bind(&input.project_id)
    .bind(title)
    .bind(input.kind)
    .bind(&dedup_key)
    .fetch_one(db)
    .await
}

/// 매트릭스 + 미분류 카드 (Today로 승격되지 않은 active 신호).
pub(crate) async fn fetch_signals(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_for_date IS NULL AND status NOT IN ('done','archived','snoozed') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await
}

/// 사분면 분류 (사람 결정 레일 — INVARIANT #1). quadrant를 바꾸는 유일한 경로.
pub(crate) async fn set_quadrant(
    db: &Db,
    id: &str,
    quadrant: Quadrant,
) -> Result<WorkSignal, sqlx::Error> {
    let status = if matches!(quadrant, Quadrant::Unclassified) {
        SignalStatus::New
    } else {
        SignalStatus::Classified
    };
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET quadrant = ?2, status = ?3, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(quadrant)
    .bind(status)
    .fetch_one(db)
    .await
}

/// 상태 변경 (완료/보관 등) 코어. done/archive 카드 메뉴.
pub(crate) async fn set_signal_status(
    db: &Db,
    id: &str,
    status: SignalStatus,
) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET status = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(status)
    .fetch_one(db)
    .await
}

/// 미루기 (snooze) 코어. 매트릭스에서 숨고 snooze_until에 복귀 시점 기록.
pub(crate) async fn snooze_signal(
    db: &Db,
    id: &str,
    until: &str,
) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET status = 'snoozed', snooze_until = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(until)
    .fetch_one(db)
    .await
}

/// 신호 제목 편집 코어(테스트 가능). 새 제목으로 title + dedup_key(braindump:normalize) 갱신.
/// 빈 제목은 거부. quadrant/status는 건드리지 않는다(결정 레일 무침범).
pub(crate) async fn update_title(
    db: &Db,
    id: &str,
    title: &str,
) -> Result<WorkSignal, sqlx::Error> {
    let title = title.trim();
    if title.is_empty() {
        return Err(sqlx::Error::Protocol("empty signal title".into()));
    }
    let dedup_key = format!("braindump:{}", normalize(title));
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET title = ?2, dedup_key = ?3, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(title)
    .bind(&dedup_key)
    .fetch_one(db)
    .await
}

/// 신호 하드 삭제(영구) 코어. 카드 행 자체를 DELETE한다. 영향받은 행 수 반환.
pub(crate) async fn delete_signal_row(db: &Db, id: &str) -> Result<u64, sqlx::Error> {
    let res = sqlx::query("DELETE FROM signals WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected())
}

/// 승격 draft payload용 제목 스냅샷 조회 (insert_promotion_draft 내부 SELECT).
pub(crate) async fn fetch_signal_title(db: &Db, signal_id: &str) -> Result<String, sqlx::Error> {
    let title: (String,) = sqlx::query_as("SELECT title FROM signals WHERE id = ?1")
        .bind(signal_id)
        .fetch_one(db)
        .await?;
    Ok(title.0)
}

// ── Today 레일 ─────────────────────────────────────────────────────────────────

/// 매트릭스 카드를 Today로 승격. 새 항목은 레일 맨 위(가장 작은 rank). (rail.rs 본문 이전)
pub(crate) async fn promote_today(
    db: &Db,
    id: &str,
    date: &str,
) -> Result<WorkSignal, sqlx::Error> {
    // 새 항목은 레일 맨 위에 (가장 작은 rank).
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_for_date = ?2, today_done_at = NULL, status = 'promoted', \
            today_rank = COALESCE((SELECT MIN(today_rank) FROM signals WHERE today_for_date IS NOT NULL), 0) - 1, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(date)
    .fetch_one(db)
    .await
}

/// Today 승격 취소 → 원 사분면으로 복귀(없으면 미분류). 카운터 리셋. (rail.rs 본문 이전)
pub(crate) async fn unpromote_today(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_for_date = NULL, today_done_at = NULL, today_rank = NULL, \
            status = CASE WHEN quadrant = 'unclassified' THEN 'new' ELSE 'classified' END, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .fetch_one(db)
    .await
}

/// Today 항목 완료 토글. 완료(done)=해당 날짜 기록 → 다음날 이월 안 됨. (rail.rs 본문 이전)
pub(crate) async fn toggle_today_done(
    db: &Db,
    id: &str,
    date: &str,
    done: bool,
) -> Result<WorkSignal, sqlx::Error> {
    let done_at: Option<&str> = if done { Some(date) } else { None };
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_done_at = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(done_at)
    .fetch_one(db)
    .await
}

/// Today 레일 재정렬. ordered_ids 순서대로 today_rank 부여. (rail.rs 트랜잭션 이전)
pub(crate) async fn reorder_today(db: &Db, ordered_ids: &[String]) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE signals SET today_rank = ?2 WHERE id = ?1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

/// 오늘의 Today 항목. 미완료는 매일 잔류(rollover), 완료(today_done_at=오늘)는 당일만 표시. (rail.rs 본문 이전)
pub(crate) async fn fetch_today(db: &Db, today: &str) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_for_date IS NOT NULL AND status NOT IN ('done','archived') \
           AND (today_done_at IS NULL OR today_done_at = ?1) \
         ORDER BY today_rank, today_for_date"
    ))
    .bind(today)
    .fetch_all(db)
    .await
}

// ── FTS 검색 ──────────────────────────────────────────────────────────────────

/// 본문/제목 전역 검색 (FTS5). 호출자는 빈 쿼리를 걸러 넘긴다.
/// 사용자 입력을 phrase로 감싸 FTS 연산자 오인을 막는다.
pub(crate) async fn search_signals(db: &Db, query: &str) -> Result<Vec<WorkSignal>, sqlx::Error> {
    let match_expr = format!("\"{}\"", query.replace('"', "\"\""));
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {} FROM signals s \
         JOIN signals_fts f ON f.rowid = s.rowid \
         WHERE signals_fts MATCH ?1 ORDER BY rank",
        SIGNAL_COLS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
    .bind(match_expr)
    .fetch_all(db)
    .await
}
