//! Control Room 헤더 — claude/codex 사용량 한도 게이지 커맨드.
//!
//! 프런트가 30초 주기로 폴링하지만, claude 쪽은 외부 HTTP(usage API)라
//! 커맨드 레이어에 TTL 캐시를 둬 호출 빈도를 묶는다(폴링≠외부 호출).
//! 실패는 Err가 아니라 에이전트별 `available=false`로 내려간다(graceful degrade —
//! 헤더 위젯이 Control Room 본문을 막으면 안 된다).

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::agent_usage::{
    claude_access_token, fetch_claude_usage, read_codex_usage, AgentUsage, AgentUsageStatus,
};
use crate::error::AppError;

/// 캐시 TTL — 프런트 폴링(30s)과 같은 자리수, 수동 새로고침 연타에도 외부 호출 1회.
const CACHE_TTL: Duration = Duration::from_secs(25);
/// usage API 단일 시도 timeout (bounded — retry 없음, 다음 폴링이 자연 재시도).
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

static CACHE: OnceLock<tokio::sync::Mutex<Option<(Instant, AgentUsageStatus)>>> = OnceLock::new();
static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .build()
            .unwrap_or_default()
    })
}

/// claude/codex 사용량 한도 스냅샷 (TTL 캐시 적용, 읽기 전용 — 외부 변경 0).
#[tauri::command]
#[specta::specta]
pub async fn agent_usage_status() -> Result<AgentUsageStatus, AppError> {
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = cache.lock().await;
    if let Some((at, status)) = guard.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return Ok(status.clone());
        }
    }

    let home = dirs::home_dir();
    let (claude, codex) = tokio::join!(load_claude(home.clone()), load_codex(home));
    let status = AgentUsageStatus { claude, codex };
    *guard = Some((Instant::now(), status.clone()));
    Ok(status)
}

async fn load_claude(home: Option<std::path::PathBuf>) -> AgentUsage {
    let Some(home) = home else {
        return AgentUsage::unavailable("홈 디렉터리를 찾지 못함");
    };
    // keychain 조회는 외부 프로세스(security CLI) — blocking 풀로.
    let token = tokio::task::spawn_blocking(move || claude_access_token(&home)).await;
    match token {
        Ok(Ok(token)) => fetch_claude_usage(http_client(), &token).await,
        Ok(Err(detail)) => AgentUsage::unavailable(detail),
        Err(_) => AgentUsage::unavailable("토큰 조회 작업 실패"),
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
