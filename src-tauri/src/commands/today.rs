use tauri::State;

use crate::commands::shared::SIGNAL_COLS;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    DebtPoint, TodayOverview, WeeklyPrActivity, WeeklyReview, WeeklyRoutineAdherence,
    WeeklyThroughput, WorkDebt, WorkSignal,
};

// ── Today 레일 (로컬 승격, Acceptance 불요 — architecture.md) ──────────────────

/// 매트릭스 카드를 Today로 승격. 로컬 액션이라 외부 변경 없음(Acceptance 불요).
/// 승격하면 매트릭스에서 빠지고(today_for_date set) 원 quadrant는 배지로 유지된다.
pub async fn promote_today_inner(db: &Db, id: &str, date: &str) -> Result<WorkSignal, sqlx::Error> {
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

#[tauri::command]
#[specta::specta]
pub async fn promote_today(
    db: State<'_, Db>,
    id: String,
    date: String,
) -> Result<WorkSignal, AppError> {
    Ok(promote_today_inner(db.inner(), &id, &date).await?)
}

/// Today 승격 취소 → 원 사분면으로 복귀(없으면 미분류). 카운터 리셋.
pub async fn unpromote_today_inner(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error> {
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

#[tauri::command]
#[specta::specta]
pub async fn unpromote_today(db: State<'_, Db>, id: String) -> Result<WorkSignal, AppError> {
    Ok(unpromote_today_inner(db.inner(), &id).await?)
}

/// Today 항목 완료 토글. 완료(done)=해당 날짜 기록 → 다음날 이월 안 됨.
#[tauri::command]
#[specta::specta]
pub async fn toggle_today_done(
    db: State<'_, Db>,
    id: String,
    date: String,
    done: bool,
) -> Result<WorkSignal, AppError> {
    let done_at: Option<String> = if done { Some(date) } else { None };
    Ok(sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_done_at = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(done_at)
    .fetch_one(db.inner())
    .await?)
}

/// Today 레일 재정렬. ordered_ids 순서대로 today_rank 부여.
#[tauri::command]
#[specta::specta]
pub async fn reorder_today(db: State<'_, Db>, ordered_ids: Vec<String>) -> Result<(), AppError> {
    let mut tx = db.inner().begin().await?;
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE signals SET today_rank = ?2 WHERE id = ?1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
    }
    Ok(tx.commit().await?)
}

/// 오늘의 Today 항목. 미완료는 매일 잔류(rollover), 완료(today_done_at=오늘)는 당일만 표시.
/// 이전 날짜에 완료된 항목은 이월되지 않으므로 제외된다. age는 프런트가 today_for_date로 계산.
pub async fn fetch_today(db: &Db, today: &str) -> Result<Vec<WorkSignal>, sqlx::Error> {
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

#[tauri::command]
#[specta::specta]
pub async fn list_today(db: State<'_, Db>, today: String) -> Result<Vec<WorkSignal>, AppError> {
    Ok(fetch_today(db.inner(), &today).await?)
}

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

// ── Weekly review (Phase 11c, read 집계) ──────────────────────────────────────
// 지난 7일([start,end] 로컬 inclusive). throughput/PR/루틴은 기존 타임스탬프 live 유도,
// debt_trend는 debt_snapshots(11a부터 누적)에서 read. 전부 read — 외부 변경 0.

/// 주간 집계(순수 read, 테스트 가능). `end_date`=로컬 오늘(YYYY-MM-DD), 범위=[end-6, end].
pub async fn fetch_weekly_review(db: &Db, end_date: &str) -> Result<WeeklyReview, sqlx::Error> {
    let end = chrono::NaiveDate::parse_from_str(end_date, "%Y-%m-%d")
        .map_err(|_| sqlx::Error::Protocol("bad end_date (YYYY-MM-DD)".into()))?;
    let start = end - chrono::Duration::days(6);
    let start_s = start.format("%Y-%m-%d").to_string();
    let end_s = end.format("%Y-%m-%d").to_string();

    // throughput — created_at/updated_at은 UTC라 'localtime'으로 로컬 날짜 정렬, today_done_at은 이미 로컬.
    let (captured,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE source = 'braindump' AND date(created_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_one(db)
    .await?;
    let (completed,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM signals WHERE today_done_at BETWEEN ?1 AND ?2")
            .bind(&start_s)
            .bind(&end_s)
            .fetch_one(db)
            .await?;
    let (promoted,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM promotions \
         WHERE status = 'created' AND date(created_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_one(db)
    .await?;

    // PR 활동 — attention_new=범위 내 새 PR 신호, resolved=done 전이(머지/CI해소 근사, updated_at).
    let (attention_new,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE source = 'github_pr' AND type = 'pr_attention' \
           AND date(created_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_one(db)
    .await?;
    let (resolved,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM signals \
         WHERE source = 'github_pr' AND status = 'done' \
           AND date(updated_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_one(db)
    .await?;

    // 루틴 이행률 — 공용 due-calc(routine_due_on)로 daily/weekly/biweekly/monthly 모두 일관 집계.
    // done=스케줄 해당 날의 체크만(due와 동일 기준), due=스케줄 occurrence 합산.
    // 비스케줄 날 체크(예: 월요일 루틴을 화요일에 체크)는 done에서 제외 → done ⊆ due, 이행률 왜곡 방지.
    use crate::commands::routines::{parse_weekdays, routine_due_on};
    use crate::models::RoutineFreq;

    let checks: Vec<(
        crate::models::RoutineFreq,
        Option<String>,
        Option<String>,
        String,
    )> = sqlx::query_as(
        "SELECT r.freq, r.weekdays, r.anchor_date, rc.date FROM routine_checks rc \
             JOIN routines r ON r.id = rc.routine_id \
             WHERE r.active = 1 AND rc.date BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_all(db)
    .await?;
    let mut done: u32 = 0;
    for (freq, weekdays, anchor, date) in &checks {
        let parsed = match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };
        let wkdays = parse_weekdays(weekdays.as_deref());
        if routine_due_on(*freq, &wkdays, anchor.as_deref(), parsed) {
            done += 1;
        }
    }
    let routines: Vec<(RoutineFreq, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT freq, weekdays, anchor_date FROM routines WHERE active = 1")
            .fetch_all(db)
            .await?;
    let mut due: u32 = 0;
    let mut d = start;
    while d <= end {
        for (freq, weekdays, anchor) in &routines {
            let wkdays = parse_weekdays(weekdays.as_deref());
            if routine_due_on(*freq, &wkdays, anchor.as_deref(), d) {
                due += 1;
            }
        }
        d += chrono::Duration::days(1);
    }
    // due=0이면 0% (checked_div None → unwrap_or). done ⊆ due지만 안전하게 100% 캡.
    let rate_pct = (done * 100).checked_div(due).unwrap_or(0).min(100);

    // debt_trend — 11a 스냅샷 누적분(7일 미만이면 있는 만큼). i64 fetch 후 u32 변환.
    let rows: Vec<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT date, unclassified, q1_overdue, stale_backlog, cleanup_needed, pr_attention \
         FROM debt_snapshots WHERE date BETWEEN ?1 AND ?2 ORDER BY date",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_all(db)
    .await?;
    let debt_trend = rows
        .into_iter()
        .map(|(date, u, q, s, c, p)| DebtPoint {
            date,
            unclassified: u as u32,
            q1_overdue: q as u32,
            stale_backlog: s as u32,
            cleanup_needed: c as u32,
            pr_attention: p as u32,
        })
        .collect();

    Ok(WeeklyReview {
        start: start_s,
        end: end_s,
        throughput: WeeklyThroughput {
            captured: captured as u32,
            completed: completed as u32,
            promoted: promoted as u32,
        },
        pr_activity: WeeklyPrActivity {
            attention_new: attention_new as u32,
            resolved: resolved as u32,
        },
        routine_adherence: WeeklyRoutineAdherence {
            due,
            done,
            rate_pct,
        },
        debt_trend,
    })
}

/// 지난 7일 주간 회고 집계. `end_date`=프런트가 보내는 로컬 오늘.
#[tauri::command]
#[specta::specta]
pub async fn weekly_review(db: State<'_, Db>, end_date: String) -> Result<WeeklyReview, AppError> {
    fetch_weekly_review(db.inner(), &end_date)
        .await
        .map_err(|e| match e {
            sqlx::Error::Protocol(msg) => AppError::validation("today.bad_end_date", msg),
            other => AppError::from(other),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signals::{fetch_signals, insert_signal, set_quadrant};
    use crate::models::{Kind, Quadrant};

    /// Work Debt 집계 테스트용 raw seed — created_at/quadrant/today 레일을 직접 제어한다.
    #[allow(clippy::too_many_arguments)]
    async fn seed_signal(
        db: &Db,
        source: &str,
        sig_type: &str,
        quadrant: &str,
        status: &str,
        today_for_date: Option<&str>,
        created_at: &str,
    ) {
        sqlx::query(
            "INSERT INTO signals \
                (id, title, source, type, quadrant, status, today_for_date, created_at, updated_at) \
             VALUES (lower(hex(randomblob(16))), 'seed', ?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        )
        .bind(source)
        .bind(sig_type)
        .bind(quadrant)
        .bind(status)
        .bind(today_for_date)
        .bind(created_at)
        .execute(db)
        .await
        .expect("seed signal");
    }

    /// Work Debt 4지표 + Q1/PR attention 섹션이 quadrant·나이·레일 멤버십으로 정확히 갈린다.
    #[tokio::test]
    async fn today_overview_aggregates_debt_and_sections() {
        let db = fresh_db().await;
        let date = "2026-05-22";
        let fresh = format!("{date} 12:00:00");
        let old = "2020-01-01 00:00:00";
        // A: 미분류 fresh (unclassified).
        seed_signal(
            &db,
            "braindump",
            "thought",
            "unclassified",
            "new",
            None,
            &fresh,
        )
        .await;
        // B: q1 old off-rail → overdue + stale + q1_items.
        seed_signal(
            &db,
            "braindump",
            "task_candidate",
            "q1_do_now",
            "classified",
            None,
            old,
        )
        .await;
        // C: q1 fresh off-rail → q1_items only.
        seed_signal(
            &db,
            "braindump",
            "task_candidate",
            "q1_do_now",
            "classified",
            None,
            &fresh,
        )
        .await;
        // D: q1 old on-rail → overdue(레일 무관) but not stale/not q1_items(레일).
        seed_signal(
            &db,
            "braindump",
            "task_candidate",
            "q1_do_now",
            "promoted",
            Some(date),
            old,
        )
        .await;
        // E: cleanup fresh (q3라 미분류 아님).
        seed_signal(
            &db,
            "system",
            "cleanup",
            "q3_quick_contain",
            "new",
            None,
            &fresh,
        )
        .await;
        // F: PR attention fresh (github_pr, unclassified로 진입).
        seed_signal(
            &db,
            "github_pr",
            "pr_attention",
            "unclassified",
            "new",
            None,
            &fresh,
        )
        .await;
        // done/archived는 어떤 지표에도 안 잡힌다.
        seed_signal(
            &db,
            "braindump",
            "thought",
            "unclassified",
            "done",
            None,
            old,
        )
        .await;

        let ov = fetch_today_overview(&db, date).await.unwrap();
        assert_eq!(
            ov.work_debt.unclassified, 2,
            "A + F (미분류 off-rail active)"
        );
        assert_eq!(ov.work_debt.q1_overdue, 2, "B + D (q1 old, 레일 무관)");
        assert_eq!(ov.work_debt.stale_backlog, 1, "B만 (old off-rail)");
        assert_eq!(ov.work_debt.cleanup_needed, 1, "E");
        assert_eq!(ov.q1_items.len(), 2, "B + C (off-rail q1)");
        assert_eq!(ov.pr_attention.len(), 1, "F");
    }

    /// 같은 날 today_overview 재방문은 스냅샷을 append 아닌 upsert(중복 0) + 최신값 갱신(INVARIANT #3).
    #[tokio::test]
    async fn debt_snapshot_upsert_is_idempotent() {
        let db = fresh_db().await;
        let date = "2026-05-22";
        seed_signal(
            &db,
            "braindump",
            "thought",
            "unclassified",
            "new",
            None,
            &format!("{date} 09:00:00"),
        )
        .await;

        let ov = fetch_today_overview(&db, date).await.unwrap();
        upsert_debt_snapshot(&db, date, &ov.work_debt, 3)
            .await
            .unwrap();
        // 재방문(같은 날) — pr_attention만 다른 값으로.
        upsert_debt_snapshot(&db, date, &ov.work_debt, 0)
            .await
            .unwrap();

        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM debt_snapshots")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(rows, 1, "같은 날은 한 행(upsert)");
        let (pr, uncl): (i64, i64) =
            sqlx::query_as("SELECT pr_attention, unclassified FROM debt_snapshots WHERE date = ?1")
                .bind(date)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(pr, 0, "재방문 시 최신값으로 갱신");
        assert_eq!(uncl, 1, "미분류 1건 반영");
    }

    /// overdue 비교는 로컬 캘린더 일수 기준 — created_at(UTC)을 'localtime'으로 맞춘다.
    /// 호스트 TZ 무관하게 결정적이도록 같은 'now'를 양쪽에 쓴다(CI=UTC / 로컬=KST 모두 통과).
    #[tokio::test]
    async fn q1_overdue_uses_local_calendar_not_utc() {
        let db = fresh_db().await;
        let (local_today,): (String,) = sqlx::query_as("SELECT date('now','localtime')")
            .fetch_one(&db)
            .await
            .unwrap();
        let (utc_now,): (String,) = sqlx::query_as("SELECT datetime('now')")
            .fetch_one(&db)
            .await
            .unwrap();
        // 방금 만든 q1 → 어느 TZ에서도 overdue 아님(이전 버그: UTC date 기준이라 아침엔 false-overdue).
        seed_signal(
            &db,
            "braindump",
            "task_candidate",
            "q1_do_now",
            "classified",
            None,
            &utc_now,
        )
        .await;
        let ov = fetch_today_overview(&db, &local_today).await.unwrap();
        assert_eq!(ov.work_debt.q1_overdue, 0, "방금 만든 q1은 overdue 아님");
        // 2020년 q1 → overdue.
        seed_signal(
            &db,
            "braindump",
            "task_candidate",
            "q1_do_now",
            "classified",
            None,
            "2020-01-01 00:00:00",
        )
        .await;
        let ov2 = fetch_today_overview(&db, &local_today).await.unwrap();
        assert_eq!(ov2.work_debt.q1_overdue, 1, "오래된 q1은 overdue");
    }

    /// Weekly review가 지난 7일을 throughput/PR/루틴/부채추세로 정확히 집계(범위 안팎 분리).
    /// TZ 안전: created_at/updated_at은 mid-range 정오(±14h여도 같은 날), today_done_at은 로컬 날짜.
    #[tokio::test]
    async fn weekly_review_aggregates_last_7_days() {
        let db = fresh_db().await;
        let end = "2026-05-22"; // 범위 [2026-05-16 .. 2026-05-22]
        let inrange = "2026-05-19 12:00:00";
        let outrange = "2026-05-01 12:00:00";

        // throughput.captured: braindump 2 in / 1 out.
        seed_signal(
            &db,
            "braindump",
            "thought",
            "unclassified",
            "new",
            None,
            inrange,
        )
        .await;
        seed_signal(
            &db,
            "braindump",
            "thought",
            "unclassified",
            "new",
            None,
            "2026-05-20 12:00:00",
        )
        .await;
        seed_signal(
            &db,
            "braindump",
            "thought",
            "unclassified",
            "new",
            None,
            outrange,
        )
        .await;

        // completed: today_done_at 1 in / 1 out. source는 braindump 아님(captured 오염 방지).
        for (done_at, ca) in [("2026-05-18", inrange), ("2026-05-10", outrange)] {
            sqlx::query(
                "INSERT INTO signals (id, title, source, type, quadrant, status, today_for_date, today_done_at, created_at, updated_at) \
                 VALUES (lower(hex(randomblob(16))), 'c', 'notion_backlog', 'task_candidate', 'q1_do_now', 'promoted', ?2, ?1, ?2, ?2)",
            )
            .bind(done_at)
            .bind(ca)
            .execute(&db)
            .await
            .unwrap();
        }

        // promoted: 외부 승격 created 1 in / draft 1 (미집계). FK용 signal은 비-braindump·범위 밖.
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, quadrant, status, created_at, updated_at) \
             VALUES ('promosrc', 'p', 'system', 'thought', 'unclassified', 'new', ?1, ?1)",
        )
        .bind(outrange)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO promotions (id, signal_id, target, status, draft_payload, created_at) \
             VALUES (lower(hex(randomblob(16))), 'promosrc', 'notion_backlog', 'created', '{}', ?1)",
        )
        .bind(inrange)
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO promotions (id, signal_id, target, status, draft_payload, created_at) \
             VALUES (lower(hex(randomblob(16))), 'promosrc', 'notion_backlog', 'draft', '{}', ?1)",
        )
        .bind(inrange)
        .execute(&db)
        .await
        .unwrap();

        // PR: attention_new 1 in / 1 out; resolved 1 (created out, updated in).
        seed_signal(
            &db,
            "github_pr",
            "pr_attention",
            "unclassified",
            "new",
            None,
            inrange,
        )
        .await;
        seed_signal(
            &db,
            "github_pr",
            "pr_attention",
            "unclassified",
            "new",
            None,
            outrange,
        )
        .await;
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, quadrant, status, created_at, updated_at) \
             VALUES (lower(hex(randomblob(16))), 'r', 'github_pr', 'pr_attention', 'unclassified', 'done', ?1, ?2)",
        )
        .bind(outrange) // created out → attention_new 미집계
        .bind(inrange) // updated in → resolved 집계
        .execute(&db)
        .await
        .unwrap();

        // 루틴: daily 1개 → due=7. 체크 3 in / 1 out → done=3.
        sqlx::query(
            "INSERT INTO routines (id, title, freq, active) VALUES ('rt1', '물 마시기', 'daily', 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        for d in ["2026-05-17", "2026-05-19", "2026-05-21", "2026-05-02"] {
            sqlx::query(
                "INSERT INTO routine_checks (id, routine_id, date) VALUES (lower(hex(randomblob(16))), 'rt1', ?1)",
            )
            .bind(d)
            .execute(&db)
            .await
            .unwrap();
        }

        // debt_trend: 2 in / 1 out, 정렬.
        for d in ["2026-05-21", "2026-05-20", "2026-05-01"] {
            upsert_debt_snapshot(
                &db,
                d,
                &WorkDebt {
                    unclassified: 1,
                    q1_overdue: 0,
                    stale_backlog: 0,
                    cleanup_needed: 0,
                },
                0,
            )
            .await
            .unwrap();
        }

        let wr = fetch_weekly_review(&db, end).await.unwrap();
        assert_eq!(wr.start, "2026-05-16");
        assert_eq!(wr.end, "2026-05-22");
        assert_eq!(wr.throughput.captured, 2, "braindump in-range");
        assert_eq!(wr.throughput.completed, 1, "today_done_at in-range");
        assert_eq!(wr.throughput.promoted, 1, "created 승격만(draft 제외)");
        assert_eq!(wr.pr_activity.attention_new, 1, "범위 내 새 PR 신호");
        assert_eq!(wr.pr_activity.resolved, 1, "done 전이(updated in-range)");
        assert_eq!(wr.routine_adherence.due, 7, "daily × 7일");
        assert_eq!(wr.routine_adherence.done, 3, "in-range 체크");
        assert_eq!(wr.routine_adherence.rate_pct, 42, "3/7=42%");
        assert_eq!(wr.debt_trend.len(), 2, "in-range 스냅샷만");
        assert_eq!(wr.debt_trend[0].date, "2026-05-20", "date 오름차순");
    }

    /// 주간 루틴 이행률은 스케줄 해당 날의 체크만 done으로 친다(비스케줄 제외 → done ≤ due).
    /// + weekly_review가 어떤 write도 하지 않음을 확인(INVARIANT #2 가드: debt_snapshots 불변).
    #[tokio::test]
    async fn weekly_routine_adherence_counts_scheduled_only() {
        use chrono::{Datelike, Duration, NaiveDate, Weekday};
        let db = fresh_db().await;
        let end_s = "2026-05-22";
        let end = NaiveDate::parse_from_str(end_s, "%Y-%m-%d").unwrap();
        let start = end - Duration::days(6);
        // 7일 창엔 각 요일이 정확히 하나 → 월요일 하나, 비월요일 하나 고른다.
        let mut monday = None;
        let mut other = None;
        let mut d = start;
        while d <= end {
            if d.weekday() == Weekday::Mon {
                monday = Some(d);
            } else if other.is_none() {
                other = Some(d);
            }
            d += Duration::days(1);
        }
        let monday = monday.unwrap().format("%Y-%m-%d").to_string();
        let other = other.unwrap().format("%Y-%m-%d").to_string();

        sqlx::query(
            "INSERT INTO routines (id, title, freq, weekdays, active) \
             VALUES ('rtw', '월요 회고', 'weekly', '[\"mon\"]', 1)",
        )
        .execute(&db)
        .await
        .unwrap();
        // 스케줄(월) 체크 1 + 비스케줄(타 요일) 체크 1.
        for date in [&monday, &other] {
            sqlx::query(
                "INSERT INTO routine_checks (id, routine_id, date) VALUES (lower(hex(randomblob(16))), 'rtw', ?1)",
            )
            .bind(date)
            .execute(&db)
            .await
            .unwrap();
        }

        let (before,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM debt_snapshots")
            .fetch_one(&db)
            .await
            .unwrap();

        let wr = fetch_weekly_review(&db, end_s).await.unwrap();
        assert_eq!(wr.routine_adherence.due, 1, "7일 창에 월요일 1개");
        assert_eq!(
            wr.routine_adherence.done, 1,
            "월요일 체크만 done(비스케줄 제외)"
        );
        assert_eq!(wr.routine_adherence.rate_pct, 100);

        let (after,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM debt_snapshots")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(
            before, after,
            "weekly_review는 write하지 않음(INVARIANT #2)"
        );
    }

    /// 승격 시 매트릭스에서 빠지고 Today에 나타난다. quadrant 배지는 유지된다.
    #[tokio::test]
    async fn promote_today_moves_card_to_today_rail() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("금요일 데모 리허설", Some(Kind::Work)))
            .await
            .unwrap();
        set_quadrant(&db, &sig.id, Quadrant::Q1DoNow).await.unwrap();
        promote_today_inner(&db, &sig.id, "2026-05-21")
            .await
            .unwrap();

        let matrix = fetch_signals(&db).await.unwrap();
        assert!(matrix.is_empty(), "승격된 카드는 매트릭스에서 제외");

        let today = fetch_today(&db, "2026-05-21").await.unwrap();
        assert_eq!(today.len(), 1);
        assert!(
            matches!(today[0].quadrant, Quadrant::Q1DoNow),
            "Q 배지 유지"
        );

        // 되돌리기 → 원 사분면으로 복귀, 매트릭스에 재등장.
        unpromote_today_inner(&db, &sig.id).await.unwrap();
        let matrix2 = fetch_signals(&db).await.unwrap();
        assert_eq!(matrix2.len(), 1);
        assert!(matches!(matrix2[0].quadrant, Quadrant::Q1DoNow));
        assert!(fetch_today(&db, "2026-05-21").await.unwrap().is_empty());
    }

    /// 완료된 Today 항목은 당일만 보이고 다음날 이월되지 않는다(rollover 제외).
    #[tokio::test]
    async fn completed_today_item_does_not_roll_over() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("세금계산서 확인", None))
            .await
            .unwrap();
        promote_today_inner(&db, &sig.id, "2026-05-21")
            .await
            .unwrap();

        // 미완료: 다음날에도 잔류(rollover).
        assert_eq!(fetch_today(&db, "2026-05-22").await.unwrap().len(), 1);

        // 5/21에 완료 처리.
        sqlx::query("UPDATE signals SET today_done_at = '2026-05-21' WHERE id = ?1")
            .bind(&sig.id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            fetch_today(&db, "2026-05-21").await.unwrap().len(),
            1,
            "당일엔 보임"
        );
        assert!(
            fetch_today(&db, "2026-05-22").await.unwrap().is_empty(),
            "완료는 다음날 이월 안 됨"
        );
    }
}
