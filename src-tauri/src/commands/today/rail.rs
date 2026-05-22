use tauri::State;

use crate::commands::shared::SIGNAL_COLS;
use crate::db::Db;
use crate::error::AppError;
use crate::models::WorkSignal;

// ── Today 레일 (로컬 승격, Acceptance 불요 — architecture.md) ──────────────────

/// 매트릭스 카드를 Today로 승격. 로컬 액션이라 외부 변경 없음(Acceptance 불요).
/// 승격하면 매트릭스에서 빠지고(today_for_date set) 원 quadrant는 배지로 유지된다.
pub async fn promote_today_inner(db: &Db, id: &str, date: &str) -> Result<WorkSignal, sqlx::Error> {
    // 새 항목은 레일 맨 위에 (가장 작은 rank).
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_for_date = ?2, today_done_at = NULL, status = 'promoted', \
            today_rank = COALESCE((SELECT MIN(today_rank) FROM signals WHERE today_for_date IS NOT NULL), 0) - 1, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(date)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn promote_today(
    db: State<'_, Db>,
    id: String,
    date: String,
) -> Result<WorkSignal, AppError> {
    Ok(promote_today_inner(db.inner(), &id, &date).await?)
}

/// Today 승격 취소 → 원 사분면으로 복귀(없으면 미분류). 카운터 리셋.
pub async fn unpromote_today_inner(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_for_date = NULL, today_done_at = NULL, today_rank = NULL, \
            status = CASE WHEN quadrant = 'unclassified' THEN 'new' ELSE 'classified' END, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn unpromote_today(db: State<'_, Db>, id: String) -> Result<WorkSignal, AppError> {
    Ok(unpromote_today_inner(db.inner(), &id).await?)
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
    let done_at: Option<String> = if done { Some(date) } else { None };
    Ok(sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_done_at = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(done_at)
    .fetch_one(db.inner())
    .await?)
}

/// Today 레일 재정렬. ordered_ids 순서대로 today_rank 부여.
#[tauri::command]
#[specta::specta]
pub async fn reorder_today(db: State<'_, Db>, ordered_ids: Vec<String>) -> Result<(), AppError> {
    let mut tx = db.inner().begin().await?;
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE signals SET today_rank = ?2 WHERE id = ?1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await?;
    }
    Ok(tx.commit().await?)
}

/// 오늘의 Today 항목. 미완료는 매일 잔류(rollover), 완료(today_done_at=오늘)는 당일만 표시.
/// 이전 날짜에 완료된 항목은 이월되지 않으므로 제외된다. age는 프런트가 today_for_date로 계산.
pub async fn fetch_today(db: &Db, today: &str) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_for_date IS NOT NULL AND status NOT IN ('done','archived') \
           AND (today_done_at IS NULL OR today_done_at = ?1) \
         ORDER BY today_rank, today_for_date"
    ))
    .bind(today)
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_today(db: State<'_, Db>, today: String) -> Result<Vec<WorkSignal>, AppError> {
    Ok(fetch_today(db.inner(), &today).await?)
}
