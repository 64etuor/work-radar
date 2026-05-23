mod overview;
mod rail;
mod weekly;

pub use overview::*;
pub use rail::*;
pub use weekly::*;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::{
        fetch_signals, fetch_today, insert_signal, promote_today, set_quadrant, unpromote_today,
    };
    use crate::models::{Kind, Quadrant, WorkDebt};

    /// Work Debt 집계 테스트용 raw seed — created_at/quadrant/today 레일을 직접 제어한다.
    #[allow(clippy::too_many_arguments)]
    async fn seed_signal(
        db: &crate::db::Db,
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
        promote_today(&db, &sig.id, "2026-05-21").await.unwrap();

        let matrix = fetch_signals(&db).await.unwrap();
        assert!(matrix.is_empty(), "승격된 카드는 매트릭스에서 제외");

        let today = fetch_today(&db, "2026-05-21").await.unwrap();
        assert_eq!(today.len(), 1);
        assert!(
            matches!(today[0].quadrant, Quadrant::Q1DoNow),
            "Q 배지 유지"
        );

        // 되돌리기 → 원 사분면으로 복귀, 매트릭스에 재등장.
        unpromote_today(&db, &sig.id).await.unwrap();
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
        promote_today(&db, &sig.id, "2026-05-21").await.unwrap();

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
