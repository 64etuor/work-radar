//! timeline_notes 테이블 데이터 접근 + IPC 커맨드.
//! Today 타임라인 카드(signal/routine/event) 각각에 메모 1개 — PK (target_kind, target_id, date).
//! 외부 mutate 없음(로컬 액션) → Acceptance 게이트 불요(INVARIANT #2).
//!
//! 패턴: `*_inner(&Db, ...)` 헬퍼에 모든 SQL을 모으고, `#[tauri::command]`는 `State<Db>`만 풀어
//! 헬퍼로 위임. 테스트는 헬퍼를 직접 호출(inbox.rs 선례).

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::models::{TimelineNote, TimelineNoteTarget};

// ─ 내부 헬퍼(테스트가 호출하는 정본) ───────────────────────────────────

pub(crate) async fn get_inner(
    db: &Db,
    target_kind: TimelineNoteTarget,
    target_id: &str,
    date: &str,
) -> Result<Option<TimelineNote>, sqlx::Error> {
    sqlx::query_as(
        "SELECT target_kind, target_id, date, body, created_at, updated_at \
         FROM timeline_notes \
         WHERE target_kind = ?1 AND target_id = ?2 AND date = ?3",
    )
    .bind(target_kind)
    .bind(target_id)
    .bind(date)
    .fetch_optional(db)
    .await
}

pub(crate) async fn list_for_date_inner(
    db: &Db,
    date: &str,
) -> Result<Vec<TimelineNote>, sqlx::Error> {
    sqlx::query_as(
        "SELECT target_kind, target_id, date, body, created_at, updated_at \
         FROM timeline_notes \
         WHERE date = ?1 ORDER BY target_kind, target_id",
    )
    .bind(date)
    .fetch_all(db)
    .await
}

pub(crate) async fn upsert_inner(
    db: &Db,
    target_kind: TimelineNoteTarget,
    target_id: &str,
    date: &str,
    body: &str,
) -> Result<Option<TimelineNote>, sqlx::Error> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        delete_inner(db, target_kind, target_id, date).await?;
        return Ok(None);
    }
    sqlx::query(
        "INSERT INTO timeline_notes (target_kind, target_id, date, body) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(target_kind, target_id, date) DO UPDATE SET \
           body = excluded.body, \
           updated_at = datetime('now')",
    )
    .bind(target_kind)
    .bind(target_id)
    .bind(date)
    .bind(trimmed)
    .execute(db)
    .await?;
    get_inner(db, target_kind, target_id, date).await
}

pub(crate) async fn delete_inner(
    db: &Db,
    target_kind: TimelineNoteTarget,
    target_id: &str,
    date: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM timeline_notes \
         WHERE target_kind = ?1 AND target_id = ?2 AND date = ?3",
    )
    .bind(target_kind)
    .bind(target_id)
    .bind(date)
    .execute(db)
    .await?;
    Ok(())
}

// ─ IPC 커맨드(얇은 위임) ───────────────────────────────────────────────

/// 단일 메모 조회. 없으면 None.
#[tauri::command]
#[specta::specta]
pub async fn get_timeline_note(
    db: State<'_, Db>,
    target_kind: TimelineNoteTarget,
    target_id: String,
    date: String,
) -> Result<Option<TimelineNote>, AppError> {
    Ok(get_inner(db.inner(), target_kind, &target_id, &date).await?)
}

/// 한 날짜의 모든 메모 일괄 조회(Today 마운트 시 1회 호출 — N+1 회피).
#[tauri::command]
#[specta::specta]
pub async fn list_timeline_notes_for_date(
    db: State<'_, Db>,
    date: String,
) -> Result<Vec<TimelineNote>, AppError> {
    Ok(list_for_date_inner(db.inner(), &date).await?)
}

/// 메모 upsert. body trim 결과가 비면 행을 삭제하고 None 반환(=메모 클리어).
#[tauri::command]
#[specta::specta]
pub async fn upsert_timeline_note(
    db: State<'_, Db>,
    target_kind: TimelineNoteTarget,
    target_id: String,
    date: String,
    body: String,
) -> Result<Option<TimelineNote>, AppError> {
    Ok(upsert_inner(db.inner(), target_kind, &target_id, &date, &body).await?)
}

/// 메모 명시적 삭제(빈 body upsert와 동등하지만 의도 분리용).
#[tauri::command]
#[specta::specta]
pub async fn delete_timeline_note(
    db: State<'_, Db>,
    target_kind: TimelineNoteTarget,
    target_id: String,
    date: String,
) -> Result<(), AppError> {
    delete_inner(db.inner(), target_kind, &target_id, &date).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// per-call AtomicU64 — macOS coarse 클록에서 같은 ns로 떨어져 DB lock 충돌나는 것 방지
    /// (data-layer-conventions.md "Stage timeout / test isolation").
    async fn fresh_db() -> Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("wr-tlnotes-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        crate::db::init_db(&dir.join("t.db"))
            .await
            .expect("init db")
    }

    #[tokio::test]
    async fn upsert_then_get_roundtrip() {
        let db = fresh_db().await;
        let note = upsert_inner(
            &db,
            TimelineNoteTarget::Signal,
            "sig-1",
            "2026-05-28",
            "  hello world  ",
        )
        .await
        .expect("upsert")
        .expect("non-empty body returns row");
        assert_eq!(note.body, "hello world");
        assert!(matches!(note.target_kind, TimelineNoteTarget::Signal));

        let fetched = get_inner(&db, TimelineNoteTarget::Signal, "sig-1", "2026-05-28")
            .await
            .expect("get")
            .expect("row present");
        assert_eq!(fetched.body, "hello world");
    }

    #[tokio::test]
    async fn empty_body_clears_row() {
        let db = fresh_db().await;
        upsert_inner(
            &db,
            TimelineNoteTarget::Routine,
            "rt-1",
            "2026-05-28",
            "first",
        )
        .await
        .expect("seed");

        let after = upsert_inner(
            &db,
            TimelineNoteTarget::Routine,
            "rt-1",
            "2026-05-28",
            "   ",
        )
        .await
        .expect("clear");
        assert!(after.is_none());

        let fetched = get_inner(&db, TimelineNoteTarget::Routine, "rt-1", "2026-05-28")
            .await
            .expect("get after clear");
        assert!(fetched.is_none());
    }

    #[tokio::test]
    async fn list_by_date_groups_targets() {
        let db = fresh_db().await;
        upsert_inner(&db, TimelineNoteTarget::Signal, "sig-2", "2026-05-28", "a")
            .await
            .expect("seed signal");
        upsert_inner(
            &db,
            TimelineNoteTarget::Event,
            "cal-1:evt-1",
            "2026-05-28",
            "b",
        )
        .await
        .expect("seed event");
        upsert_inner(
            &db,
            TimelineNoteTarget::Signal,
            "sig-2",
            "2026-05-29",
            "other-day",
        )
        .await
        .expect("seed other-day");

        let rows = list_for_date_inner(&db, "2026-05-28").await.expect("list");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.target_id == "sig-2" && r.body == "a"));
        assert!(rows
            .iter()
            .any(|r| r.target_id == "cal-1:evt-1" && r.body == "b"));
    }
}
