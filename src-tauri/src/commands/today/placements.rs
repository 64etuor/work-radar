use tauri::State;

use crate::commands::placement_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{SignalDayPlacement, SignalTimeTotal};

/// [start_date, end_date] inclusive 범위의 날짜별 배치 — 타임라인 렌더용 (read only).
#[tauri::command]
#[specta::specta]
pub async fn list_signal_placements(
    db: State<'_, Db>,
    start_date: String,
    end_date: String,
) -> Result<Vec<SignalDayPlacement>, AppError> {
    Ok(placement_store::fetch_placements_in_range(db.inner(), &start_date, &end_date).await?)
}

/// 카드별 누적 배치 시간/일수 — Today 카드 배지용 (read only).
#[tauri::command]
#[specta::specta]
pub async fn signal_time_totals(db: State<'_, Db>) -> Result<Vec<SignalTimeTotal>, AppError> {
    Ok(placement_store::fetch_signal_time_totals(db.inner()).await?)
}
