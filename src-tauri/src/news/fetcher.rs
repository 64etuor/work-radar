//! 15분 주기 background fetcher.
//! - scheduler.rs 패턴 답습(`tokio::time::interval` 고정 간격, busy-loop 없음).
//! - 페치당 최대 3회 지수 백오프 + jitter, 모두 실패 시 `news_fetch_failed` 이벤트 발행.
//! - 성공 시 `news_items_updated` 이벤트.
//! - tick 시작에서 7일 만료 cleanup 수행.
//!
//! 스폰은 `tauri::async_runtime::spawn`(scheduler.rs와 동일) — macOS main 스레드의 setup()에서
//! `tokio::spawn`은 "no reactor running" 패닉을 일으킴.

use std::time::Duration;

use rand::RngExt;
use reqwest::Client;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};

use super::{pref_store, registry, store, NewsItem, NewsSource};
use crate::db::Db;
use crate::error::AppError;

const TICK: Duration = Duration::from_secs(15 * 60);
const REQ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;
const INITIAL_DELAY_MS: u64 = 500;
const MAX_DELAY_MS: u64 = 10_000;
const JITTER_MAX_MS: u64 = 200;

#[derive(Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewsFetchFailed {
    pub source: String,
    pub error: String,
}

/// setup hook에서 호출. scheduler.rs와 동일 패턴(tauri::async_runtime::spawn).
pub fn spawn_loop(db: Db, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = match Client::builder()
            .timeout(REQ_TIMEOUT)
            .user_agent("work-radar/news-fetcher")
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "news fetcher client build failed; aborting");
                return;
            }
        };
        let mut ticker = tokio::time::interval(TICK);
        // 최초 즉시 실행(`tokio::time::interval` 첫 tick은 즉시 반환) + 이후 15분 주기.
        loop {
            ticker.tick().await;
            if let Err(e) = tick(&db, &app, &client).await {
                tracing::warn!(error = %e, "news fetcher tick failed");
            }
        }
    });
}

async fn tick(db: &Db, app: &AppHandle, client: &Client) -> Result<(), AppError> {
    let _ = store::purge_expired(db).await; // 실패 무시(다음 tick 재시도)
    let enabled = pref_store::enabled_ids(db).await?;
    if enabled.is_empty() {
        return Ok(());
    }

    // 소스별 격리: 한 소스의 fetch/upsert 실패가 나머지 소스 페치를 막지 않는다.
    // (critic Major #3) `?`로 조기 이탈하면 N번째 소스 실패 시 N+1, N+2가 15분 동안 stale.
    let mut any_success = false;
    // per-tick 요약 카운터(follow-up #4): 소스별 페치 결과를 한 줄 info로 남겨 관측성.
    let mut summary: Vec<(String, Result<usize, String>)> = Vec::new();
    for source in registry() {
        if !enabled.iter().any(|id| id == source.id()) {
            continue;
        }
        let id = source.id().to_string();
        match fetch_with_retry(&*source, client).await {
            Ok(items) => {
                let n = items.len();
                match store::upsert_many(db, &items).await {
                    Ok(()) => {
                        any_success = true;
                        summary.push((id, Ok(n)));
                    }
                    Err(e) => {
                        summary.push((id.clone(), Err(format!("upsert: {e}"))));
                        let _ = app.emit(
                            "news_fetch_failed",
                            NewsFetchFailed {
                                source: id,
                                error: format!("upsert: {e}"),
                            },
                        );
                    }
                }
            }
            Err(e) => {
                summary.push((id.clone(), Err(e.to_string())));
                let _ = app.emit(
                    "news_fetch_failed",
                    NewsFetchFailed {
                        source: id,
                        error: e.to_string(),
                    },
                );
            }
        }
    }
    if any_success {
        let _ = app.emit("news_items_updated", ());
    }
    // 한 줄 요약 — 예: "news tick: hn=30 geeknews=15 lobsters=ERR(...)".
    if !summary.is_empty() {
        let parts: Vec<String> = summary
            .into_iter()
            .map(|(id, r)| match r {
                Ok(n) => format!("{id}={n}"),
                Err(_) => format!("{id}=ERR"),
            })
            .collect();
        tracing::info!(summary = %parts.join(" "), "news tick");
    }
    Ok(())
}

async fn fetch_with_retry(
    source: &dyn NewsSource,
    client: &Client,
) -> Result<Vec<NewsItem>, AppError> {
    let mut delay_ms = INITIAL_DELAY_MS;
    let mut last_err: Option<AppError> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match source.fetch(client).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                tracing::debug!(source = source.id(), attempt, error = %e, "news fetch retry");
                last_err = Some(e);
                if attempt == MAX_ATTEMPTS {
                    break;
                }
                let jitter = rand::rng().random_range(0..JITTER_MAX_MS);
                tokio::time::sleep(Duration::from_millis(delay_ms + jitter)).await;
                delay_ms = (delay_ms * 2).min(MAX_DELAY_MS);
            }
        }
    }
    Err(last_err.expect("retry loop sets last_err on failure"))
}
