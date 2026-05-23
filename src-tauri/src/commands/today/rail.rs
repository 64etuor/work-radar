use tauri::State;

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
    id: String,
    date: String,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::promote_today(db.inner(), &id, &date).await?)
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
