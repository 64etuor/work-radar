//! scheduled_notifications 테이블 데이터 접근 레이어(백로그 F). 모든 알림 큐 SQL의 단일 소유자.
//! generic source/source_id 계약: producer(routines/pr_radar/scheduler 커맨드)가 enqueue,
//! 백그라운드 scheduler.rs가 due→발사→mark_fired. 스키마 무변경 — 순수 데이터 접근.

use crate::commands::inbox;
use crate::db::Db;

/// 발사 시각이 도래한 미발사 알림 한 행(런타임 발사용 row shape). source/source_id는 소비처가 포커스/dedup에 쓴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DueNotification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub source_id: Option<String>,
}

/// 알림 행 INSERT(enqueue). fire_at은 'YYYY-MM-DD HH:MM:SS' UTC 문자열. 발사는 백그라운드 스케줄러.
pub(crate) async fn enqueue(
    db: &Db,
    fire_at: &str,
    title: &str,
    body: &str,
    source: &str,
    source_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
    )
    .bind(fire_at)
    .bind(title)
    .bind(body)
    .bind(source)
    .bind(source_id)
    .execute(db)
    .await?;
    inbox::mirror_notification(db, title, body, source, source_id).await?;
    Ok(())
}

/// 같은 (source, source_id) 행이 (미발사/발사 무관) 이미 있는지 — 멱등 enqueue 가드.
pub(crate) async fn exists(db: &Db, source: &str, source_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM scheduled_notifications WHERE source = ?1 AND source_id = ?2 LIMIT 1",
    )
    .bind(source)
    .bind(source_id)
    .fetch_optional(db)
    .await?;
    Ok(row.is_some())
}

/// 발사 시각 도래(fire_at <= now) + 미발사 행을 fire_at 오름차순으로(가장 먼저 예약된 것부터).
pub(crate) async fn due(db: &Db, now: &str) -> Result<Vec<DueNotification>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, title, body, source, source_id FROM scheduled_notifications \
         WHERE fired_at IS NULL AND fire_at <= ?1 ORDER BY fire_at ASC, id ASC",
    )
    .bind(now)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, title, body, source, source_id)| DueNotification {
            id,
            title,
            body,
            source,
            source_id,
        })
        .collect())
}

/// id로 발사 완료 마킹(멱등 가드 — fired_at IS NULL일 때만). 경합에서도 한 번만 발사 처리된다.
pub(crate) async fn mark_fired_by_id(db: &Db, id: &str, now: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE scheduled_notifications SET fired_at = ?2 \
         WHERE id = ?1 AND fired_at IS NULL",
    )
    .bind(id)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// (source, source_id)로 미발사 행을 발사 완료 마킹(예: 완료된 루틴 알림 skip).
pub(crate) async fn mark_fired_by_source(
    db: &Db,
    source: &str,
    source_id: &str,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE scheduled_notifications SET fired_at = ?2 \
         WHERE source = ?3 AND source_id = ?1 AND fired_at IS NULL",
    )
    .bind(source_id)
    .bind(now)
    .bind(source)
    .execute(db)
    .await?;
    Ok(())
}

/// source + source_id LIKE 패턴의 미발사 행 삭제(발사 행=히스토리 보존). 루틴 수정 시 재enqueue 준비.
pub(crate) async fn delete_unfired_by_source(
    db: &Db,
    source: &str,
    source_id_like: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM scheduled_notifications \
         WHERE source = ?2 AND source_id LIKE ?1 AND fired_at IS NULL",
    )
    .bind(source_id_like)
    .bind(source)
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wr-notifstore-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::init_db(&dir.join("t.db")).await.unwrap()
    }

    #[tokio::test]
    async fn enqueue_exists_and_due_and_fire() {
        let db = fresh_db().await;
        enqueue(
            &db,
            "2026-05-24 08:00:00",
            "t",
            "b",
            "routine",
            Some("routine:r1:2026-05-24"),
        )
        .await
        .unwrap();
        assert!(exists(&db, "routine", "routine:r1:2026-05-24")
            .await
            .unwrap());
        assert!(!exists(&db, "routine", "nope").await.unwrap());
        // 미래 행은 due 아님.
        enqueue(&db, "2999-01-01 00:00:00", "future", "b", "test", None)
            .await
            .unwrap();
        let due_now = due(&db, "2026-05-24 09:00:00").await.unwrap();
        assert_eq!(due_now.len(), 1);
        assert_eq!(due_now[0].source, "routine");
        // 발사 마킹 → due에서 빠짐.
        mark_fired_by_id(&db, &due_now[0].id, "2026-05-24 09:00:01")
            .await
            .unwrap();
        assert_eq!(due(&db, "2026-05-24 09:00:00").await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn mark_by_source_and_delete_unfired_keeps_fired() {
        let db = fresh_db().await;
        enqueue(
            &db,
            "2026-05-24 08:00:00",
            "t",
            "b",
            "routine",
            Some("routine:r1:2026-05-24"),
        )
        .await
        .unwrap();
        // by-source 발사 마킹.
        mark_fired_by_source(
            &db,
            "routine",
            "routine:r1:2026-05-24",
            "2026-05-24 08:00:01",
        )
        .await
        .unwrap();
        let (fired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NOT NULL",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(fired, 1);
        // 미발사 1 추가 → delete_unfired는 미발사만 삭제, 발사 행 보존.
        enqueue(
            &db,
            "2026-05-24 09:00:00",
            "t2",
            "b",
            "routine",
            Some("routine:r1:2026-05-25"),
        )
        .await
        .unwrap();
        delete_unfired_by_source(&db, "routine", "routine:r1:%")
            .await
            .unwrap();
        let (total,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(total, 1, "발사 행만 남음");
    }
}
