//! TTL + bounded 캐시 유틸 (P6 — 캐싱 레이어).
//!
//! **적용 범위는 외부 HTTP *읽기* 가속 전용이다.** 결정 레일(Eisenhower 분류/승격),
//! escalation 판정(ambient→임계치, INVARIANT #4), accept·promotion 쓰기(INVARIANT #2)는
//! 이 캐시를 절대 소비하지 않는다. 상태 SSOT는 SQLite로 유지된다(INVARIANT #7) — 캐시는
//! 표시용 사본일 뿐, 쓰기/상태 소스가 되지 않는다.
//!
//! `moka::future::Cache` 위 얇은 래퍼: TTL(time_to_live) + bounded `max_capacity`(무한 증가
//! 금지). 공유는 `clone`으로(저렴 — 내부 Arc). `get_or_fetch`는 강제 새로고침(`force`) 시
//! 캐시를 우회해 fresh fetch + 갱신한다(사용자 명시 refresh 경로).

use std::future::Future;
use std::hash::Hash;
use std::time::Duration;

use moka::future::Cache;

/// TTL + bounded 캐시. `K`는 캐시 키(예: project_ids+date), `V`는 표시용 값(clone 가능).
#[derive(Clone)]
pub struct TtlCache<K, V>
where
    K: Hash + Eq + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    inner: Cache<K, V>,
}

impl<K, V> TtlCache<K, V>
where
    K: Hash + Eq + Send + Sync + 'static,
    V: Clone + Send + Sync + 'static,
{
    /// TTL + bounded(`max_capacity`) 캐시 생성. 둘 다 필수(무한 증가/무한 신선도 금지).
    pub fn new(ttl: Duration, max_capacity: u64) -> Self {
        let inner = Cache::builder()
            .time_to_live(ttl)
            .max_capacity(max_capacity)
            .build();
        Self { inner }
    }

    /// 캐시 적중이면 사본 반환, 미스(만료 포함)면 `fetch`로 채운다. `force=true`면 캐시를
    /// 무시하고 항상 fresh fetch + 갱신한다(사용자 명시 새로고침 — 캐시 우회).
    ///
    /// 미스 경로는 moka `try_get_with`로 **같은 키 동시 호출을 단일 fetch로 코얼레싱**한다
    /// (thundering herd 제거). 다른 대기자는 그 결과 사본을 받는다.
    ///
    /// `fetch`가 `Err`면 캐시를 갱신하지 않고 그대로 전파한다(실패를 캐싱하지 않음 — 다음
    /// 호출이 재시도). `try_get_with`는 에러를 `Arc<E>`로 감싸 전파하지만 캐시에 저장하지
    /// 않으므로, 사본 `E`로 풀어 반환한다. terminal failure는 호출부로 노출된다(삼키지 않음).
    pub async fn get_or_fetch<F, Fut, E>(&self, key: K, force: bool, fetch: F) -> Result<V, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<V, E>>,
        E: Clone + Send + Sync + 'static,
    {
        if force {
            // 강제 새로고침: 코얼레싱 우회하고 fresh fetch + 갱신(사용자 명시 refresh 경로).
            let fresh = fetch().await?;
            self.inner.insert(key, fresh.clone()).await;
            return Ok(fresh);
        }
        // 미스면 단일 fetch로 코얼레싱. Err는 Arc로 전파되나 캐시되지 않음 → 사본 E로 풀어 반환.
        self.inner
            .try_get_with(key, fetch())
            .await
            .map_err(|arc| (*arc).clone())
    }

    /// 단일 키 무효화(명시 강제 무효화 경로).
    #[allow(dead_code)]
    pub async fn invalidate(&self, key: &K) {
        self.inner.invalidate(key).await;
    }

    /// 전체 무효화(예: 토큰 재연결/해제 후 표시 캐시 비우기).
    #[allow(dead_code)]
    pub async fn invalidate_all(&self) {
        self.inner.invalidate_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 호출 카운터로 fetch 횟수를 센다. moka의 pending task 반영을 위해 run_pending_tasks 호출.
    async fn settle<K, V>(c: &TtlCache<K, V>)
    where
        K: Hash + Eq + Send + Sync + 'static,
        V: Clone + Send + Sync + 'static,
    {
        c.inner.run_pending_tasks().await;
    }

    /// TTL 내 두 번째 호출은 적중 → underlying fetch가 1회만 호출(전: 2, 후: 1).
    #[tokio::test]
    async fn hit_within_ttl_skips_fetcher() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60), 100);
        let calls = Arc::new(AtomicUsize::new(0));

        let mk_fetch = || {
            let calls = calls.clone();
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<u32, ()>(42)
                }
            }
        };

        let v1 = cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();
        settle(&cache).await;
        let v2 = cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();

        assert_eq!(v1, 42);
        assert_eq!(v2, 42);
        // 캐시 hit → underlying fetch는 1회로 줄어든다(전 2회 호출 → 후 1회 fetch).
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "TTL 내 두 번째 호출은 캐시 hit이라 fetcher 미호출"
        );
    }

    /// TTL 경과 후에는 miss → fetch 재호출(만료 동작).
    #[tokio::test]
    async fn expiry_after_ttl_refetches() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_millis(20), 100);
        let calls = Arc::new(AtomicUsize::new(0));

        let mk_fetch = || {
            let calls = calls.clone();
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<u32, ()>(7)
                }
            }
        };

        cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();
        settle(&cache).await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        settle(&cache).await;
        cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "TTL 경과 후 miss → fetcher 재호출"
        );
    }

    /// force=true는 캐시를 우회해 항상 fresh fetch(강제 새로고침 경로).
    #[tokio::test]
    async fn force_bypasses_cache() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60), 100);
        let calls = Arc::new(AtomicUsize::new(0));

        let mk_fetch = || {
            let calls = calls.clone();
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<u32, ()>(1)
                }
            }
        };

        cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();
        settle(&cache).await;
        // force → TTL 내라도 캐시 무시하고 fresh fetch.
        cache
            .get_or_fetch("k".into(), true, mk_fetch())
            .await
            .unwrap();

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "force=true는 TTL 내라도 캐시 우회 → fetcher 재호출"
        );
    }

    /// 명시 invalidate 후 다음 호출은 miss → 재fetch(강제 무효화).
    #[tokio::test]
    async fn invalidate_forces_refetch() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60), 100);
        let calls = Arc::new(AtomicUsize::new(0));

        let mk_fetch = || {
            let calls = calls.clone();
            move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok::<u32, ()>(9)
                }
            }
        };

        cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();
        settle(&cache).await;
        cache.invalidate(&"k".to_string()).await;
        settle(&cache).await;
        cache
            .get_or_fetch("k".into(), false, mk_fetch())
            .await
            .unwrap();

        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "invalidate 후 miss → fetcher 재호출"
        );
    }

    /// fetch Err는 캐싱하지 않는다(다음 호출이 재시도 — 실패 캐싱 금지).
    #[tokio::test]
    async fn errors_are_not_cached() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60), 100);
        let calls = Arc::new(AtomicUsize::new(0));

        // 첫 호출은 Err, 둘째는 Ok.
        let first = cache
            .get_or_fetch("k".into(), false, {
                let calls = calls.clone();
                move || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Err::<u32, &str>("boom")
                    }
                }
            })
            .await;
        assert!(first.is_err());
        settle(&cache).await;

        let second = cache
            .get_or_fetch("k".into(), false, {
                let calls = calls.clone();
                move || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok::<u32, &str>(5)
                    }
                }
            })
            .await;
        assert_eq!(second.unwrap(), 5);
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "Err는 캐싱 안 됨 → 둘째 호출도 fetcher 호출"
        );
    }

    /// 같은 키 동시 miss는 단일 fetch로 코얼레싱(thundering herd 제거). 8개 동시 호출 → fetch 1회.
    #[tokio::test]
    async fn concurrent_misses_coalesce_to_single_fetch() {
        let cache: TtlCache<String, u32> = TtlCache::new(Duration::from_secs(60), 100);
        let calls = Arc::new(AtomicUsize::new(0));

        let tasks: Vec<_> = (0..8u8)
            .map(|_| {
                let cache = cache.clone();
                let calls = calls.clone();
                tokio::spawn(async move {
                    cache
                        .get_or_fetch("k".into(), false, {
                            let calls = calls.clone();
                            move || {
                                let calls = calls.clone();
                                async move {
                                    // fetch 진행 중 다른 대기자가 합류하도록 약간 지연.
                                    tokio::time::sleep(Duration::from_millis(20)).await;
                                    calls.fetch_add(1, Ordering::SeqCst);
                                    Ok::<u32, ()>(42)
                                }
                            }
                        })
                        .await
                        .unwrap()
                })
            })
            .collect();

        for t in tasks {
            assert_eq!(t.await.unwrap(), 42);
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "같은 키 동시 miss → underlying fetch는 1회로 코얼레싱"
        );
    }
}
