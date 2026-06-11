use tauri::State;

use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::WorkSignal;

// ── 회고(retro) 뷰 (Phase 17, 로컬 read + 사람 태깅) ──────────────────────────────
// INVARIANT #1: 자동 분류 0 — impact/regret는 사람이 단다. INVARIANT #2: 외부 변경 없음.
// INVARIANT #7: 로컬 SQLite SSOT. 완료 todo는 today_done_at(로컬 날짜)로 식별한다.

/// 완료 todo 타임라인. `start`/`end`는 프런트가 보내는 로컬 날짜(YYYY-MM-DD) inclusive.
#[tauri::command]
#[specta::specta]
pub async fn list_completed(
    db: State<'_, Db>,
    start: String,
    end: String,
) -> Result<Vec<WorkSignal>, AppError> {
    signal_store::fetch_completed(db.inner(), &start, &end)
        .await
        .map_err(AppError::from)
}

// 고임팩트 태그 토글(사람 결정 — INVARIANT #1). SQL은 signal_store::set_impact.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_impact(
    db: State<'_, Db>,
    id: String,
    value: bool,
) -> Result<WorkSignal, AppError> {
    signal_store::set_impact(db.inner(), &id, value)
        .await
        .map_err(AppError::from)
}

// 후회(하지말걸) 태그 토글(사람 결정 — INVARIANT #1). SQL은 signal_store::set_regret.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_regret(
    db: State<'_, Db>,
    id: String,
    value: bool,
) -> Result<WorkSignal, AppError> {
    signal_store::set_regret(db.inner(), &id, value)
        .await
        .map_err(AppError::from)
}

// ── 보관함(archive) 뷰 (Phase 17, archived + snoozed 열람 + 복원) ─────────────────
// 새 status 없음(snooze/archive 재사용 — INVARIANT). 복원은 로컬 액션(외부 변경 0).

// 보관/미루기 열람 + 복원. signals SQL은 signal_store::fetch_archived_snoozed / restore.
#[tauri::command]
#[specta::specta]
pub async fn list_archived_snoozed(db: State<'_, Db>) -> Result<Vec<WorkSignal>, AppError> {
    signal_store::fetch_archived_snoozed(db.inner())
        .await
        .map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
pub async fn restore_signal(db: State<'_, Db>, id: String) -> Result<WorkSignal, AppError> {
    signal_store::restore(db.inner(), &id)
        .await
        .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::{
        fetch_archived_snoozed, fetch_completed, insert_signal, promote_today, restore, set_impact,
        set_quadrant, set_regret,
    };
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
        promote_today(&db, &a.id, "2026-05-20").await.unwrap();
        promote_today(&db, &b.id, "2026-05-20").await.unwrap();
        promote_today(&db, &c.id, "2026-05-01").await.unwrap();
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

        // 태깅: a=좋아요, b=싫어요.
        let ta = set_impact(&db, &a.id, true).await.unwrap();
        assert_eq!(ta.impact_high, Some(true));
        let tb = set_regret(&db, &b.id, true).await.unwrap();
        assert_eq!(tb.regret, Some(true));

        // 태깅(updated_at 갱신)이 완료 목록 순서를 바꾸지 않는다 — 정렬 키는 불변(created_at/id).
        let after_tag = fetch_completed(&db, "2026-05-16", "2026-05-22")
            .await
            .unwrap();
        assert_eq!(
            after_tag.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            completed.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            "태깅 후에도 순서 동일"
        );

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
