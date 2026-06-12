//! Control Room 헤더 — claude/codex 사용량 한도 게이지 커맨드.
//!
//! 프런트가 30초 주기로 폴링하지만, claude 쪽은 외부 HTTP(usage API)라
//! 커맨드 레이어에 TTL 캐시를 둬 호출 빈도를 묶는다(폴링≠외부 호출).
//! OMC HUD와 같은 토큰을 같은 엔드포인트로 두드리므로 호출 예산을 보수적으로:
//! 성공 TTL 90s + 429는 지수 백오프(Retry-After 존중, 최대 5분) 동안 호출 차단.
//! 실패 시엔 두 에이전트 모두 15분 내 마지막 성공 스냅샷을 stale로 계속 내려
//! (detail에 사유), 게이지가 일시 오류마다 꺼지지 않게 한다. 실패는 Err가 아니라 에이전트별
//! `available=false`로 내려간다(graceful degrade — 헤더 위젯이 본문을 막으면 안 된다).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::agent_usage::{
    claude_access_token, fetch_claude_usage, read_codex_usage, AgentUsage, AgentUsageStatus,
    ClaudeUsageFetch,
};
use crate::error::AppError;

/// 성공 캐시 TTL — OMC HUD 기본 폴 주기(90s)와 동급. 수동 새로고침 연타에도 외부 호출 1회.
const CACHE_TTL: Duration = Duration::from_secs(90);
/// usage API 단일 시도 timeout (bounded — retry 없음, 다음 폴링이 자연 재시도).
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// 마지막 성공 스냅샷을 stale로 계속 표시할 수 있는 최대 나이.
const STALE_MAX: Duration = Duration::from_secs(15 * 60);
/// 429 백오프 기본 단위 (연속 횟수마다 2배).
const BACKOFF_BASE: Duration = Duration::from_secs(90);
/// 429 백오프 상한 (bounded — INVARIANT #5).
const BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);
/// Retry-After 헤더 신뢰 상한 — 비정상적으로 큰 값으로 게이지가 영구히 꺼지는 것 방지.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(60 * 60);

/// 에이전트별 호출 상태 — 429 백오프와 stale 폴백을 위해 전체 status 캐시와 별도로 든다.
#[derive(Default)]
struct UsageCache {
    /// 전체 응답 캐시 (성공/실패 무관 — 폴링 1회분 묶음).
    status: Option<(Instant, AgentUsageStatus)>,
    /// 마지막으로 성공한 claude 스냅샷 (stale 폴백 소스).
    claude_last_good: Option<(Instant, AgentUsage)>,
    /// 이 시각 전까지 claude HTTP 호출 금지 (429 백오프).
    claude_backoff_until: Option<Instant>,
    /// 연속 429 횟수 (성공 시 리셋).
    claude_429_streak: u32,
    /// 마지막으로 성공한 codex 스냅샷 — 새 세션 burst로 최근 파일들에 rate_limits가
    /// 없어지는 일시 공백에도 게이지를 유지한다 (백오프는 불필요 — 로컬 IO뿐).
    codex_last_good: Option<(Instant, AgentUsage)>,
}

static CACHE: OnceLock<tokio::sync::Mutex<UsageCache>> = OnceLock::new();
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

/// claude/codex 사용량 한도 스냅샷 (TTL 캐시 + 429 백오프 + stale 폴백, 읽기 전용).
#[tauri::command]
#[specta::specta]
pub async fn agent_usage_status() -> Result<AgentUsageStatus, AppError> {
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(UsageCache::default()));
    let mut guard = cache.lock().await;
    if let Some((at, status)) = guard.status.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return Ok(status.clone());
        }
    }

    let home = dirs::home_dir();
    let now = Instant::now();
    let in_backoff = guard.claude_backoff_until.is_some_and(|until| now < until);

    let claude = if in_backoff {
        // 백오프 중엔 HTTP를 아예 치지 않는다 — stale 스냅샷 또는 사유만.
        stale_or_unavailable(
            guard.claude_last_good.as_ref(),
            "usage API 429 (백오프 중)",
            now,
        )
    } else {
        let fetched = load_claude(home.clone()).await;
        match fetched {
            ClaudeUsageFetch::Ok(mut usage) => {
                guard.claude_429_streak = 0;
                guard.claude_backoff_until = None;
                usage.as_of =
                    Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
                guard.claude_last_good = Some((now, usage.clone()));
                usage
            }
            ClaudeUsageFetch::RateLimited { retry_after_secs } => {
                guard.claude_429_streak = guard.claude_429_streak.saturating_add(1);
                let backoff = backoff_duration(guard.claude_429_streak, retry_after_secs);
                guard.claude_backoff_until = Some(now + backoff);
                stale_or_unavailable(guard.claude_last_good.as_ref(), "usage API 429", now)
            }
            ClaudeUsageFetch::Failed(detail) => {
                stale_or_unavailable(guard.claude_last_good.as_ref(), &detail, now)
            }
        }
    };
    let codex = {
        let scanned = load_codex(home).await;
        if scanned.available {
            guard.codex_last_good = Some((now, scanned.clone()));
            scanned
        } else {
            // claude와 같은 stale 폴백 — 스캔 실패/공백 시 15분 내 마지막 성공 스냅샷 유지.
            let reason = scanned
                .detail
                .as_deref()
                .unwrap_or("codex 사용량 읽기 실패");
            stale_or_unavailable(guard.codex_last_good.as_ref(), reason, now)
        }
    };

    let status = AgentUsageStatus { claude, codex };
    guard.status = Some((Instant::now(), status.clone()));
    Ok(status)
}

/// 연속 429 횟수 → 백오프 길이. 90s·2^(n-1), 상한 5분; Retry-After가 더 길면 그쪽(상한 1h).
fn backoff_duration(streak: u32, retry_after_secs: Option<u64>) -> Duration {
    let doubling = 1u32 << streak.saturating_sub(1).min(8);
    let exp = BACKOFF_BASE.saturating_mul(doubling).min(BACKOFF_MAX);
    match retry_after_secs {
        Some(secs) => exp.max(Duration::from_secs(secs).min(RETRY_AFTER_MAX)),
        None => exp,
    }
}

/// 실패/백오프 시 폴백 — 15분 내 마지막 성공 스냅샷이 있으면 stale로 표시(사유는 detail),
/// 없으면 unavailable. as_of는 성공 시점 그대로 둬 프런트가 기준 시각을 보여준다.
fn stale_or_unavailable(
    last_good: Option<&(Instant, AgentUsage)>,
    reason: &str,
    now: Instant,
) -> AgentUsage {
    match last_good {
        Some((at, usage)) if now.duration_since(*at) < STALE_MAX => {
            let mut stale = usage.clone();
            stale.detail = Some(format!("{reason} — 마지막 성공 스냅샷 표시"));
            stale
        }
        _ => AgentUsage::unavailable(reason),
    }
}

async fn load_claude(home: Option<std::path::PathBuf>) -> ClaudeUsageFetch {
    let Some(home) = home else {
        return ClaudeUsageFetch::Failed("홈 디렉터리를 찾지 못함".into());
    };
    // keychain 조회는 외부 프로세스(security CLI) — blocking 풀로.
    let token = tokio::task::spawn_blocking(move || claude_access_token(&home)).await;
    match token {
        Ok(Ok(token)) => fetch_claude_usage(http_client(), &token).await,
        Ok(Err(detail)) => ClaudeUsageFetch::Failed(detail),
        Err(_) => ClaudeUsageFetch::Failed("토큰 조회 작업 실패".into()),
    }
}

async fn load_codex(home: Option<std::path::PathBuf>) -> AgentUsage {
    let Some(home) = home else {
        return AgentUsage::unavailable("홈 디렉터리를 찾지 못함");
    };
    // 세션 파일 스캔은 디스크 IO — blocking 풀로.
    tokio::task::spawn_blocking(move || read_codex_usage(&home))
        .await
        .unwrap_or_else(|_| AgentUsage::unavailable("세션 스캔 작업 실패"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 429 연속 횟수에 따라 90s에서 2배씩, 5분에서 멈춘다 (bounded).
    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_duration(1, None), Duration::from_secs(90));
        assert_eq!(backoff_duration(2, None), Duration::from_secs(180));
        assert_eq!(
            backoff_duration(3, None),
            Duration::from_secs(300),
            "5분 상한"
        );
        assert_eq!(
            backoff_duration(100, None),
            Duration::from_secs(300),
            "오버플로 없이 상한 유지"
        );
    }

    /// Retry-After가 지수 백오프보다 길면 그쪽을 따르되 1시간에서 자른다.
    #[test]
    fn backoff_honors_retry_after_bounded() {
        assert_eq!(
            backoff_duration(1, Some(600)),
            Duration::from_secs(600),
            "Retry-After 600s > 90s"
        );
        assert_eq!(
            backoff_duration(3, Some(10)),
            Duration::from_secs(300),
            "짧은 Retry-After는 지수 백오프가 이김"
        );
        assert_eq!(
            backoff_duration(1, Some(86_400)),
            RETRY_AFTER_MAX,
            "비정상 Retry-After는 1h 상한"
        );
    }

    fn good_usage() -> AgentUsage {
        AgentUsage {
            available: true,
            detail: None,
            windows: Vec::new(),
            as_of: Some("2026-06-12T00:00:00Z".into()),
        }
    }

    /// 15분 내 성공 스냅샷이 있으면 stale로 계속 표시 — 게이지가 꺼지지 않는다.
    #[test]
    fn stale_fallback_within_window() {
        let now = Instant::now();
        let last = (now - Duration::from_secs(5 * 60), good_usage());
        let u = stale_or_unavailable(Some(&last), "usage API 429", now);
        assert!(u.available);
        assert_eq!(
            u.detail.as_deref(),
            Some("usage API 429 — 마지막 성공 스냅샷 표시")
        );
        assert_eq!(
            u.as_of.as_deref(),
            Some("2026-06-12T00:00:00Z"),
            "기준 시각 보존"
        );
    }

    /// 15분 지난 스냅샷은 버린다 — 너무 오래된 수치를 사실처럼 그리지 않는다.
    #[test]
    fn stale_fallback_expires() {
        let now = Instant::now() + Duration::from_secs(16 * 60);
        let last = (Instant::now(), good_usage());
        let u = stale_or_unavailable(Some(&last), "usage API 429", now);
        assert!(!u.available);
        assert_eq!(u.detail.as_deref(), Some("usage API 429"));
    }

    /// 성공 이력이 없으면 unavailable + 사유.
    #[test]
    fn no_last_good_is_unavailable() {
        let u = stale_or_unavailable(None, "usage API 연결 실패 (timeout)", Instant::now());
        assert!(!u.available);
    }
}
