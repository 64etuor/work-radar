use std::sync::Arc;

use tauri::State;
use tokio::sync::Notify;

use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::WorkSignal;

// ── Today 레일 (로컬 승격, Acceptance 불요 — architecture.md) ──────────────────

// 매트릭스 카드를 Today로 승격(로컬 액션, Acceptance 불요). SQL/설명은 signal_store::promote_today.
#[tauri::command]
#[specta::specta]
pub async fn promote_today(
    db: State<'_, Db>,
    notify: State<'_, Arc<Notify>>,
    id: String,
    date: String,
) -> Result<WorkSignal, AppError> {
    promote_today_inner(db.inner(), notify.inner(), &id, &date).await
}

pub(crate) async fn promote_today_inner(
    db: &Db,
    notify: &Arc<Notify>,
    id: &str,
    date: &str,
) -> Result<WorkSignal, AppError> {
    let signal = signal_store::promote_today(db, id, date).await?;
    notify.notify_one();
    Ok(signal)
}

// Today 승격 취소 → 원 사분면 복귀. SQL/설명은 signal_store::unpromote_today.
#[tauri::command]
#[specta::specta]
pub async fn unpromote_today(db: State<'_, Db>, id: String) -> Result<WorkSignal, AppError> {
    Ok(signal_store::unpromote_today(db.inner(), &id).await?)
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
    Ok(signal_store::toggle_today_done(db.inner(), &id, &date, done).await?)
}

/// Today 레일 재정렬. ordered_ids 순서대로 today_rank 부여.
#[tauri::command]
#[specta::specta]
pub async fn reorder_today(db: State<'_, Db>, ordered_ids: Vec<String>) -> Result<(), AppError> {
    Ok(signal_store::reorder_today(db.inner(), &ordered_ids).await?)
}

// 오늘의 Today 항목 조회. SQL/설명(rollover 규칙)은 signal_store::fetch_today.
#[tauri::command]
#[specta::specta]
pub async fn list_today(db: State<'_, Db>, today: String) -> Result<Vec<WorkSignal>, AppError> {
    Ok(signal_store::fetch_today(db.inner(), &today).await?)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tokio::sync::Notify;

    use super::promote_today_inner;
    use crate::calendar::pending_store::upsert_write;
    use crate::commands::placement_store;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn promote_today_enqueues_delete_for_same_day_linked_calendar_event() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals \
             (id, title, source, type, scheduled_at, scheduled_duration, linked_calendar_id, linked_event_id) \
             VALUES ('s1','Demo','braindump','thought','2026-05-28T10:00:00',30,'cal1','ev1')",
        )
        .execute(&db)
        .await
        .unwrap();
        placement_store::upsert_placement(&db, "s1", "2026-05-28", "2026-05-28T10:00:00", 30)
            .await
            .unwrap();
        upsert_write(
            &db,
            "patch",
            "signal",
            "s1",
            "cal1",
            Some("ev1"),
            r#"{"start":"2026-05-28T11:00:00","duration_min":45}"#,
            0,
        )
        .await
        .unwrap();

        promote_today_inner(&db, &notify, "s1", "2026-05-28")
            .await
            .unwrap();

        let rows: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
            "SELECT kind, calendar_id, event_id, payload_json \
             FROM pending_calendar_writes \
             WHERE target_kind = 'signal' AND target_id = 's1' ORDER BY kind",
        )
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "delete");
        assert_eq!(rows[0].1, "cal1");
        assert_eq!(rows[0].2.as_deref(), Some("ev1"));
        assert_eq!(rows[0].3, "{}");

        let (scheduled_at, linked_event_id): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT scheduled_at, linked_event_id FROM signals WHERE id = 's1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(scheduled_at.is_none());
        assert!(linked_event_id.is_none());
        let placements =
            placement_store::fetch_placements_in_range(&db, "2026-05-28", "2026-05-28")
                .await
                .unwrap();
        assert!(placements.is_empty());
    }

    #[tokio::test]
    async fn promote_today_cancels_pending_create_without_linked_event() {
        let db = fresh_db().await;
        let notify = Arc::new(Notify::new());
        sqlx::query(
            "INSERT INTO signals \
             (id, title, source, type, scheduled_at, scheduled_duration, linked_calendar_id) \
             VALUES ('s1','Demo','braindump','thought','2026-05-28T10:00:00',30,'cal1')",
        )
        .execute(&db)
        .await
        .unwrap();
        upsert_write(
            &db,
            "create",
            "signal",
            "s1",
            "cal1",
            None,
            r#"{"title":"Demo","start":"2026-05-28T10:00:00","duration_min":30}"#,
            0,
        )
        .await
        .unwrap();

        promote_today_inner(&db, &notify, "s1", "2026-05-28")
            .await
            .unwrap();

        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pending_calendar_writes \
             WHERE target_kind = 'signal' AND target_id = 's1'",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            pending, 0,
            "Today 승격은 link-back 전 pending create도 취소해야 한다"
        );

        let (scheduled_at, linked_calendar_id): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT scheduled_at, linked_calendar_id FROM signals WHERE id = 's1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert!(scheduled_at.is_none());
        assert!(linked_calendar_id.is_none());
    }
}
