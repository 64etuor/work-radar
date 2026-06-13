//! signal_day_placements 데이터 접근 레이어. 모든 placement SQL의 단일 소유자.
//! 스펙: docs/superpowers/specs/2026-06-12-signal-day-placements-design.md
//! dead_code allow: IPC 배선은 후속 태스크에서 추가된다.

use crate::db::Db;
use crate::models::{SignalDayPlacement, SignalTimeTotal};

/// (signal_id, date) upsert — 같은 날 재배치/이동은 같은 행 갱신(dedup upsert 관례).
pub(crate) async fn upsert_placement(
    db: &Db,
    signal_id: &str,
    date: &str,
    start_at: &str,
    duration_min: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4) \
         ON CONFLICT(signal_id, date) DO UPDATE SET \
           start_at = excluded.start_at, duration_min = excluded.duration_min, \
           updated_at = datetime('now')",
    )
    .bind(signal_id)
    .bind(date)
    .bind(start_at)
    .bind(duration_min)
    .execute(db)
    .await?;
    Ok(())
}

/// 그 날짜의 배치 제거(트레이 복귀/날짜 이동의 출발지 정리).
pub(crate) async fn delete_placement(
    db: &Db,
    signal_id: &str,
    date: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM signal_day_placements WHERE signal_id = ?1 AND date = ?2")
        .bind(signal_id)
        .bind(date)
        .execute(db)
        .await?;
    Ok(())
}

/// [start, end] inclusive 범위의 placement — 타임라인 렌더용.
pub(crate) async fn fetch_placements_in_range(
    db: &Db,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<SignalDayPlacement>, sqlx::Error> {
    sqlx::query_as::<_, SignalDayPlacement>(
        "SELECT id, signal_id, date, start_at, duration_min \
         FROM signal_day_placements WHERE date BETWEEN ?1 AND ?2 ORDER BY date, start_at",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(db)
    .await
}

/// 카드별 전체 기간 누적 시간/일수(배지용) — date 필터 없음은 의도(배지=전체 기간).
/// 전체를 반환하고 FE가 Today 레일 카드에 매핑한다.
pub(crate) async fn fetch_signal_time_totals(db: &Db) -> Result<Vec<SignalTimeTotal>, sqlx::Error> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT signal_id, SUM(duration_min), COUNT(*) \
         FROM signal_day_placements GROUP BY signal_id",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(signal_id, total, days)| SignalTimeTotal {
            signal_id,
            total_min: total.max(0) as u32,
            day_count: days.max(0) as u32,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    /// 시그널 FK 행 삽입 헬퍼 (placement FK 요건 충족).
    async fn insert_signal_row(db: &Db, id: &str) {
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) VALUES (?1, 'X', 'braindump', 'thought')",
        )
        .bind(id)
        .execute(db)
        .await
        .expect("insert signal row");
    }

    /// upsert는 (signal_id, date) 당 1행만 유지하며 재배치 시 start_at/duration_min을 갱신한다.
    #[tokio::test]
    async fn upsert_is_idempotent_per_day_and_updates_in_place() {
        let db = fresh_db().await;
        insert_signal_row(&db, "s1").await;

        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T14:00:00", 60)
            .await
            .unwrap();
        // 같은 날 재배치 — 행 수는 그대로, 값만 갱신.
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T15:00:00", 90)
            .await
            .unwrap();

        let rows = fetch_placements_in_range(&db, "2026-06-11", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "같은 날은 1행만");
        assert_eq!(rows[0].start_at, "2026-06-11T15:00:00");
        assert_eq!(rows[0].duration_min, 90);
    }

    /// 여러 날 배치의 SUM/COUNT가 올바르게 집계되고, 시그널 간 합이 섞이지 않는다
    /// (GROUP BY cross-contamination 가드).
    #[tokio::test]
    async fn totals_sum_across_days() {
        let db = fresh_db().await;
        insert_signal_row(&db, "s1").await;
        insert_signal_row(&db, "s2").await;

        upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 60)
            .await
            .unwrap();
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T10:00:00", 120)
            .await
            .unwrap();
        upsert_placement(&db, "s2", "2026-06-10", "2026-06-10T13:00:00", 30)
            .await
            .unwrap();

        let totals = fetch_signal_time_totals(&db).await.unwrap();
        assert_eq!(totals.len(), 2);
        let s1 = totals.iter().find(|t| t.signal_id == "s1").expect("s1");
        assert_eq!(s1.total_min, 180);
        assert_eq!(s1.day_count, 2);
        let s2 = totals.iter().find(|t| t.signal_id == "s2").expect("s2");
        assert_eq!(s2.total_min, 30);
        assert_eq!(s2.day_count, 1);
    }

    /// delete_placement는 지정 날짜의 행만 제거하고 다른 날짜는 보존한다.
    #[tokio::test]
    async fn delete_removes_only_that_date() {
        let db = fresh_db().await;
        insert_signal_row(&db, "s1").await;

        upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 30)
            .await
            .unwrap();
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T09:00:00", 45)
            .await
            .unwrap();

        delete_placement(&db, "s1", "2026-06-10").await.unwrap();

        let rows = fetch_placements_in_range(&db, "2026-06-10", "2026-06-11")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "6/10은 삭제, 6/11만 남아야 한다");
        assert_eq!(rows[0].date, "2026-06-11");
    }

    /// signal 삭제 시 ON DELETE CASCADE로 그 시그널의 placement 행 전체가 삭제된다.
    /// 다른 시그널의 placement는 영향받지 않음을 확인(FK CASCADE 범위 격리).
    /// signal_time_totals 설계가 의존하는 고아-안전 보증을 고정한다.
    #[tokio::test]
    async fn deleting_signal_cascade_deletes_its_placements() {
        let db = fresh_db().await;
        insert_signal_row(&db, "s1").await;
        insert_signal_row(&db, "s2").await;

        // s1 — 두 날짜에 배치.
        upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T09:00:00", 30)
            .await
            .unwrap();
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T10:00:00", 45)
            .await
            .unwrap();
        // s2 — 같은 범위에 1행 배치(CASCADE가 s1만 지워야 한다).
        upsert_placement(&db, "s2", "2026-06-10", "2026-06-10T13:00:00", 60)
            .await
            .unwrap();

        // s1 삭제 — ON DELETE CASCADE가 signal_day_placements 행도 제거해야 한다.
        sqlx::query("DELETE FROM signals WHERE id = 's1'")
            .execute(&db)
            .await
            .expect("s1 delete");

        let rows = fetch_placements_in_range(&db, "2026-06-01", "2026-06-30")
            .await
            .unwrap();
        // s1의 2행은 CASCADE로 삭제, s2의 1행만 남아야 한다.
        assert_eq!(rows.len(), 1, "s1 삭제 후 s2 placement 1행만 남아야 한다");
        assert_eq!(rows[0].signal_id, "s2", "남은 행은 s2의 것");
        assert_eq!(rows[0].date, "2026-06-10");
    }

    /// 마이그레이션 백필 SQL 의미론 검증: signals에 scheduled_at/duration이 있는 행을
    /// 정확히 매핑해 placement 행으로 만든다.
    #[tokio::test]
    async fn backfill_statement_creates_row_from_scheduled_at() {
        let db = fresh_db().await;

        // 마이그레이션은 빈 DB에 실행되므로 백필은 no-op. 여기서는 직접 시그널 행을
        // 삽입하고 마이그레이션의 백필 INSERT…SELECT를 수동으로 실행해 SQL 의미론을 검증한다.
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, scheduled_at, scheduled_duration) \
             VALUES ('s9', 'X', 'braindump', 'thought', '2026-06-10T23:45:00', 45)",
        )
        .execute(&db)
        .await
        .expect("insert signal s9");

        // 마이그레이션 파일의 백필 구문 그대로 실행.
        sqlx::query(
            "INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min) \
             SELECT lower(hex(randomblob(16))), id, substr(scheduled_at, 1, 10), scheduled_at, scheduled_duration \
               FROM signals \
              WHERE scheduled_at IS NOT NULL AND scheduled_duration IS NOT NULL",
        )
        .execute(&db)
        .await
        .expect("backfill insert");

        let rows = fetch_placements_in_range(&db, "2026-06-10", "2026-06-10")
            .await
            .unwrap();
        assert_eq!(rows.len(), 1, "백필이 placement 행을 1개 만들어야 한다");
        assert_eq!(rows[0].signal_id, "s9");
        assert_eq!(rows[0].date, "2026-06-10");
        assert_eq!(rows[0].start_at, "2026-06-10T23:45:00");
        assert_eq!(rows[0].duration_min, 45);
    }
}
