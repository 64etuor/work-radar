//! 외부 API ping (read-only 검증). INVARIANT: 외부 호출은 Rust에, 토큰은 인자로만
//! 들어오고 본문은 반환하지 않는다. bounded: 단일 시도 + timeout (무한 retry/poll 금지).
//! 실제 호출은 자격증명/네트워크가 필요하므로 cargo test가 아니라 사용자 관찰로 검증한다.

use std::time::Duration;

use crate::models::PingResult;
use crate::notion::NOTION_VERSION;

const PING_TIMEOUT: Duration = Duration::from_secs(12);

/// 외부 토큰/연결 검증 결과 분류. **저장 게이트는 `Invalid`만 차단**하고 `Unreachable`은 통과시킨다
/// — 오프라인/일시 실패(timeout·429·5xx·네트워크)에 유효 토큰을 거부하지 않기 위해서다(사후 Test ping
/// 으로 확인 가능). `ping_*`(사용자 발동 테스트)는 `Valid`만 ok로 본다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// 검증 성공.
    Valid,
    /// 확실히 무효(예: HTTP 401 — 잘못된 토큰/접근 불가). 차단 대상.
    Invalid,
    /// 확인 불가(네트워크/타임아웃/429/5xx 등). 게이트는 통과.
    Unreachable,
}

/// 외부 검증 결과 + 사람이 읽을 `detail` + 계정 `identity`(login/bot). 토큰 본문 미포함(INVARIANT).
pub struct Probe {
    pub outcome: ProbeOutcome,
    pub detail: String,
    pub identity: Option<String>,
}

/// Notion 토큰 검증 + bot/workspace **식별자** 추출: `GET /v1/users/me`.
/// 401=무효(차단), 그 외 비2xx/네트워크/timeout=확인 불가(통과). 토큰 본문 미노출(INVARIANT).
pub async fn probe_notion(token: &str) -> Probe {
    let client = match reqwest::Client::builder().timeout(PING_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            return Probe {
                outcome: ProbeOutcome::Unreachable,
                detail: format!("client error: {e}"),
                identity: None,
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
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(String::from));
            let label = name.clone().unwrap_or_else(|| "ok".into());
            Probe {
                outcome: ProbeOutcome::Valid,
                detail: format!("Notion: {label}"),
                identity: name,
            }
        }
        Ok(r) if r.status().as_u16() == 401 => Probe {
            outcome: ProbeOutcome::Invalid,
            detail: "HTTP 401 (토큰 무효)".into(),
            identity: None,
        },
        Ok(r) => Probe {
            outcome: ProbeOutcome::Unreachable,
            detail: format!("HTTP {}", r.status().as_u16()),
            identity: None,
        },
        Err(e) if e.is_timeout() => Probe {
            outcome: ProbeOutcome::Unreachable,
            detail: "timeout".into(),
            identity: None,
        },
        Err(e) => Probe {
            outcome: ProbeOutcome::Unreachable,
            detail: e.to_string(),
            identity: None,
        },
    }
}

/// Notion 토큰 검증: `GET /v1/users/me`. 200이면 ok, 그 외/에러는 실패(메시지 노출).
pub async fn ping_notion(token: &str) -> PingResult {
    let p = probe_notion(token).await;
    PingResult {
        ok: p.outcome == ProbeOutcome::Valid,
        detail: p.detail,
    }
}

/// octocrab 에러 → (분류, detail). 401만 무효(차단), 그 외(429/5xx/전송계층/디코드)는 확인 불가(통과).
fn classify_github_probe(e: &octocrab::Error) -> (ProbeOutcome, String) {
    match e {
        octocrab::Error::GitHub { source, .. } => {
            let s = source.status_code.as_u16();
            if s == 401 {
                (
                    ProbeOutcome::Invalid,
                    format!("HTTP 401 (토큰 무효): {}", source.message),
                )
            } else {
                (
                    ProbeOutcome::Unreachable,
                    format!("HTTP {s}: {}", source.message),
                )
            }
        }
        _ => (ProbeOutcome::Unreachable, e.to_string()),
    }
}

/// GitHub 토큰 검증 + login **식별자** 추출: octocrab `current().user()`.
/// 401=무효(차단), 그 외/네트워크=확인 불가(통과). 토큰 본문 미포함.
pub async fn probe_github(token: &str) -> Probe {
    let octo = match octocrab::Octocrab::builder()
        .personal_token(token.to_string())
        .build()
    {
        Ok(o) => o,
        Err(e) => {
            return Probe {
                outcome: ProbeOutcome::Unreachable,
                detail: format!("client error: {e}"),
                identity: None,
            }
        }
    };
    match octo.current().user().await {
        Ok(user) => Probe {
            outcome: ProbeOutcome::Valid,
            detail: format!("GitHub: {}", user.login),
            identity: Some(user.login),
        },
        Err(e) => {
            let (outcome, detail) = classify_github_probe(&e);
            Probe {
                outcome,
                detail,
                identity: None,
            }
        }
    }
}

/// GitHub 토큰 검증: octocrab `current().user()`. ok면 login 노출.
pub async fn ping_github(token: &str) -> PingResult {
    let p = probe_github(token).await;
    PingResult {
        ok: p.outcome == ProbeOutcome::Valid,
        detail: p.detail,
    }
}
