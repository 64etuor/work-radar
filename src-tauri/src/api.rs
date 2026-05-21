//! 외부 API ping (read-only 검증). INVARIANT: 외부 호출은 Rust에, 토큰은 인자로만
//! 들어오고 본문은 반환하지 않는다. bounded: 단일 시도 + timeout (무한 retry/poll 금지).
//! 실제 호출은 자격증명/네트워크가 필요하므로 cargo test가 아니라 사용자 관찰로 검증한다.

use std::time::Duration;

use crate::models::PingResult;

const NOTION_VERSION: &str = "2022-06-28";
const PING_TIMEOUT: Duration = Duration::from_secs(12);

/// Notion 토큰 검증: `GET /v1/users/me`. 200이면 ok, 그 외/에러는 실패(메시지 노출).
pub async fn ping_notion(token: &str) -> PingResult {
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return PingResult {
                ok: false,
                detail: format!("client error: {e}"),
            }
        }
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
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from))
                .unwrap_or_else(|| "ok".into());
            PingResult {
                ok: true,
                detail: format!("Notion: {name}"),
            }
        }
        Ok(r) => PingResult {
            ok: false,
            detail: format!("HTTP {}", r.status().as_u16()),
        },
        Err(e) if e.is_timeout() => PingResult {
            ok: false,
            detail: "timeout".into(),
        },
        Err(e) => PingResult {
            ok: false,
            detail: e.to_string(),
        },
    }
}

/// GitHub 토큰 검증: octocrab `current().user()`. ok면 login 노출.
pub async fn ping_github(token: &str) -> PingResult {
    let octo = match octocrab::Octocrab::builder()
        .personal_token(token.to_string())
        .build()
    {
        Ok(o) => o,
        Err(e) => {
            return PingResult {
                ok: false,
                detail: e.to_string(),
            }
        }
    };
    match octo.current().user().await {
        Ok(user) => PingResult {
            ok: true,
            detail: format!("GitHub: {}", user.login),
        },
        Err(e) => PingResult {
            ok: false,
            detail: e.to_string(),
        },
    }
}
