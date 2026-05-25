//! tauri-specta IPC commands — news_list_recent / news_sources_available / news_sources_set_enabled
//! + news_list_filters / news_add_filter / news_remove_filter (D-Safe)
//! + news_get_options / news_set_options (D-Tune).

use tauri::State;

use crate::db::Db;
use crate::error::AppError;
use crate::news::{
    fetcher::OptionsNotify,
    filter_store::{self, FilterMode, KeywordFilter},
    options_store::{self, NewsOptions},
    pref_store, store, NewsItem, NewsSourceMeta,
};

#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(db: State<'_, Db>) -> Result<Vec<NewsItem>, AppError> {
    // limit 인자 제거 — opts에서 가져옴(breaking IPC).
    let opts = options_store::get(db.inner()).await?;
    let filters = filter_store::list(db.inner()).await?;
    store::list_recent(db.inner(), &opts, &filters).await
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

#[tauri::command]
#[specta::specta]
pub async fn news_get_options(db: State<'_, Db>) -> Result<NewsOptions, AppError> {
    options_store::get(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_set_options(
    db: State<'_, Db>,
    notify: State<'_, OptionsNotify>,
    options: NewsOptions,
) -> Result<(), AppError> {
    options_store::set(db.inner(), &options).await?;
    notify.notify_one(); // fetcher 즉시 깨움 → 옵션 재읽기 → interval 재구성.
    Ok(())
}
