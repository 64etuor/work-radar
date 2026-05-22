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
