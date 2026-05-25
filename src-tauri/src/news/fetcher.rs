//! 백그라운드 뉴스 페처.
//! - tokio::time::interval 유지(drift 보정 + MissedTickBehavior 보존).
//! - tokio::sync::Notify로 옵션 변경 즉시 적용.
//! - fetch_interval=0은 진짜 park(Notify만 대기 + 1h 안전망 폴, busy-poll 아님).
//! - 페치당 최대 3회 지수 백오프 + jitter, 모두 실패 시 `news_fetch_failed` 이벤트 발행.
//! - 성공 시 `news_items_updated` 이벤트.
//! - tick 시작에서 7일 만료 cleanup 수행.
//!
//! 스폰은 `tauri::async_runtime::spawn`(scheduler.rs와 동일) — macOS main 스레드의 setup()에서
//! `tokio::spawn`은 "no reactor running" 패닉을 일으킴.

use std::sync::Arc;
use std::time::Duration;

use rand::RngExt;
use reqwest::Client;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{Interval, MissedTickBehavior};

use super::{options_store, pref_store, registry, store, NewsItem, NewsSource};
use crate::db::Db;
use crate::error::AppError;

const REQ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;
const INITIAL_DELAY_MS: u64 = 500;
const MAX_DELAY_MS: u64 = 10_000;
const JITTER_MAX_MS: u64 = 200;
/// fetch_interval=0(park 모드)일 때 Notify 안 와도 1h 후 polling 안전망.
const PARK_TIMEOUT: Duration = Duration::from_secs(3600);

#[derive(Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewsFetchFailed {
    pub source: String,
    pub error: String,
}

/// 옵션 변경 신호 — `news_set_options` 커맨드가 `notify_one()` 호출.
/// AppHandle managed state로 공유.
///
/// `Notify::notify_one()`은 wake-up 허가(permit)를 **하나** 버퍼한다. set_options가
/// fetcher의 `select!` 진입 전에 호출돼도 다음 `notified()` future가 즉시 resolve →
/// 즉시-적용 보장. (Tokio 문서 보장.)
pub type OptionsNotify = Arc<Notify>;

/// select!의 깨움 이유. R7 — 변수명 의도 정확화(park 안전망 polling도 Reconfig).
pub(crate) enum WakeReason {
    Tick,
    Reconfig,
}

/// fetcher 메인 loop의 select! 분기를 추출한 helper.
/// `spawn_loop`와 단위 테스트가 같은 코드 경로를 호출 →
/// 테스트가 production 동작을 진짜로 검증(R6).
///
/// - `ticker == Some` (interval 모드): Tick vs Reconfig 중 먼저 resolve된 것.
/// - `ticker == None` (park 모드, fetch_interval=0): Reconfig 또는 `PARK_TIMEOUT` 안전망.
pub(crate) async fn select_next_wake(ticker: Option<&mut Interval>, notify: &Notify) -> WakeReason {
    match ticker {
        Some(t) => {
            tokio::select! {
                _ = t.tick() => WakeReason::Tick,
                _ = notify.notified() => WakeReason::Reconfig,
            }
        }
        None => {
            tokio::select! {
                _ = notify.notified() => WakeReason::Reconfig,
                _ = tokio::time::sleep(PARK_TIMEOUT) => WakeReason::Reconfig,
            }
        }
    }
}

/// 옵션의 `fetch_interval_minutes`에 맞춰 새 `Interval`을 만들고 첫(즉시) tick을 소비한다.
/// R1: `MissedTickBehavior::Delay` 명시 — Tokio 기본 `Burst`는 옵션 churn 후
/// back-to-back tick을 일으켜 INVARIANT #5(bounded retry)를 위반할 수 있음.
async fn build_ticker(minutes: u32) -> Option<Interval> {
    if minutes == 0 {
        return None;
    }
    let mut t = tokio::time::interval(Duration::from_secs(minutes as u64 * 60));
    t.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // 첫 tick은 interval 생성 직후 즉시 resolve → 우리는 이미 직전에 한 번 fetch한 상태이므로
    // 여기서 소비해 다음 진짜 주기부터 카운팅.
    t.tick().await;
    Some(t)
}

/// setup hook에서 호출. scheduler.rs와 동일 패턴(tauri::async_runtime::spawn).
pub fn spawn_loop(db: Db, app: AppHandle, notify: OptionsNotify) {
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

        // 첫 tick 즉시 실행.
        if let Err(e) = tick(&db, &app, &client).await {
            tracing::warn!(error = %e, "news fetcher initial tick failed");
        }

        let mut current_minutes: u32 = 0;
        let mut ticker_opt: Option<Interval> = None;

        loop {
            // 옵션 읽고 interval을 그에 맞춰 재구성(변경된 경우만).
            let opts = match options_store::get(&db).await {
                Ok(o) => o,
                Err(e) => {
                    tracing::warn!(error = %e, "news options load failed; using defaults");
                    super::options_store::NewsOptions::default()
                }
            };
            if opts.fetch_interval_minutes != current_minutes {
                current_minutes = opts.fetch_interval_minutes;
                ticker_opt = build_ticker(current_minutes).await;
            }

            // 다음 트리거: helper로 분기(R6 — 같은 함수를 단위 테스트가 호출).
            let reason = select_next_wake(ticker_opt.as_mut(), &notify).await;

            // R7: woke_for_reconfig — park 안전망(PARK_TIMEOUT)도 Reconfig로 분기되므로 의도 정확.
            let woke_for_reconfig = matches!(reason, WakeReason::Reconfig);
            if woke_for_reconfig {
                // 옵션이 바뀌었을 수 있으니 loop 머리에서 재평가 + interval 재구성.
                continue;
            }

            // 정상 tick — fetch 실행.
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
    let mut any_success = false;
    // per-tick 요약 카운터: 소스별 페치 결과를 한 줄 info로 남겨 관측성.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;

    /// R6: production helper `select_next_wake`를 직접 호출.
    /// Notify 트리거가 interval보다 먼저 resolve → WakeReason::Reconfig 반환.
    #[tokio::test(start_paused = true)]
    async fn notify_wakes_select_next_wake_immediately() {
        let notify = Arc::new(Notify::new());
        let mut ticker = build_ticker(15).await.expect("15min ticker");

        // Notify를 미리 트리거 — Notify는 permit 1개를 buffer하므로 다음 select에서 즉시 resolve.
        notify.notify_one();
        let reason = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(
            matches!(reason, WakeReason::Reconfig),
            "Notify가 interval보다 먼저 깨워야 함"
        );
    }

    /// interval만 도달했을 때 → WakeReason::Tick.
    #[tokio::test(start_paused = true)]
    async fn ticker_fires_when_due() {
        let notify = Arc::new(Notify::new());
        let mut ticker = build_ticker(5).await.expect("5min ticker"); // 첫 tick은 build에서 이미 소비.
                                                                      // 5분 진행 → 다음 tick 도달.
        tokio::time::advance(Duration::from_secs(5 * 60)).await;
        let reason = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(matches!(reason, WakeReason::Tick));
    }

    /// park 모드(ticker=None)에서도 Notify가 즉시 깨움.
    #[tokio::test(start_paused = true)]
    async fn park_mode_wakes_on_notify() {
        let notify = Arc::new(Notify::new());
        notify.notify_one();
        let reason = select_next_wake(None, &notify).await;
        assert!(matches!(reason, WakeReason::Reconfig));
    }

    /// build_ticker(0)은 None 반환 — park 모드 진입 가드.
    #[tokio::test(start_paused = true)]
    async fn build_ticker_zero_returns_none() {
        assert!(build_ticker(0).await.is_none());
    }

    /// MissedTickBehavior::Delay가 실제 적용됐는지 — 두 tick 간격이 절반 이하로 줄어들지 않음.
    /// (Burst였다면 advance(2 * period) 뒤 즉시 두 번 연속 fire.)
    #[tokio::test(start_paused = true)]
    async fn missed_tick_behavior_is_delay_not_burst() {
        let notify = Arc::new(Notify::new());
        let mut ticker = build_ticker(5).await.unwrap();
        // 10분 진행 — Burst면 두 번 즉시 fire, Delay면 1번 fire 후 다음은 다시 5분 후.
        tokio::time::advance(Duration::from_secs(10 * 60)).await;
        let r1 = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(matches!(r1, WakeReason::Tick));
        // 두 번째는 즉시가 아니라 5분 뒤 — 1초만 지나서는 안 옴(Notify로 단언).
        tokio::time::advance(Duration::from_secs(1)).await;
        notify.notify_one();
        let r2 = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(
            matches!(r2, WakeReason::Reconfig),
            "Delay 모드: 두번째 tick은 즉시 fire 안 함"
        );
    }
}
