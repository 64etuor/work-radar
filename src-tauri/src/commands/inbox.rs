//! Unified Inbox store + IPC commands.
//!
//! Inbox is local operational memory: alerts, AI escalations, workflow failures,
//! review requests, reminders, and native-notification mirrors. It does not
//! mutate external systems or matrix decisions.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{InboxCounts, InboxItem};

pub(crate) struct NewInboxItem<'a> {
    pub project_id: Option<&'a str>,
    pub source: &'a str,
    pub source_id: Option<&'a str>,
    pub group_key: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
    pub summary: Option<&'a str>,
    pub priority: &'a str,
    pub severity: &'a str,
    pub related_entity_type: Option<&'a str>,
    pub related_entity_id: Option<&'a str>,
    pub action_payload: Option<&'a str>,
}

/// Upsert by (source, source_id) when source_id exists; otherwise insert a new
/// item. Existing unread/dismissed state is intentionally reset for fresh
/// source events so recurrent operational alerts surface again.
pub(crate) async fn upsert_inbox_item(db: &Db, item: NewInboxItem<'_>) -> Result<(), sqlx::Error> {
    if let Some(source_id) = item.source_id {
        sqlx::query(
            "INSERT INTO inbox_items \
             (id, project_id, source, source_id, group_key, title, body, summary, priority, severity, \
              related_entity_type, related_entity_id, action_payload) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
             ON CONFLICT(source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET \
               project_id=excluded.project_id, group_key=excluded.group_key, title=excluded.title, \
               body=excluded.body, summary=excluded.summary, priority=excluded.priority, \
               severity=excluded.severity, status='open', unread=1, read_at=NULL, dismissed_at=NULL, \
               related_entity_type=excluded.related_entity_type, \
               related_entity_id=excluded.related_entity_id, action_payload=excluded.action_payload, \
               updated_at=datetime('now')",
        )
        .bind(item.project_id)
        .bind(item.source)
        .bind(source_id)
        .bind(item.group_key)
        .bind(item.title)
        .bind(item.body)
        .bind(item.summary)
        .bind(item.priority)
        .bind(item.severity)
        .bind(item.related_entity_type)
        .bind(item.related_entity_id)
        .bind(item.action_payload)
        .execute(db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO inbox_items \
             (id, project_id, source, group_key, title, body, summary, priority, severity, \
              related_entity_type, related_entity_id, action_payload) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .bind(item.project_id)
        .bind(item.source)
        .bind(item.group_key)
        .bind(item.title)
        .bind(item.body)
        .bind(item.summary)
        .bind(item.priority)
        .bind(item.severity)
        .bind(item.related_entity_type)
        .bind(item.related_entity_id)
        .bind(item.action_payload)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Upsert by source id without resurfacing an already read/dismissed row. Polling
/// producers use this so a stable condition does not become unread every cycle.
pub(crate) async fn upsert_inbox_item_quiet(
    db: &Db,
    item: NewInboxItem<'_>,
) -> Result<(), sqlx::Error> {
    let Some(source_id) = item.source_id else {
        return upsert_inbox_item(db, item).await;
    };
    sqlx::query(
        "INSERT INTO inbox_items \
         (id, project_id, source, source_id, group_key, title, body, summary, priority, severity, \
          related_entity_type, related_entity_id, action_payload) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(source, source_id) WHERE source_id IS NOT NULL DO UPDATE SET \
           project_id=excluded.project_id, group_key=excluded.group_key, title=excluded.title, \
           body=excluded.body, summary=excluded.summary, priority=excluded.priority, \
           severity=excluded.severity, related_entity_type=excluded.related_entity_type, \
           related_entity_id=excluded.related_entity_id, action_payload=excluded.action_payload, \
           updated_at=datetime('now')",
    )
    .bind(item.project_id)
    .bind(item.source)
    .bind(source_id)
    .bind(item.group_key)
    .bind(item.title)
    .bind(item.body)
    .bind(item.summary)
    .bind(item.priority)
    .bind(item.severity)
    .bind(item.related_entity_type)
    .bind(item.related_entity_id)
    .bind(item.action_payload)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn unread_alert_exists(
    db: &Db,
    source: &str,
    source_ids: &[String],
) -> Result<bool, sqlx::Error> {
    for source_id in source_ids {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT 1 FROM inbox_items \
             WHERE source=?1 AND source_id=?2 AND unread=1 AND status != 'dismissed' LIMIT 1",
        )
        .bind(source)
        .bind(source_id)
        .fetch_optional(db)
        .await?;
        if row.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) async fn mirror_notification(
    db: &Db,
    title: &str,
    body: &str,
    source: &str,
    source_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mirror_id = source_id
        .map(|id| format!("notification:{source}:{id}"))
        .or_else(|| Some(format!("notification:{source}:{title}")));
    upsert_inbox_item(
        db,
        NewInboxItem {
            project_id: None,
            source: "notification",
            source_id: mirror_id.as_deref(),
            group_key: Some("notification"),
            title,
            body,
            summary: None,
            priority: "normal",
            severity: "info",
            related_entity_type: Some(source),
            related_entity_id: source_id,
            action_payload: None,
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_inbox_items(
    db: State<'_, Db>,
    source: Option<String>,
    include_dismissed: bool,
) -> Result<Vec<InboxItem>, AppError> {
    let rows: Vec<InboxItem> = sqlx::query_as(
        "SELECT id, project_id, source, source_id, group_key, title, body, summary, priority, severity, \
         status, unread, related_entity_type, related_entity_id, action_payload, read_at, dismissed_at, \
         created_at, updated_at \
         FROM inbox_items \
         WHERE (?1 IS NULL OR source = ?1) \
           AND (?2 = 1 OR status != 'dismissed') \
         ORDER BY unread DESC, \
           CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'success' THEN 2 ELSE 3 END, \
           updated_at DESC, id DESC \
         LIMIT 200",
    )
    .bind(source)
    .bind(if include_dismissed { 1 } else { 0 })
    .fetch_all(db.inner())
    .await?;
    Ok(rows)
}

#[tauri::command]
#[specta::specta]
pub async fn inbox_counts(db: State<'_, Db>) -> Result<InboxCounts, AppError> {
    let (unread, critical, open): (i64, i64, i64) = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(CASE WHEN unread = 1 AND status != 'dismissed' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN severity = 'critical' AND status != 'dismissed' THEN 1 ELSE 0 END), 0), \
           COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) \
         FROM inbox_items",
    )
    .fetch_one(db.inner())
    .await?;
    Ok(InboxCounts {
        unread: unread.max(0) as u32,
        critical: critical.max(0) as u32,
        open: open.max(0) as u32,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn mark_inbox_item_read(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE inbox_items SET unread=0, status=CASE WHEN status='open' THEN 'read' ELSE status END, \
         read_at=COALESCE(read_at, datetime('now')), updated_at=datetime('now') WHERE id=?1",
    )
    .bind(id)
    .execute(db.inner())
    .await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn dismiss_inbox_item(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE inbox_items SET unread=0, status='dismissed', dismissed_at=datetime('now'), \
         updated_at=datetime('now') WHERE id=?1",
    )
    .bind(id)
    .execute(db.inner())
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wr-inbox-{nanos}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        crate::db::init_db(&dir.join("t.db"))
            .await
            .expect("init db")
    }

    #[tokio::test]
    async fn upsert_resurfaces_existing_alert() {
        let db = fresh_db().await;
        let item = NewInboxItem {
            project_id: None,
            source: "pr_radar",
            source_id: Some("pr:repo:1:comments"),
            group_key: Some("pr:repo:1"),
            title: "PR needs attention",
            body: "11 comments",
            summary: None,
            priority: "high",
            severity: "warning",
            related_entity_type: Some("pr"),
            related_entity_id: Some("repo#1"),
            action_payload: None,
        };
        upsert_inbox_item(&db, item).await.expect("insert inbox");
        let (id,): (String,) = sqlx::query_as("SELECT id FROM inbox_items")
            .fetch_one(&db)
            .await
            .expect("read id");
        sqlx::query("UPDATE inbox_items SET status='dismissed', unread=0 WHERE id=?1")
            .bind(&id)
            .execute(&db)
            .await
            .expect("dismiss");

        upsert_inbox_item(
            &db,
            NewInboxItem {
                project_id: None,
                source: "pr_radar",
                source_id: Some("pr:repo:1:comments"),
                group_key: Some("pr:repo:1"),
                title: "PR still needs attention",
                body: "12 comments",
                summary: None,
                priority: "urgent",
                severity: "critical",
                related_entity_type: Some("pr"),
                related_entity_id: Some("repo#1"),
                action_payload: None,
            },
        )
        .await
        .expect("upsert inbox");

        let (count, status, unread, severity): (i64, String, i64, String) =
            sqlx::query_as("SELECT COUNT(*), status, unread, severity FROM inbox_items")
                .fetch_one(&db)
                .await
                .expect("read inbox");
        assert_eq!(count, 1);
        assert_eq!(status, "open");
        assert_eq!(unread, 1);
        assert_eq!(severity, "critical");
    }
}
