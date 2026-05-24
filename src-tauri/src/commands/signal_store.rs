//! signals / signals_fts 테이블 데이터 접근 레이어(백로그 F). 모든 signals SQL의 단일 소유자.
//! Approach A: 커맨드에서 verbatim 이전 — 동작 무변경. 백로그 G(테이블 분리)는 이 모듈만 바꾼다.

use crate::db::Db;
use crate::models::{AreaTag, CreateSignalInput, Quadrant, SignalStatus, WorkSignal};

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

// ── 집계 (signals-primary count/select; 비-signals 조인은 커맨드 잔류) ──────────

/// 미분류 active 카운트 (today 레일 밖). (overview.rs 이전)
pub(crate) async fn count_unclassified_active(db: &Db) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE quadrant = 'unclassified' AND today_for_date IS NULL \
           AND status NOT IN ('done','archived','snoozed')",
    )
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// Q1 overdue 카운트. created_at(UTC)을 date(...,'localtime')으로 맞춰 로컬 캘린더 일수 비교.
/// ⚠️ 'localtime'은 제거 금지(load-bearing) — 회귀 테스트 q1_overdue_uses_local_calendar_not_utc.
/// `days`는 호출자가 임계치(Q1_OVERDUE_DAYS)를 전달. (overview.rs 이전)
pub(crate) async fn count_q1_overdue(db: &Db, date: &str, days: i64) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE quadrant = 'q1_do_now' AND status NOT IN ('done','archived','snoozed') \
           AND julianday(?1) - julianday(date(created_at, 'localtime')) >= ?2",
    )
    .bind(date)
    .bind(days)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// stale backlog 카운트(quadrant 무관, 나이 렌즈). `days`=STALE_BACKLOG_DAYS. (overview.rs 이전)
pub(crate) async fn count_stale_backlog(
    db: &Db,
    date: &str,
    days: i64,
) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE today_for_date IS NULL AND status NOT IN ('done','archived','snoozed') \
           AND julianday(?1) - julianday(date(created_at, 'localtime')) >= ?2",
    )
    .bind(date)
    .bind(days)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// cleanup 부채 카운트(type=cleanup active, today 레일 무관 — 의도적). (overview.rs 이전)
pub(crate) async fn count_cleanup_needed(db: &Db) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE type = 'cleanup' AND status NOT IN ('done','archived','snoozed')",
    )
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// Q1 콕핏 리스트: q1 분류됐고 아직 today 레일 밖(끌어올릴 대상). (overview.rs 이전)
pub(crate) async fn fetch_q1_items(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE quadrant = 'q1_do_now' AND today_for_date IS NULL \
           AND status NOT IN ('done','archived','snoozed') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await
}

/// PR attention 리스트(매트릭스로 escalate된 PR 신호). (overview.rs 이전)
pub(crate) async fn fetch_pr_attention(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE source = 'github_pr' AND type = 'pr_attention' \
           AND status NOT IN ('done','archived','snoozed') \
         ORDER BY updated_at DESC"
    ))
    .fetch_all(db)
    .await
}

/// weekly: braindump 캡처 수(범위 내, created_at localtime). (weekly.rs 이전)
pub(crate) async fn count_captured_in_range(
    db: &Db,
    start: &str,
    end: &str,
) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE source = 'braindump' AND date(created_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(start)
    .bind(end)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// weekly: 완료 수(today_done_at 범위 내, 이미 로컬). (weekly.rs 이전)
pub(crate) async fn count_completed_in_range(
    db: &Db,
    start: &str,
    end: &str,
) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM signals WHERE today_done_at BETWEEN ?1 AND ?2")
            .bind(start)
            .bind(end)
            .fetch_one(db)
            .await?;
    Ok(n)
}

/// weekly: 범위 내 새 PR attention 신호 수. (weekly.rs 이전)
pub(crate) async fn count_pr_new_in_range(
    db: &Db,
    start: &str,
    end: &str,
) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE source = 'github_pr' AND type = 'pr_attention' \
           AND date(created_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(start)
    .bind(end)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// weekly: 범위 내 done 전이 PR 수(updated_at localtime 근사). (weekly.rs 이전)
pub(crate) async fn count_pr_resolved_in_range(
    db: &Db,
    start: &str,
    end: &str,
) -> Result<i64, sqlx::Error> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE source = 'github_pr' AND status = 'done' \
           AND date(updated_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(start)
    .bind(end)
    .fetch_one(db)
    .await?;
    Ok(n)
}

// ── PR Radar (auto-resolve; 루프/제어는 커맨드 잔류 — INVARIANT #3) ──
//
// PR B(표시 전용 전환)로 escalate upsert는 제거됐다. 아래 두 fn은 *기존* escalated PR 신호를
// auto-resolve(정리)하는 데만 쓰인다.

/// auto-resolve용 active github_pr 신호 (id, dedup_key) 목록. 루프 판단은 커맨드. (pr_radar.rs 이전)
pub(crate) async fn fetch_pr_signal_keys(
    db: &Db,
    project_id: &str,
) -> Result<Vec<(String, Option<String>)>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, dedup_key FROM signals \
         WHERE source = 'github_pr' AND project_id = ?1 AND status NOT IN ('done','archived')",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
}

/// 신호를 done으로 전이(auto-resolve 매트릭스 소멸). (pr_radar.rs 이전)
pub(crate) async fn mark_signal_done(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE signals SET status = 'done', updated_at = datetime('now') WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

// ── Notion 승격 (links/project 연결; 외부 응답 파싱은 커맨드 잔류) ───────────────

/// 승격된 신호의 links JSON 조회. 병합 로직은 커맨드 잔류. (notion.rs 이전)
pub(crate) async fn fetch_signal_links(
    db: &Db,
    signal_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let row: (Option<String>,) = sqlx::query_as("SELECT links FROM signals WHERE id = ?1")
        .bind(signal_id)
        .fetch_one(db)
        .await?;
    Ok(row.0)
}

/// 승격 완료 시 links 갱신 + status='linked'. (notion.rs 이전)
pub(crate) async fn set_signal_links_linked(
    db: &Db,
    signal_id: &str,
    links: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE signals SET links = ?2, status = 'linked', updated_at = datetime('now') \
         WHERE id = ?1",
    )
    .bind(signal_id)
    .bind(links)
    .execute(db)
    .await?;
    Ok(())
}

/// 신호의 project_id + kind 조회(프로젝트 해석용). (notion.rs 이전)
pub(crate) async fn fetch_signal_project_kind(
    db: &Db,
    signal_id: &str,
) -> Result<Option<(Option<String>, Option<String>)>, sqlx::Error> {
    sqlx::query_as("SELECT project_id, kind FROM signals WHERE id = ?1")
        .bind(signal_id)
        .fetch_optional(db)
        .await
}

/// 신호에 project_id persist(사람 선택/자동 해석 결과 메타데이터 태깅 — INVARIANT #1). (notion.rs 이전)
pub(crate) async fn set_signal_project(
    db: &Db,
    signal_id: &str,
    project_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE signals SET project_id = ?2, updated_at = datetime('now') WHERE id = ?1")
        .bind(signal_id)
        .bind(project_id)
        .execute(db)
        .await?;
    Ok(())
}

// ── 프로젝트 태깅 / reconcile (signals-write; projects는 서브쿼리 참조) ──────────

/// 미태깅 & kind 보유 신호를 같은 kind의 가장 오래된 프로젝트로 태깅(메타데이터 — INVARIANT #1).
/// UPDATE 대상이 signals라 store; projects는 서브쿼리 참조. (projects.rs 이전)
pub(crate) async fn reconcile_signal_projects(db: &Db) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE signals SET \
            project_id = (SELECT p.id FROM projects p WHERE p.kind = signals.kind ORDER BY p.created_at LIMIT 1), \
            updated_at = datetime('now') \
         WHERE project_id IS NULL AND kind IS NOT NULL \
           AND EXISTS (SELECT 1 FROM projects p WHERE p.kind = signals.kind)",
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// 신호의 소속 프로젝트를 명시 지정(또는 None 해제). 메타데이터(RETURNING). (projects.rs 이전)
pub(crate) async fn set_signal_project_tag(
    db: &Db,
    id: &str,
    project_id: Option<&str>,
) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET project_id = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(project_id)
    .fetch_one(db)
    .await
}

// ── agents enrich / triage (suggested_* 힌트 — INVARIANT #1: codex 자동 확정 없음) ──
//
// ⚠️ codex가 내는 제안은 suggested_quadrant/suggested_area로만 쓴다(set_enrich_hints 등). 확정 `quadrant`
//    컬럼은 codex/자동화가 절대 건드리지 않는다. 확정은 사람 제스처에서만 — 드래그/키보드(classify_signal=
//    set_quadrant), area(set_signal_area), 그리고 enrich 검토 후 사람의 "적용" 클릭(confirm_enrich_batch_one).

/// enrich 카드 텍스트(title/body/project_id) 조회. (enrich.rs trigger 이전)
pub(crate) async fn fetch_card_text(
    db: &Db,
    signal_id: &str,
) -> Result<Option<(String, Option<String>, Option<String>)>, sqlx::Error> {
    sqlx::query_as("SELECT title, body, project_id FROM signals WHERE id = ?1")
        .bind(signal_id)
        .fetch_optional(db)
        .await
}

/// enrich accept: suggested_* 힌트만 반영(확정 quadrant/area 무변경 — INVARIANT #1). (enrich.rs 이전)
pub(crate) async fn set_enrich_hints(
    db: &Db,
    signal_id: &str,
    suggested_quadrant: Option<Quadrant>,
    suggested_area: Option<AreaTag>,
    reason: Option<&str>,
) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET suggested_quadrant = ?2, suggested_area = ?3, suggestion_reason = ?4, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(signal_id)
    .bind(suggested_quadrant)
    .bind(suggested_area)
    .bind(reason)
    .fetch_one(db)
    .await
}

/// 배치 enrich **사람 확정**(적용 클릭): 미분류 카드에 quadrant+area를 한 번에 확정하고 suggested_* 힌트를
/// 비운다. quadrant != unclassified면 status=Classified, 아니면 New. `WHERE quadrant='unclassified'`로
/// **이미 분류된 카드는 덮지 않는다**(사람이 이미 내린 결정 보존). 자동 분류가 아니라 드래그/키보드 분류와
/// 동일한 사람 결정 레일 — 호출은 사람의 명시적 "적용"에서만(INVARIANT #1). 영향 행수 반환.
pub(crate) async fn confirm_enrich_batch_one(
    db: &Db,
    id: &str,
    quadrant: Quadrant,
    area: Option<AreaTag>,
) -> Result<u64, sqlx::Error> {
    let status = if matches!(quadrant, Quadrant::Unclassified) {
        SignalStatus::New
    } else {
        SignalStatus::Classified
    };
    let res = sqlx::query(
        "UPDATE signals SET quadrant = ?2, status = ?3, area = ?4, \
            suggested_quadrant = NULL, suggested_area = NULL, suggestion_reason = NULL, \
            updated_at = datetime('now') \
         WHERE id = ?1 AND quadrant = 'unclassified'",
    )
    .bind(id)
    .bind(quadrant)
    .bind(status)
    .bind(area)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

/// 캘린더 긴급도 가중: **suggested_quadrant 힌트만** 갱신(area/reason은 보존). unclassified 카드에만
/// 적용한다(WHERE quadrant='unclassified' — 확정 위치는 절대 미접근, INVARIANT #1). 갱신된 신호를
/// 돌려준다(확정 quadrant는 그대로 unclassified). 미존재/이미 분류된 카드면 Err(RowNotFound).
pub(crate) async fn set_suggested_quadrant_only(
    db: &Db,
    id: &str,
    suggested_quadrant: Option<Quadrant>,
) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET suggested_quadrant = ?2, updated_at = datetime('now') \
         WHERE id = ?1 AND quadrant = 'unclassified' RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(suggested_quadrant)
    .fetch_one(db)
    .await
}

/// area(라이프 도메인) 확정/수정(사람 결정 — quadrant 결정 레일과 무관 축). (enrich.rs 이전)
pub(crate) async fn set_signal_area(
    db: &Db,
    id: &str,
    area: Option<AreaTag>,
) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET area = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(area)
    .fetch_one(db)
    .await
}

/// 배치 enrich 대상: 미분류 active 신호 (id, title). project_id로 한정(또는 전체). (enrich.rs 이전)
pub(crate) async fn fetch_unclassified_for_enrich(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<(String, String)>, sqlx::Error> {
    if let Some(pid) = project_id {
        sqlx::query_as(
            "SELECT id, title FROM signals \
             WHERE quadrant = 'unclassified' AND today_for_date IS NULL \
               AND status NOT IN ('done','archived','snoozed') AND project_id = ?1 \
             ORDER BY created_at",
        )
        .bind(pid)
        .fetch_all(db)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, title FROM signals \
             WHERE quadrant = 'unclassified' AND today_for_date IS NULL \
               AND status NOT IN ('done','archived','snoozed') \
             ORDER BY created_at",
        )
        .fetch_all(db)
        .await
    }
}

/// triage 재트리거 캡 초과 → 매트릭스 Q1 escalate dedup upsert. 항상 unclassified 진입 + suggested q1
/// 힌트만(INVARIANT #1). title/body/links 조립은 커맨드 잔류. (triage.rs 이전)
pub(crate) async fn insert_triage_q1_escalation(
    db: &Db,
    project_id: Option<&str>,
    title: &str,
    body: &str,
    dedup_key: &str,
    links: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO signals \
            (id, project_id, title, body, source, type, quadrant, suggested_quadrant, dedup_key, status, links) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'system', 'agent_alert', \
                 'unclassified', 'q1_do_now', ?4, 'new', ?5) \
         ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET \
            title = excluded.title, body = excluded.body, links = excluded.links, \
            suggested_quadrant = excluded.suggested_quadrant, updated_at = datetime('now')",
    )
    .bind(project_id)
    .bind(title)
    .bind(body)
    .bind(dedup_key)
    .bind(links)
    .execute(db)
    .await?;
    Ok(())
}

// ── 회고 (완료 타임라인 / impact·regret 태깅 / 보관·복원) ───────────────────────

/// [start,end] 범위(로컬 날짜 inclusive) 완료 Today 항목. today_done_at은 이미 로컬 날짜라 변환 불요.
/// (retro.rs 이전)
pub(crate) async fn fetch_completed(
    db: &Db,
    start: &str,
    end: &str,
) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_done_at IS NOT NULL AND today_done_at BETWEEN ?1 AND ?2 \
         ORDER BY today_done_at DESC, updated_at DESC"
    ))
    .bind(start)
    .bind(end)
    .fetch_all(db)
    .await
}

/// 고임팩트 태그 토글(사람 결정 — INVARIANT #1). quadrant/status 무변경. (retro.rs 이전)
pub(crate) async fn set_impact(db: &Db, id: &str, value: bool) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET impact_high = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(value)
    .fetch_one(db)
    .await
}

/// 후회 태그 토글(사람 결정 — INVARIANT #1). (retro.rs 이전)
pub(crate) async fn set_regret(db: &Db, id: &str, value: bool) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET regret = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(value)
    .fetch_one(db)
    .await
}

/// 보관/미루기된 신호 열람(archived + snoozed, updated_at 내림차순). (retro.rs 이전)
pub(crate) async fn fetch_archived_snoozed(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE status IN ('archived','snoozed') \
         ORDER BY updated_at DESC"
    ))
    .fetch_all(db)
    .await
}

/// 신호 복원(사람 결정 — INVARIANT #1). quadrant 보존(자동 분류 0), snooze_until 비움. (retro.rs 이전)
pub(crate) async fn restore(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET \
            status = CASE WHEN quadrant = 'unclassified' THEN 'new' ELSE 'classified' END, \
            snooze_until = NULL, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .fetch_one(db)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::{fresh_db, input};
    use crate::models::Kind;

    /// 코어: insert_signal → fetch_signals 라운드트립(매트릭스 active 집합에 들어온다).
    #[tokio::test]
    async fn insert_then_fetch_roundtrips() {
        let db = fresh_db().await;
        let s = insert_signal(&db, &input("파이프라인 점검", Some(Kind::Work)))
            .await
            .unwrap();
        let all = fetch_signals(&db).await.unwrap();
        assert!(all.iter().any(|x| x.id == s.id));
        assert!(matches!(s.quadrant, Quadrant::Unclassified)); // 항상 미분류 진입(INVARIANT #1).
    }

    /// 결정 레일: set_quadrant만 quadrant를 바꾼다(사람 결정).
    #[tokio::test]
    async fn set_quadrant_changes_quadrant_and_status() {
        let db = fresh_db().await;
        let s = insert_signal(&db, &input("긴급 처리", Some(Kind::Work)))
            .await
            .unwrap();
        let c = set_quadrant(&db, &s.id, Quadrant::Q1DoNow).await.unwrap();
        assert!(matches!(c.quadrant, Quadrant::Q1DoNow));
        assert!(matches!(c.status, SignalStatus::Classified));
    }

    /// Today 레일: promote_today가 멤버십을 만들고 fetch_today가 그날 항목을 돌려준다.
    #[tokio::test]
    async fn promote_sets_today_membership_and_fetch_today_returns_it() {
        let db = fresh_db().await;
        let s = insert_signal(&db, &input("데모 준비", Some(Kind::Work)))
            .await
            .unwrap();
        promote_today(&db, &s.id, "2026-05-23").await.unwrap();
        let today = fetch_today(&db, "2026-05-23").await.unwrap();
        assert!(today.iter().any(|x| x.id == s.id));
        // 승격된 카드는 매트릭스(active, today 레일 밖) 집합에서 빠진다.
        let matrix = fetch_signals(&db).await.unwrap();
        assert!(!matrix.iter().any(|x| x.id == s.id));
    }

    /// FTS: search_signals가 제목 토큰을 매칭한다(호출자가 빈 쿼리를 걸러 넘긴다는 전제).
    #[tokio::test]
    async fn search_signals_matches_title_via_fts() {
        let db = fresh_db().await;
        insert_signal(&db, &input("파이프라인 점검", Some(Kind::Work)))
            .await
            .unwrap();
        let hits = search_signals(&db, "파이프라인").await.unwrap();
        assert_eq!(hits.len(), 1);
    }

    /// 회고: set_impact/set_regret 태깅이 라운드트립되고 confirmed quadrant는 무변경.
    #[tokio::test]
    async fn impact_regret_tagging_roundtrips_without_touching_quadrant() {
        let db = fresh_db().await;
        let s = insert_signal(&db, &input("회고 대상", None)).await.unwrap();
        let i = set_impact(&db, &s.id, true).await.unwrap();
        assert_eq!(i.impact_high, Some(true));
        let r = set_regret(&db, &s.id, true).await.unwrap();
        assert_eq!(r.regret, Some(true));
        assert!(matches!(r.quadrant, Quadrant::Unclassified)); // 태깅은 결정 레일 무침범.
    }
}
