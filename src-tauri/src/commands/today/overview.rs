use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{TodayOverview, WorkDebt, WorkSignal};

use crate::commands::shared::SIGNAL_COLS;

// ── Today 운영 뷰 + Work Debt (Phase 11a, read 집계) ───────────────────────────
// 전부 로컬 SQLite read — 네트워크 없음(캘린더는 프런트가 fetchCalendarEvents로 합성).
// INVARIANT #1: 집계만 — 자동 분류/승격 없음. INVARIANT #7: 로컬 상태 SSOT(부채 스냅샷).

/// Q1 overdue 임계치(일): q1_do_now가 생성 후 이 일수 이상 지나면 overdue(당일 처리 못 함).
const Q1_OVERDUE_DAYS: i64 = 1;
/// stale backlog 임계치(일): active 신호가 생성 후 이 일수 이상 멈춰 있으면 stale.
/// PR Radar의 `STALE_DAYS`(PR 나이)와 다른 축이라 이름을 분리한다.
const STALE_BACKLOG_DAYS: i64 = 14;

/// Work Debt 집계 + Today 콕핏 섹션(Q1·PR attention)을 한 번에 도출. 순수 read(테스트 가능).
/// `date`는 로컬 오늘(YYYY-MM-DD) — 경과일 비교 기준.
pub async fn fetch_today_overview(db: &Db, date: &str) -> Result<TodayOverview, sqlx::Error> {
    // 미분류: quadrant=unclassified active, today 레일 밖(미분류는 보통 레일에 없음 — 일관성 위해 명시).
    let (unclassified,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE quadrant = 'unclassified' AND today_for_date IS NULL \
           AND status NOT IN ('done','archived','snoozed')",
    )
    .fetch_one(db)
    .await?;

    // Q1 overdue: q1_do_now active 중 생성 ≥ Q1_OVERDUE_DAYS일(레일 여부 무관 — 쌓인 긴급 부채).
    // created_at은 UTC 저장, ?1(date)은 호스트 로컬 날짜 → date(created_at,'localtime')로 맞춰
    // *로컬 캘린더 일수* 차이를 비교한다(아침 시간대 false-overdue 방지).
    // ⚠️ 'localtime'은 제거 금지(load-bearing) — 회귀 테스트 q1_overdue_uses_local_calendar_not_utc.
    let (q1_overdue,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE quadrant = 'q1_do_now' AND status NOT IN ('done','archived','snoozed') \
           AND julianday(?1) - julianday(date(created_at, 'localtime')) >= ?2",
    )
    .bind(date)
    .bind(Q1_OVERDUE_DAYS)
    .fetch_one(db)
    .await?;

    // stale backlog: active 신호가 생성 ≥ STALE_DAYS일 멈춤(today 레일 밖). quadrant 무관(나이 렌즈).
    let (stale_backlog,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE today_for_date IS NULL AND status NOT IN ('done','archived','snoozed') \
           AND julianday(?1) - julianday(date(created_at, 'localtime')) >= ?2",
    )
    .bind(date)
    .bind(STALE_BACKLOG_DAYS)
    .fetch_one(db)
    .await?;

    // cleanup needed: type=cleanup active(머지 후 정리 등). today 레일 무관(정리 부채는 어디 있든 부채 —
    // 다른 타일과 달리 today_for_date 미필터, 의도적). 현재 로컬 신호만(PR merged-cleanup 버킷은 ambient).
    let (cleanup_needed,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE type = 'cleanup' AND status NOT IN ('done','archived','snoozed')",
    )
    .fetch_one(db)
    .await?;

    // Q1 콕핏 리스트: 사람이 q1 분류했고 아직 today 레일에 없는 것(끌어올릴 대상).
    let q1_items = sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE quadrant = 'q1_do_now' AND today_for_date IS NULL \
           AND status NOT IN ('done','archived','snoozed') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await?;

    // PR attention: 매트릭스로 escalate된 PR 신호(unclassified로 진입하지만 source/type로 식별).
    let pr_attention = sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE source = 'github_pr' AND type = 'pr_attention' \
           AND status NOT IN ('done','archived','snoozed') \
         ORDER BY updated_at DESC"
    ))
    .fetch_all(db)
    .await?;

    Ok(TodayOverview {
        work_debt: WorkDebt {
            unclassified: unclassified as u32,
            q1_overdue: q1_overdue as u32,
            stale_backlog: stale_backlog as u32,
            cleanup_needed: cleanup_needed as u32,
        },
        q1_items,
        pr_attention,
    })
}

/// 일별 부채 스냅샷 멱등 upsert(INVARIANT #3). 같은 날 재방문은 최신값으로 갱신(중복 0).
/// Weekly review(#11c)의 "부채 추세"가 이 누적분을 읽는다(백필 없음 — 전진 누적).
pub async fn upsert_debt_snapshot(
    db: &Db,
    date: &str,
    debt: &WorkDebt,
    pr_attention: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO debt_snapshots \
            (date, unclassified, q1_overdue, stale_backlog, cleanup_needed, pr_attention) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(date) DO UPDATE SET \
            unclassified = excluded.unclassified, q1_overdue = excluded.q1_overdue, \
            stale_backlog = excluded.stale_backlog, cleanup_needed = excluded.cleanup_needed, \
            pr_attention = excluded.pr_attention, updated_at = datetime('now')",
    )
    .bind(date)
    .bind(debt.unclassified as i64)
    .bind(debt.q1_overdue as i64)
    .bind(debt.stale_backlog as i64)
    .bind(debt.cleanup_needed as i64)
    .bind(pr_attention)
    .execute(db)
    .await?;
    Ok(())
}

/// Today 운영 뷰 집계 + 오늘 부채 스냅샷 기록. `date`는 프런트가 보내는 로컬 오늘.
/// TodayView만 호출(항상 오늘) — 과거 날짜로 스냅샷이 오염되지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn today_overview(db: State<'_, Db>, date: String) -> Result<TodayOverview, AppError> {
    let overview = fetch_today_overview(db.inner(), &date).await?;
    upsert_debt_snapshot(
        db.inner(),
        &date,
        &overview.work_debt,
        overview.pr_attention.len() as i64,
    )
    .await?;
    Ok(overview)
}
