use tauri::State;

use crate::commands::routines::{parse_weekdays, routine_due_on};
use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{
    DebtPoint, RoutineFreq, RoutineMonthlyPattern, WeeklyPrActivity, WeeklyReview,
    WeeklyRoutineAdherence, WeeklyThroughput,
};

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

    // throughput — signals-primary 카운트는 signal_store 위임(localtime 정렬 규칙은 store에 보존).
    // promoted는 promotions 테이블이라 여기 잔류.
    let captured = signal_store::count_captured_in_range(db, &start_s, &end_s).await?;
    let completed = signal_store::count_completed_in_range(db, &start_s, &end_s).await?;
    let (promoted,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM promotions \
         WHERE status = 'created' AND date(created_at, 'localtime') BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_one(db)
    .await?;

    // PR 활동 — attention_new=범위 내 새 PR 신호, resolved=done 전이(머지/CI해소 근사, updated_at).
    let attention_new = signal_store::count_pr_new_in_range(db, &start_s, &end_s).await?;
    let resolved = signal_store::count_pr_resolved_in_range(db, &start_s, &end_s).await?;

    // 루틴 이행률 — 공용 due-calc(routine_due_on)로 daily/weekly/biweekly/monthly 모두 일관 집계.
    // done=스케줄 해당 날의 체크만(due와 동일 기준), due=스케줄 occurrence 합산.
    // 비스케줄 날 체크(예: 월요일 루틴을 화요일에 체크)는 done에서 제외 → done ⊆ due, 이행률 왜곡 방지.

    type CheckRow = (
        RoutineFreq,
        Option<String>,
        Option<String>,
        Option<RoutineMonthlyPattern>,
        Option<i64>,
        String,
    );
    let checks: Vec<CheckRow> = sqlx::query_as(
        "SELECT r.freq, r.weekdays, r.anchor_date, r.monthly_pattern, r.monthly_nth_week, rc.date \
             FROM routine_checks rc \
             JOIN routines r ON r.id = rc.routine_id \
             WHERE r.active = 1 AND rc.completed_at IS NOT NULL \
               AND rc.date BETWEEN ?1 AND ?2",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_all(db)
    .await?;
    let mut done: u32 = 0;
    for (freq, weekdays, anchor, mpattern, nth_week, date) in &checks {
        let parsed = match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
            Ok(d) => d,
            Err(_) => continue,
        };
        let wkdays = parse_weekdays(weekdays.as_deref());
        if routine_due_on(
            *freq,
            &wkdays,
            anchor.as_deref(),
            *mpattern,
            nth_week.map(|v| v as i32),
            parsed,
        ) {
            done += 1;
        }
    }
    type RoutineRow = (
        RoutineFreq,
        Option<String>,
        Option<String>,
        Option<RoutineMonthlyPattern>,
        Option<i64>,
    );
    let routines: Vec<RoutineRow> = sqlx::query_as(
        "SELECT freq, weekdays, anchor_date, monthly_pattern, monthly_nth_week \
         FROM routines WHERE active = 1",
    )
    .fetch_all(db)
    .await?;
    let mut due: u32 = 0;
    let mut d = start;
    while d <= end {
        for (freq, weekdays, anchor, mpattern, nth_week) in &routines {
            let wkdays = parse_weekdays(weekdays.as_deref());
            if routine_due_on(
                *freq,
                &wkdays,
                anchor.as_deref(),
                *mpattern,
                nth_week.map(|v| v as i32),
                d,
            ) {
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
