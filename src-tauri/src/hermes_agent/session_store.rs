//! hermes_session / hermes_message 데이터 접근 + IPC 커맨드.
//! 패턴: `*_inner(&Db, ...)` 헬퍼에 SQL을 모으고 `#[tauri::command]`는 State<Db>만 풀어 위임
//! (timeline_notes.rs 선례). 외부 mutate 없음 → Acceptance 게이트 불요(로컬 액션).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::db::Db;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
pub struct HermesSessionRow {
    pub id: String,
    pub name: String,
    pub status: String,
    pub cwd: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_active_at: String,
    #[sqlx(try_from = "i64")]
    pub archived: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
pub struct HermesMessageRow {
    /// i64 → i32로 좁혀 IPC 노출(specta i64 금지). 실사용에서 메시지 id가 2^31을 넘지 않음.
    #[sqlx(try_from = "i64")]
    pub id: i32,
    pub session_id: String,
    #[sqlx(try_from = "i64")]
    pub seq: i32,
    pub role: String,
    pub content: String,
    pub tool_json: Option<String>,
    pub created_at: String,
}

// ─ inner 헬퍼 ─────────────────────────────────────────────────────────────

pub(crate) async fn create_inner(
    db: &Db,
    id: &str,
    name: &str,
) -> Result<HermesSessionRow, sqlx::Error> {
    sqlx::query("INSERT INTO hermes_session (id, name) VALUES (?1, ?2)")
        .bind(id)
        .bind(name)
        .execute(db)
        .await?;
    get_inner(db, id).await.map(|o| o.expect("just inserted"))
}

pub(crate) async fn get_inner(db: &Db, id: &str) -> Result<Option<HermesSessionRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, name, status, cwd, created_at, updated_at, last_active_at, archived \
         FROM hermes_session WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub(crate) async fn list_inner(db: &Db) -> Result<Vec<HermesSessionRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, name, status, cwd, created_at, updated_at, last_active_at, archived \
         FROM hermes_session WHERE archived = 0 ORDER BY last_active_at DESC",
    )
    .fetch_all(db)
    .await
}

pub(crate) async fn rename_inner(db: &Db, id: &str, name: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE hermes_session SET name = ?2, updated_at = datetime('now') WHERE id = ?1")
        .bind(id)
        .bind(name)
        .execute(db)
        .await?;
    Ok(())
}

pub(crate) async fn archive_inner(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE hermes_session SET archived = 1, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn delete_inner(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM hermes_message WHERE session_id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM hermes_session WHERE id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// 메시지 1개 append. seq = 해당 세션 현재 max(seq)+1 (없으면 0). last_active_at/updated_at 갱신.
/// 반환 = 부여된 seq (i32).
pub(crate) async fn append_inner(
    db: &Db,
    session_id: &str,
    role: &str,
    content: &str,
    tool_json: Option<&str>,
) -> Result<i32, sqlx::Error> {
    let mut tx = db.begin().await?;
    let next_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq) + 1, 0) FROM hermes_message WHERE session_id = ?1",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO hermes_message (session_id, seq, role, content, tool_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(session_id)
    .bind(next_seq)
    .bind(role)
    .bind(content)
    .bind(tool_json)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE hermes_session SET updated_at = datetime('now'), \
         last_active_at = datetime('now') WHERE id = ?1",
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(next_seq as i32)
}

pub(crate) async fn messages_inner(
    db: &Db,
    session_id: &str,
) -> Result<Vec<HermesMessageRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, session_id, seq, role, content, tool_json, created_at \
         FROM hermes_message WHERE session_id = ?1 ORDER BY seq ASC",
    )
    .bind(session_id)
    .fetch_all(db)
    .await
}

// ─ IPC 커맨드(얇은 위임) ───────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn hermes_sessions_list(db: State<'_, Db>) -> Result<Vec<HermesSessionRow>, AppError> {
    Ok(list_inner(db.inner()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_create(
    db: State<'_, Db>,
    id: String,
    name: String,
) -> Result<HermesSessionRow, AppError> {
    Ok(create_inner(db.inner(), &id, &name).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_rename(
    db: State<'_, Db>,
    id: String,
    name: String,
) -> Result<(), AppError> {
    rename_inner(db.inner(), &id, &name).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_archive(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    archive_inner(db.inner(), &id).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_delete(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_inner(db.inner(), &id).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_messages(
    db: State<'_, Db>,
    id: String,
) -> Result<Vec<HermesMessageRow>, AppError> {
    Ok(messages_inner(db.inner(), &id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_message_append(
    db: State<'_, Db>,
    session_id: String,
    role: String,
    content: String,
    tool_json: Option<String>,
) -> Result<i32, AppError> {
    Ok(append_inner(
        db.inner(),
        &session_id,
        &role,
        &content,
        tool_json.as_deref(),
    )
    .await?)
}

// ─ 단위 테스트 ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("wr-hermes-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        crate::db::init_db(&dir.join("t.db"))
            .await
            .expect("init db")
    }

    #[tokio::test]
    async fn create_then_list_roundtrip() {
        let db = fresh_db().await;
        let row = create_inner(&db, "sess-1", "첫 세션")
            .await
            .expect("create");
        assert_eq!(row.id, "sess-1");
        assert_eq!(row.name, "첫 세션");
        assert_eq!(row.archived, 0_i32);

        let list = list_inner(&db).await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "sess-1");
    }

    #[tokio::test]
    async fn rename_archive_hide_from_list() {
        let db = fresh_db().await;
        create_inner(&db, "s1", "a").await.expect("create");
        rename_inner(&db, "s1", "b").await.expect("rename");
        assert_eq!(
            get_inner(&db, "s1").await.expect("get").expect("row").name,
            "b"
        );

        archive_inner(&db, "s1").await.expect("archive");
        assert_eq!(list_inner(&db).await.expect("list").len(), 0);
    }

    #[tokio::test]
    async fn append_messages_increment_seq_and_cascade_delete() {
        let db = fresh_db().await;
        create_inner(&db, "s1", "a").await.expect("create");
        let seq0 = append_inner(&db, "s1", "user", "hi", None)
            .await
            .expect("a0");
        let seq1 = append_inner(&db, "s1", "assistant", "yo", None)
            .await
            .expect("a1");
        assert_eq!(seq0, 0);
        assert_eq!(seq1, 1);

        let msgs = messages_inner(&db, "s1").await.expect("messages");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].seq, 1);

        delete_inner(&db, "s1").await.expect("delete");
        assert!(get_inner(&db, "s1").await.expect("get").is_none());
        assert_eq!(messages_inner(&db, "s1").await.expect("messages").len(), 0);
    }
}
