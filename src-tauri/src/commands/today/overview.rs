use tauri::State;

use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{TodayOverview, WorkDebt};

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
    // 부채 카운트/리스트는 signals-primary → signal_store 위임. 임계치 상수는 여기서 전달.
    // 비-signals 조립(WorkDebt 구조화, debt 스냅샷 upsert)은 이 커맨드 레이어에 잔류.
    let unclassified = signal_store::count_unclassified_active(db).await?;
    let q1_overdue = signal_store::count_q1_overdue(db, date, Q1_OVERDUE_DAYS).await?;
    let stale_backlog = signal_store::count_stale_backlog(db, date, STALE_BACKLOG_DAYS).await?;
    let cleanup_needed = signal_store::count_cleanup_needed(db).await?;
    let q1_items = signal_store::fetch_q1_items(db).await?;
    let pr_attention = signal_store::fetch_pr_attention(db).await?;

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
