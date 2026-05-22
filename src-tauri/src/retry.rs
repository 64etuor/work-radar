//! 공용 bounded retry (INVARIANT #5). 재시도 불가 에러는 즉시 반환, 재시도 가능 에러만
//! backoff+jitter 후 max_attempts까지 재시도한다. 재시도 가능 여부는 에러 스스로 분류한다
//! (호출자가 임의 설정 못 함 — INVARIANT #5).

use std::time::Duration;

/// 재시도 가능 여부를 에러 스스로 분류한다(호출자가 임의 설정 못 함 — INVARIANT #5).
pub trait Retryable {
    fn is_retryable(&self) -> bool;
}

/// base_delay 기반 소량 jitter(0..base). rand 의존성 없이 시스템 클록 nanos에서 파생한다.
fn jitter(base: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    base.mul_f64((nanos % 997) as f64 / 997.0)
}

/// bounded retry (INVARIANT #5): 재시도 불가 에러는 즉시 반환(재시도 0), 재시도 가능 에러만
/// backoff+jitter 후 재시도하며 max_attempts 소진 시 마지막 에러를 노출한다.
/// base_delay는 테스트 고속화용 인자.
pub async fn with_retry<T, E, F, Fut>(
    max_attempts: u32,
    base_delay: Duration,
    mut op: F,
) -> Result<T, E>
where
    E: Retryable,
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let mut attempt = 0u32;
    loop {
        match op(attempt).await {
            Ok(v) => return Ok(v),
            Err(e) if !e.is_retryable() => return Err(e),
            Err(e) => {
                attempt += 1;
                if attempt >= max_attempts {
                    return Err(e);
                }
                let backoff = base_delay.saturating_mul(2u32.saturating_pow(attempt - 1));
                tokio::time::sleep(backoff + jitter(base_delay)).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// 테스트 전용 에러: 재시도 가능 여부를 생성 시 직접 지정한다(도메인 에러와 무관하게 generic 검증).
    #[derive(Debug)]
    struct TestError {
        retryable: bool,
    }
    impl Retryable for TestError {
        fn is_retryable(&self) -> bool {
            self.retryable
        }
    }

    /// (a) 재시도 가능 에러 몇 번 후 성공 — 정확한 시도 횟수.
    #[tokio::test]
    async fn with_retry_succeeds_after_retryable() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, TestError> = with_retry(5, Duration::from_millis(1), |_| {
            let n = calls.fetch_add(1, Ordering::Relaxed);
            async move {
                if n < 2 {
                    Err(TestError { retryable: true })
                } else {
                    Ok(7)
                }
            }
        })
        .await;
        assert_eq!(r.unwrap(), 7);
        assert_eq!(calls.load(Ordering::Relaxed), 3, "2번 실패 후 3번째 성공");
    }

    /// (b) 계속 재시도 가능이면 max_attempts 소진 후 마지막 에러 노출(무한 retry 아님).
    #[tokio::test]
    async fn with_retry_gives_up_after_max() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, TestError> = with_retry(3, Duration::from_millis(1), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(TestError { retryable: true }) }
        })
        .await;
        assert!(r.is_err());
        assert_eq!(
            calls.load(Ordering::Relaxed),
            3,
            "정확히 max_attempts회만 시도"
        );
    }

    /// (c) 재시도 불가 에러는 재시도하지 않는다(즉시 반환, 1회).
    #[tokio::test]
    async fn with_retry_does_not_retry_non_retryable() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, TestError> = with_retry(5, Duration::from_millis(1), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(TestError { retryable: false }) }
        })
        .await;
        assert!(r.is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1, "non-retryable은 1회만");
    }
}
