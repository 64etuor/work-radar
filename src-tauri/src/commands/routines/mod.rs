//! 루틴(반복 작업) 도메인. 저응집 단일 파일을 도메인별 서브모듈로 분리(순수 move):
//!   schedule(due-calc) / crud(생성·수정·삭제·재정렬·토글) / listing(오늘 조회) /
//!   reminders(알림 enqueue) / tracking(이행률 집계). `pub use`로 `commands::*` 경로 보존.

mod crud;
mod google_sync;
mod listing;
mod reminders; // 내부 헬퍼 전용(공개 커맨드 없음) — crud/listing이 `super::reminders::`로 접근.
mod schedule;
mod tags;
mod tracking;

pub use crud::*;
pub use google_sync::*;
pub use listing::*;
pub use schedule::*;
pub use tags::*;
pub use tracking::*;

#[cfg(test)]
mod tests {
    use super::reminders::{reminder_source_id, sync_reminders};
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::db::Db;
    use crate::models::{
        CreateRoutineInput, Kind, RoutineFreq, RoutineMonthlyPattern, UpdateRoutineInput, Weekday,
    };
    use crate::scheduler::utc_now_string;
    use chrono::NaiveDate;

    fn nd(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// 루틴: 오늘 요일 매칭 + 날짜별 완료 토글 → 다음날 리셋.
    #[tokio::test]
    async fn routine_today_matching_and_per_date_check() {
        let db = fresh_db().await;
        // 수·금 루틴.
        insert_routine(
            &db,
            &CreateRoutineInput {
                title: "주간 회고".into(),
                freq: RoutineFreq::Weekly,
                weekdays: vec![Weekday::Wed, Weekday::Fri],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: Some(Kind::Work),
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // 금요일이면 표시, 목요일이면 미표시.
        let fri = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(fri.len(), 1);
        assert!(!fri[0].done);
        let thu = fetch_today_routines(&db, "2026-05-21", Weekday::Thu)
            .await
            .unwrap();
        assert!(thu.is_empty(), "목요일엔 수·금 루틴 미표시");

        // 금요일 완료 체크 → 그날만 done.
        let rid = fri[0].id.clone();
        toggle_check(&db, &rid, "2026-05-22", true).await;
        let fri_done = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert!(fri_done[0].done);
    }

    /// monthly: anchor day와 같은 day-of-month면 due. 월말 클램프(31 → 그달 말일).
    #[test]
    fn monthly_due_calc_with_month_end_clamp() {
        // anchor=1/15 → 매월 15일.
        let a15 = nd("2026-01-15");
        assert!(routine_due_on(
            RoutineFreq::Monthly,
            &[],
            Some("2026-01-15"),
            nd("2026-03-15")
        ));
        assert!(!routine_due_on(
            RoutineFreq::Monthly,
            &[],
            Some("2026-01-15"),
            nd("2026-03-14")
        ));
        let _ = a15;

        // anchor=1/31 → 2월(28일)엔 28일에 due(클램프), 31일짜리 달엔 31일.
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-02-28")
            ),
            "2월 말일로 클램프"
        );
        assert!(
            !routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-02-27")
            ),
            "2/27은 due 아님"
        );
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-03-31")
            ),
            "3월 31일은 그대로 due"
        );
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2026-01-31"),
                nd("2026-04-30")
            ),
            "4월(30일)은 30일로 클램프"
        );
        // 윤년 2/29.
        assert!(
            routine_due_on(
                RoutineFreq::Monthly,
                &[],
                Some("2024-01-31"),
                nd("2024-02-29")
            ),
            "윤년 2월은 29일로 클램프"
        );
    }

    /// monthly: anchor 없으면 보수적으로 due 아님.
    #[test]
    fn monthly_without_anchor_is_not_due() {
        assert!(!routine_due_on(
            RoutineFreq::Monthly,
            &[],
            None,
            nd("2026-05-15")
        ));
    }

    /// biweekly: 선택 요일 + anchor 기준 14일 parity. anchor 주는 due, 다음 주는 아님, 그 다음 주 due.
    #[test]
    fn biweekly_parity_calc() {
        // anchor=금 2026-05-22, 요일=금. 같은 주(앵커 주) due.
        let anchor = "2026-05-22";
        let days = [Weekday::Fri];
        assert!(
            routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-05-22")),
            "앵커 당일(금) due"
        );
        // 1주 뒤 금(5/29) → parity off → 아님.
        assert!(
            !routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-05-29")),
            "1주 뒤는 격주 off"
        );
        // 2주 뒤 금(6/5) → parity on → due.
        assert!(
            routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-06-05")),
            "2주 뒤는 격주 on"
        );
        // 앵커 주여도 다른 요일이면 아님(목 5/21).
        assert!(
            !routine_due_on(RoutineFreq::Biweekly, &days, Some(anchor), nd("2026-05-21")),
            "선택 요일 아니면 아님"
        );
    }

    /// biweekly: anchor 이전 날짜(과거)도 parity가 맞으면 due (음수 weeks 안정).
    #[test]
    fn biweekly_parity_before_anchor() {
        let anchor = "2026-05-22"; // 금
        let days = [Weekday::Fri];
        // 2주 전 금(5/8) → parity on.
        assert!(routine_due_on(
            RoutineFreq::Biweekly,
            &days,
            Some(anchor),
            nd("2026-05-08")
        ));
        // 1주 전 금(5/15) → parity off.
        assert!(!routine_due_on(
            RoutineFreq::Biweekly,
            &days,
            Some(anchor),
            nd("2026-05-15")
        ));
    }

    /// daily는 항상 due, weekly는 요일만.
    #[test]
    fn daily_and_weekly_due() {
        assert!(routine_due_on(
            RoutineFreq::Daily,
            &[],
            None,
            nd("2026-05-22")
        ));
        assert!(routine_due_on(
            RoutineFreq::Weekly,
            &[Weekday::Fri],
            None,
            nd("2026-05-22")
        ));
        assert!(!routine_due_on(
            RoutineFreq::Weekly,
            &[Weekday::Mon],
            None,
            nd("2026-05-22")
        ));
    }

    /// 트래킹: daily 7일, 체크 3 → 이행률 42%, 최신 연속 체크면 streak 반영.
    #[tokio::test]
    async fn tracking_adherence_streak_history() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "물 마시기".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();
        // end=2026-05-22, days=7 → 5/16..5/22. 최근 3일(5/20,21,22) 체크.
        for d in ["2026-05-20", "2026-05-21", "2026-05-22"] {
            toggle_check(&db, &r.id, d, true).await;
        }
        let tracking = fetch_routine_tracking(&db, "2026-05-22", 7).await.unwrap();
        assert_eq!(tracking.len(), 1);
        let t = &tracking[0];
        assert_eq!(t.due, 7, "daily × 7일");
        assert_eq!(t.done, 3);
        assert_eq!(t.rate_pct, 42, "3/7 = 42%");
        assert_eq!(t.streak, 3, "최신 3일 연속");
        assert_eq!(t.history.len(), 7);
        assert!(t.history.last().unwrap().done, "5/22 체크됨");
        assert!(!t.history[0].done, "5/16 미체크");
    }

    /// 알림 enqueue: time_of_day 있는 due 루틴은 fire_at 행을 멱등 INSERT(두 번 호출해도 1행).
    #[tokio::test]
    async fn reminder_enqueue_idempotent() {
        let db = fresh_db().await;
        insert_routine(
            &db,
            &CreateRoutineInput {
                title: "아침 운동".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: Some(30),
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // list_today_routines 경로가 sync를 호출한다 — fetch + sync 두 번.
        let r1 = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &r1).await.unwrap();
        sync_reminders(&db, "2026-05-22", &r1).await.unwrap();

        let (count,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM scheduled_notifications WHERE source = 'routine'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(count, 1, "멱등 — 하루 한 행만");
    }

    /// 완료한 루틴은 알림을 발사하지 않는다: toggle done이 미발사 행을 fired로 마킹.
    #[tokio::test]
    async fn completed_routine_marks_reminder_fired() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "약 먹기".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("21:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();
        let today = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &today).await.unwrap();

        // 완료 토글 → 미발사 행이 fired로.
        toggle_done(&db, &r.id, "2026-05-22").await;

        let (unfired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications \
             WHERE source = 'routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired, 0, "완료 루틴 알림은 fired로 skip");
    }

    /// PR 6 §D10: 루틴 정의의 time_of_day 변경은 오늘 routine_checks.time_override를 건드리지 않는다.
    /// 정책 — 정의 변경은 "내일부터" 자동 적용. 오늘 인스턴스(override)는 보존.
    #[tokio::test]
    async fn update_routine_time_does_not_touch_today_override() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "아침 운동".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // 오늘 routine_checks 행 + time_override='10:00' 시드 (사용자가 드래그로 이동했다고 가정).
        sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date, time_override) \
             VALUES (lower(hex(randomblob(16))), ?1, '2026-05-22', '10:00')",
        )
        .bind(&r.id)
        .execute(&db)
        .await
        .unwrap();

        // 정의 시간을 07:00 → 08:00으로 변경.
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: r.id.clone(),
                title: "아침 운동".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("08:00".into()),
                reminder_offset_min: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // 오늘 인스턴스의 time_override는 '10:00' 그대로 보존.
        let (override_after,): (Option<String>,) = sqlx::query_as(
            "SELECT time_override FROM routine_checks WHERE routine_id = ?1 AND date = '2026-05-22'",
        )
        .bind(&r.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            override_after.as_deref(),
            Some("10:00"),
            "정의 시간 변경은 오늘 override를 건드리지 말아야 함 (spec §D10)"
        );

        // 정의 자체는 08:00으로 변경됨.
        let (defn_time,): (Option<String>,) =
            sqlx::query_as("SELECT time_of_day FROM routines WHERE id = ?1")
                .bind(&r.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(defn_time.as_deref(), Some("08:00"));
    }

    /// 정렬: reorder_routines가 rank를 부여하고 list가 rank 순으로 반환.
    #[tokio::test]
    async fn reorder_persists_rank_order() {
        let db = fresh_db().await;
        let a = insert_daily(&db, "A").await;
        let b = insert_daily(&db, "B").await;
        let c = insert_daily(&db, "C").await;
        // 순서 C, A, B로 재정렬.
        reorder(&db, &[&c, &a, &b]).await;
        let list = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        let titles: Vec<&str> = list.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles, vec!["C", "A", "B"]);
    }

    /// update_routine: 필드 변경 후 미발사 알림 삭제, 발사된 알림은 보존.
    #[tokio::test]
    async fn update_routine_clears_unfired_keeps_fired() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "기존 루틴".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("08:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // 미발사 알림 enqueue.
        let routines = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &routines).await.unwrap();

        // 발사된 알림 행을 수동 삽입 (fired_at 있음).
        let fired_source_id = format!("routine:{}:2026-05-21", r.id);
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id, fired_at) \
             VALUES (lower(hex(randomblob(16))), '2026-05-21 08:00:00', '루틴: 기존 루틴', 'test', \
             'routine', ?1, '2026-05-21 08:00:01')",
        )
        .bind(&fired_source_id)
        .execute(&db)
        .await
        .unwrap();

        // 미발사 1개, 발사 1개.
        let (unfired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired, 1);

        // 루틴 수정 (제목 + 시간 변경).
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: r.id.clone(),
                title: "수정된 루틴".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("09:00".into()),
                reminder_offset_min: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // 미발사 알림 삭제됨.
        let (unfired_after,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired_after, 0, "미발사 알림은 삭제됨");

        // 발사된 알림은 보존됨.
        let (fired_after,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NOT NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(fired_after, 1, "발사된 알림은 보존됨");

        // 제목 변경 확인.
        let updated = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(updated[0].title, "수정된 루틴");
    }

    /// delete_routine: 루틴 + routine_checks + 미발사 알림 삭제, 발사된 알림 보존, 다른 루틴 무손상.
    #[tokio::test]
    async fn delete_routine_removes_checks_and_unfired_keeps_fired_and_others() {
        let db = fresh_db().await;
        let r1 = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "삭제 대상".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("07:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        let r2 = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "다른 루틴".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap();

        // r1 체크 추가.
        toggle_check(&db, &r1.id, "2026-05-22", true).await;

        // r1 미발사 알림 enqueue.
        let routines = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        sync_reminders(&db, "2026-05-22", &routines).await.unwrap();

        // r1의 발사된 알림 행 수동 삽입.
        let fired_source_id = format!("routine:{}:2026-05-21", r1.id);
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id, fired_at) \
             VALUES (lower(hex(randomblob(16))), '2026-05-21 07:00:00', '루틴: 삭제 대상', 'test', \
             'routine', ?1, '2026-05-21 07:00:01')",
        )
        .bind(&fired_source_id)
        .execute(&db)
        .await
        .unwrap();

        // 삭제 전: r1 체크 1개, r1 미발사 1개, r1 발사 1개.
        let (checks,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM routine_checks WHERE routine_id = ?1")
                .bind(&r1.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(checks, 1);

        // r1 삭제.
        delete_routine_inner(&db, r1.id.clone()).await.unwrap();

        // 루틴 행 삭제 확인.
        let (r1_exists,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM routines WHERE id = ?1")
            .bind(&r1.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(r1_exists, 0, "루틴 행 삭제됨");

        // routine_checks 삭제 확인.
        let (checks_after,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM routine_checks WHERE routine_id = ?1")
                .bind(&r1.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(checks_after, 0, "routine_checks 삭제됨");

        // 미발사 알림 삭제 확인.
        let (unfired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(unfired, 0, "미발사 알림 삭제됨");

        // 발사된 알림 보존 확인.
        let (fired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NOT NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(fired, 1, "발사된 알림은 보존됨");

        // 다른 루틴(r2) 무손상 확인.
        let remaining = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, r2.id, "다른 루틴은 무손상");
    }

    /// 신규 컬럼(monthly_pattern/monthly_nth_week/duration_min) 생성→조회 라운드트립 +
    /// freq 변경 시 monthly 패턴 정리(daily면 None). listing.rs의 i64→i32/u32 매핑도 커버.
    #[tokio::test]
    async fn monthly_pattern_fields_roundtrip_and_cleanup() {
        let db = fresh_db().await;
        let r = insert_routine(
            &db,
            &CreateRoutineInput {
                title: "회고".into(),
                freq: RoutineFreq::Monthly,
                weekdays: vec![Weekday::Tue],
                anchor_date: Some("2026-05-12".into()), // day-of-month 12 → 매월 12일 due
                time_of_day: Some("09:00".into()),
                reminder_offset_min: None,
                area: None,
                kind: Some(Kind::Personal),
                monthly_pattern: Some(RoutineMonthlyPattern::NthWeekday),
                monthly_nth_week: Some(2),
                duration_min: Some(45),
            },
        )
        .await
        .unwrap();

        // 조회 라운드트립 — anchor의 day-of-month(12)에 due.
        let listed = fetch_today_routines(&db, "2026-06-12", Weekday::Fri)
            .await
            .unwrap();
        let item = listed
            .iter()
            .find(|x| x.id == r.id)
            .expect("monthly 루틴 due");
        assert_eq!(
            item.monthly_pattern,
            Some(RoutineMonthlyPattern::NthWeekday)
        );
        assert_eq!(item.monthly_nth_week, Some(2));
        assert_eq!(item.duration_min, Some(45));

        // freq monthly→daily 변경: monthly 패턴은 정리(None), duration은 freq 무관 유지.
        update_routine_inner(
            &db,
            UpdateRoutineInput {
                id: r.id.clone(),
                title: "회고".into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: Some("09:00".into()),
                reminder_offset_min: None,
                monthly_pattern: Some(RoutineMonthlyPattern::DayOfMonth), // daily면 무시돼야
                monthly_nth_week: Some(3),
                duration_min: Some(20),
            },
        )
        .await
        .unwrap();

        let after = fetch_today_routines(&db, "2026-06-12", Weekday::Fri)
            .await
            .unwrap();
        let item2 = after.iter().find(|x| x.id == r.id).expect("daily 루틴 due");
        assert_eq!(item2.monthly_pattern, None, "daily면 monthly_pattern 정리");
        assert_eq!(item2.monthly_nth_week, None, "daily면 nth_week 정리");
        assert_eq!(item2.duration_min, Some(20), "duration은 freq 무관 유지");
    }

    // ── 테스트 헬퍼 (command 본문과 동일 로직, State 없이) ──────────────────────
    async fn insert_daily(db: &Db, title: &str) -> String {
        insert_routine(
            db,
            &CreateRoutineInput {
                title: title.into(),
                freq: RoutineFreq::Daily,
                weekdays: vec![],
                anchor_date: None,
                time_of_day: None,
                reminder_offset_min: None,
                area: None,
                kind: None,
                monthly_pattern: None,
                monthly_nth_week: None,
                duration_min: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn reorder(db: &Db, ids: &[&String]) {
        let mut tx = db.begin().await.unwrap();
        for (i, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE routines SET rank = ?2 WHERE id = ?1")
                .bind(*id)
                .bind(i as i32)
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }

    async fn toggle_check(db: &Db, routine_id: &str, date: &str, done: bool) {
        if done {
            sqlx::query(
                "INSERT OR IGNORE INTO routine_checks (id, routine_id, date) \
                 VALUES (lower(hex(randomblob(16))), ?1, ?2)",
            )
            .bind(routine_id)
            .bind(date)
            .execute(db)
            .await
            .unwrap();
        }
    }

    async fn toggle_done(db: &Db, routine_id: &str, date: &str) {
        toggle_check(db, routine_id, date, true).await;
        let source_id = reminder_source_id(routine_id, date);
        sqlx::query(
            "UPDATE scheduled_notifications SET fired_at = ?2 \
             WHERE source = 'routine' AND source_id = ?1 AND fired_at IS NULL",
        )
        .bind(&source_id)
        .bind(utc_now_string())
        .execute(db)
        .await
        .unwrap();
    }
}
