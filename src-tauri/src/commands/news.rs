//! tauri-specta IPC commands — news_list_recent / news_sources_available / news_sources_set_enabled
//! + news_list_filters / news_add_filter / news_remove_filter (D-Safe).

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::news::{
    filter_store::{self, FilterMode, KeywordFilter},
    pref_store, store, NewsItem, NewsSourceMeta,
};

#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(db: State<'_, Db>, limit: u32) -> Result<Vec<NewsItem>, AppError> {
    let filters = filter_store::list(db.inner()).await?;
    store::list_recent(db.inner(), limit, &filters).await
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

#[tauri::command]
#[specta::specta]
pub async fn news_list_filters(db: State<'_, Db>) -> Result<Vec<KeywordFilter>, AppError> {
    filter_store::list(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_add_filter(
    db: State<'_, Db>,
    keyword: String,
    mode: FilterMode,
) -> Result<KeywordFilter, AppError> {
    filter_store::add(db.inner(), &keyword, mode).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_remove_filter(db: State<'_, Db>, id: i32) -> Result<(), AppError> {
    filter_store::remove(db.inner(), id).await
}
