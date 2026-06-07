//! 외부 API ping (read-only 검증). INVARIANT: 외부 호출은 Rust에, 토큰은 인자로만
//! 들어오고 본문은 반환하지 않는다. bounded: 단일 시도 + timeout (무한 retry/poll 금지).
//! 실제 호출은 자격증명/네트워크가 필요하므로 cargo test가 아니라 사용자 관찰로 검증한다.

use std::time::Duration;

use crate::models::PingResult;
use crate::notion::NOTION_VERSION;

const PING_TIMEOUT: Duration = Duration::from_secs(12);

/// Notion 토큰 검증 + bot/workspace **식별자** 추출: `GET /v1/users/me`.
/// 반환 `(ok, detail, identity)` — `identity`=bot/workspace 이름(연결 점검의 계정 중복 판정용).
/// `detail`/`identity` 어디에도 토큰 본문은 담기지 않는다(INVARIANT).
pub async fn probe_notion(token: &str) -> (bool, String, Option<String>) {
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => return (false, format!("client error: {e}"), None),
    };
    let resp = client
        .get("https://api.notion.com/v1/users/me")
        .bearer_auth(token)
        .header("Notion-Version", NOTION_VERSION)
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => {
            let name = r
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from));
            let label = name.clone().unwrap_or_else(|| "ok".into());
            (true, format!("Notion: {label}"), name)
        }
        Ok(r) => (false, format!("HTTP {}", r.status().as_u16()), None),
        Err(e) if e.is_timeout() => (false, "timeout".into(), None),
        Err(e) => (false, e.to_string(), None),
    }
}

/// Notion 토큰 검증: `GET /v1/users/me`. 200이면 ok, 그 외/에러는 실패(메시지 노출).
pub async fn ping_notion(token: &str) -> PingResult {
    let (ok, detail, _) = probe_notion(token).await;
    PingResult { ok, detail }
}

/// GitHub 토큰 검증 + login **식별자** 추출: octocrab `current().user()`.
/// 반환 `(ok, detail, identity)` — `identity`=login(연결 점검의 계정 중복 판정용). 토큰 본문 미포함.
pub async fn probe_github(token: &str) -> (bool, String, Option<String>) {
    let octo = match octocrab::Octocrab::builder()
        .personal_token(token.to_string())
        .build()
    {
        Ok(o) => o,
        Err(e) => return (false, e.to_string(), None),
    };
    match octo.current().user().await {
        Ok(user) => (true, format!("GitHub: {}", user.login), Some(user.login)),
        Err(e) => (false, e.to_string(), None),
    }
}

/// GitHub 토큰 검증: octocrab `current().user()`. ok면 login 노출.
pub async fn ping_github(token: &str) -> PingResult {
    let (ok, detail, _) = probe_github(token).await;
    PingResult { ok, detail }
}
