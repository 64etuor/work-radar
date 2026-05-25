//! tauri-specta IPC commands — news_list_recent / news_sources_available / news_sources_set_enabled.

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::news::{pref_store, store, NewsItem, NewsSourceMeta};

#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(db: State<'_, Db>, limit: u32) -> Result<Vec<NewsItem>, AppError> {
    store::list_recent(db.inner(), limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_sources_available(db: State<'_, Db>) -> Result<Vec<NewsSourceMeta>, AppError> {
    pref_store::list_available(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_sources_set_enabled(
    db: State<'_, Db>,
    source: String,
    enabled: bool,
) -> Result<(), AppError> {
    pref_store::set_enabled(db.inner(), &source, enabled).await
}
