use tauri::State;

use crate::commands::shared::SIGNAL_COLS;
use crate::db::Db;
use crate::error::AppError;
use crate::models::WorkSignal;

// ── 회고(retro) 뷰 (Phase 17, 로컬 read + 사람 태깅) ──────────────────────────────
// INVARIANT #1: 자동 분류 0 — impact/regret는 사람이 단다. INVARIANT #2: 외부 변경 없음.
// INVARIANT #7: 로컬 SQLite SSOT. 완료 todo는 today_done_at(로컬 날짜)로 식별한다.

/// [start,end] 범위(로컬 날짜 inclusive) 안에서 완료된 Today 항목. 완료일 내림차순 타임라인.
/// today_done_at은 이미 로컬 날짜(YYYY-MM-DD)로 저장되므로 'localtime' 변환이 필요 없다.
pub async fn fetch_completed(
    db: &Db,
    start: &str,
    end: &str,
) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_done_at IS NOT NULL AND today_done_at BETWEEN ?1 AND ?2 \
         ORDER BY today_done_at DESC, updated_at DESC"
    ))
    .bind(start)
    .bind(end)
    .fetch_all(db)
    .await
}

/// 완료 todo 타임라인. `start`/`end`는 프런트가 보내는 로컬 날짜(YYYY-MM-DD) inclusive.
#[tauri::command]
#[specta::specta]
pub async fn list_completed(
    db: State<'_, Db>,
    start: String,
    end: String,
) -> Result<Vec<WorkSignal>, AppError> {
    fetch_completed(db.inner(), &start, &end)
        .await
        .map_err(AppError::from)
}

/// 고임팩트 태그 토글(사람 결정 — INVARIANT #1). quadrant/status는 건드리지 않는다.
pub async fn set_impact(db: &Db, id: &str, value: bool) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET impact_high = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(value)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_signal_impact(
    db: State<'_, Db>,
    id: String,
    value: bool,
) -> Result<WorkSignal, AppError> {
    set_impact(db.inner(), &id, value)
        .await
        .map_err(AppError::from)
}

/// 후회(하지말걸) 태그 토글(사람 결정 — INVARIANT #1).
pub async fn set_regret(db: &Db, id: &str, value: bool) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET regret = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(value)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn set_signal_regret(
    db: State<'_, Db>,
    id: String,
    value: bool,
) -> Result<WorkSignal, AppError> {
    set_regret(db.inner(), &id, value)
        .await
        .map_err(AppError::from)
}

// ── 보관함(archive) 뷰 (Phase 17, archived + snoozed 열람 + 복원) ─────────────────
// 새 status 없음(snooze/archive 재사용 — INVARIANT). 복원은 로컬 액션(외부 변경 0).

/// 보관/미루기된 신호 열람. archived + snoozed를 한 목록으로(updated_at 내림차순).
pub async fn fetch_archived_snoozed(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE status IN ('archived','snoozed') \
         ORDER BY updated_at DESC"
    ))
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_archived_snoozed(db: State<'_, Db>) -> Result<Vec<WorkSignal>, AppError> {
    fetch_archived_snoozed(db.inner())
        .await
        .map_err(AppError::from)
}

/// 신호 복원(사람 결정 — INVARIANT #1). archived → unclassified(new). snoozed → 원 사분면 복귀
/// (quadrant=unclassified면 new, 아니면 classified). snooze_until은 비운다. quadrant는 보존(자동 분류 0).
pub async fn restore(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET \
            status = CASE WHEN quadrant = 'unclassified' THEN 'new' ELSE 'classified' END, \
            snooze_until = NULL, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn restore_signal(db: State<'_, Db>, id: String) -> Result<WorkSignal, AppError> {
    restore(db.inner(), &id).await.map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signals::{insert_signal, set_quadrant};
    use crate::commands::today::promote_today_inner;
    use crate::models::{Kind, Quadrant, SignalStatus};

    /// 완료 todo는 today_done_at 범위로 잡히고, impact/regret 태깅이 라운드트립된다.
    #[tokio::test]
    async fn completed_in_range_with_impact_regret_tagging() {
        let db = fresh_db().await;
        let a = insert_signal(&db, &input("데모 리허설", Some(Kind::Work)))
            .await
            .unwrap();
        let b = insert_signal(&db, &input("불필요한 회의", Some(Kind::Work)))
            .await
            .unwrap();
        let c = insert_signal(&db, &input("범위 밖 완료", None))
            .await
            .unwrap();
        promote_today_inner(&db, &a.id, "2026-05-20").await.unwrap();
        promote_today_inner(&db, &b.id, "2026-05-20").await.unwrap();
        promote_today_inner(&db, &c.id, "2026-05-01").await.unwrap();
        // 완료일 설정.
        for (id, done_at) in [
            (&a.id, "2026-05-20"),
            (&b.id, "2026-05-21"),
            (&c.id, "2026-05-01"),
        ] {
            sqlx::query("UPDATE signals SET today_done_at = ?2 WHERE id = ?1")
                .bind(id)
                .bind(done_at)
                .execute(&db)
                .await
                .unwrap();
        }

        let completed = fetch_completed(&db, "2026-05-16", "2026-05-22")
            .await
            .unwrap();
        assert_eq!(completed.len(), 2, "범위 내 완료 2건(c는 범위 밖 제외)");
        assert_eq!(completed[0].id, b.id, "완료일 내림차순(b=21 먼저)");

        // 태깅: a=고임팩트, b=후회.
        let ta = set_impact(&db, &a.id, true).await.unwrap();
        assert_eq!(ta.impact_high, Some(true));
        let tb = set_regret(&db, &b.id, true).await.unwrap();
        assert_eq!(tb.regret, Some(true));

        // 토글 off도 동작.
        let ta2 = set_impact(&db, &a.id, false).await.unwrap();
        assert_eq!(ta2.impact_high, Some(false));
    }

    /// archived + snoozed가 한 목록으로 열람되고, 복원은 원 사분면(또는 미분류)으로 되돌린다.
    #[tokio::test]
    async fn archive_browse_and_restore() {
        let db = fresh_db().await;
        let arch = insert_signal(&db, &input("보관된 생각", None))
            .await
            .unwrap();
        let snoo = insert_signal(&db, &input("미룬 q2 작업", Some(Kind::Work)))
            .await
            .unwrap();
        let active = insert_signal(&db, &input("활성 작업", None)).await.unwrap();

        // arch=archived, snoo=q2 분류 후 snooze.
        sqlx::query("UPDATE signals SET status = 'archived' WHERE id = ?1")
            .bind(&arch.id)
            .execute(&db)
            .await
            .unwrap();
        set_quadrant(&db, &snoo.id, Quadrant::Q2Schedule)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE signals SET status = 'snoozed', snooze_until = '2026-06-01' WHERE id = ?1",
        )
        .bind(&snoo.id)
        .execute(&db)
        .await
        .unwrap();
        let _ = active;

        let list = fetch_archived_snoozed(&db).await.unwrap();
        assert_eq!(list.len(), 2, "archived + snoozed만(active 제외)");

        // archived 복원 → unclassified/new.
        let r1 = restore(&db, &arch.id).await.unwrap();
        assert!(matches!(r1.status, SignalStatus::New));
        assert!(matches!(r1.quadrant, Quadrant::Unclassified));

        // snoozed 복원 → 원 사분면(q2)/classified, snooze_until 비움.
        let r2 = restore(&db, &snoo.id).await.unwrap();
        assert!(matches!(r2.status, SignalStatus::Classified));
        assert!(
            matches!(r2.quadrant, Quadrant::Q2Schedule),
            "원 사분면 보존"
        );
        assert!(r2.snooze_until.is_none(), "snooze_until 비움");

        // 복원 후 목록엔 둘 다 빠진다.
        assert!(fetch_archived_snoozed(&db).await.unwrap().is_empty());
    }
}
