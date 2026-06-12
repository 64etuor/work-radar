//! Claude Code / Codex CLI 사용량 한도 조회 (Control Room 헤더 게이지).
//!
//! - codex: `~/.codex/sessions/**/*.jsonl`의 `token_count` 이벤트에 기록되는
//!   `rate_limits`(primary=5h, secondary=주간) 스냅샷을 **로컬 파일에서만** 읽는다.
//! - claude: 로컬 캐시가 없어 OAuth usage 엔드포인트를 호출한다. 토큰은 Claude Code가
//!   저장한 keychain/credentials 파일에서 읽고 **프런트로 절대 내보내지 않는다**
//!   (이 모듈의 반환 타입에는 토큰이 들어갈 자리가 없다 — 구조적 차단).
//!
//! 둘 다 실패해도 Err 대신 `available=false + detail`로 graceful degrade —
//! Control Room은 항상 그릴 수 있어야 한다. 호출당 시도는 1회(무한 retry 금지,
//! INVARIANT #5); 주기·429 백오프·stale 폴백은 커맨드 레이어(TTL 캐시)가 통제한다 —
//! 그래서 claude fetch는 429를 별도 분기(`ClaudeUsageFetch::RateLimited`)로 돌려준다.

use serde::Serialize;
use specta::Type;

/// 사용량 윈도(5시간/주간). `used_percent`는 0..=100.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// "five_hour" | "weekly" (표시 라벨은 프런트가 결정).
    pub id: String,
    pub used_percent: f64,
    /// 리셋 시각 (ISO 8601 UTC). 소스에 없으면 None.
    pub resets_at: Option<String>,
}

/// 에이전트 하나의 사용량 상태 (graceful degrade — 못 읽으면 available=false).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub available: bool,
    /// unavailable 사유 (사람이 읽을, 토큰/PII 없음).
    pub detail: Option<String>,
    pub windows: Vec<UsageWindow>,
    /// 데이터 기준 시각 (codex=세션 이벤트 timestamp). None=알 수 없음.
    pub as_of: Option<String>,
    /// 로그인 계정 이메일 — 로컬 auth 파일에서만 읽음(네트워크 0). PII — 툴팁 표시 전용,
    /// 로그/detail에 절대 싣지 않는다. usage 가용성과 독립(unavailable이어도 채울 수 있음).
    pub account: Option<String>,
}

impl AgentUsage {
    pub fn unavailable(detail: impl Into<String>) -> Self {
        Self {
            available: false,
            detail: Some(detail.into()),
            windows: Vec::new(),
            as_of: None,
            account: None,
        }
    }
}

/// 헤더 게이지 페이로드 — claude + codex 묶음.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageStatus {
    pub claude: AgentUsage,
    pub codex: AgentUsage,
}

// ── codex: 세션 JSONL 파싱 ────────────────────────────────────────────────────

/// 최근 세션 파일 몇 개까지 거슬러 볼지 (rate_limits가 null인 세션 스킵용 — bounded).
const CODEX_MAX_FILES: usize = 10;

/// `~/.codex/sessions`에서 최신 rate_limits 스냅샷을 읽는다 (blocking — spawn_blocking에서 호출).
pub fn read_codex_usage(home: &std::path::Path) -> AgentUsage {
    let sessions = home.join(".codex").join("sessions");
    if !sessions.is_dir() {
        return AgentUsage::unavailable("codex 세션 기록 없음 (~/.codex/sessions)");
    }
    let mut files = collect_jsonl_files(&sessions);
    // 데이터 최신성 기준 = mtime(마지막 기록 시각). 파일명(세션 시작 시각) 정렬은 함정 —
    // 장수 세션이 가장 신선한 rate_limits를 계속 쓰는 동안, 더 늦게 시작했지만 이미 끝난
    // 세션 파일들이 사전식 정렬에서 그를 가려 게이지가 옛 스냅샷에 동결된다(2026-06-12 실관측).
    // mtime 조회 실패는 epoch 0 = 맨 뒤. 동률 tiebreak은 경로 내림차순(파일명 최신 우선).
    files.sort_unstable_by_key(|p| std::cmp::Reverse((mtime_of(p), p.clone())));
    for path in files.into_iter().take(CODEX_MAX_FILES) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Some(usage) = parse_codex_rate_limits(text.lines().rev()) {
            return usage;
        }
    }
    AgentUsage::unavailable("codex 세션에서 rate limit 스냅샷을 찾지 못함")
}

fn mtime_of(p: &std::path::Path) -> std::time::SystemTime {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

fn collect_jsonl_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "jsonl") {
                out.push(path);
            }
        }
    }
    out
}

/// JSONL 라인들(최신부터)에서 마지막 non-null `rate_limits`를 파싱한다. 순수 함수 — 테스트 대상.
pub fn parse_codex_rate_limits<'a>(lines: impl Iterator<Item = &'a str>) -> Option<AgentUsage> {
    for line in lines {
        // 빠른 사전 필터 — rate_limits 없는 라인은 JSON 파싱 자체를 건너뛴다.
        if !line.contains("rate_limits") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let payload = v.get("payload").unwrap_or(&v);
        let Some(rl) = payload.get("rate_limits").filter(|x| !x.is_null()) else {
            continue;
        };
        let event_ts = v.get("timestamp").and_then(|t| t.as_str());
        let mut windows = Vec::new();
        for (key, id) in [("primary", "five_hour"), ("secondary", "weekly")] {
            if let Some(w) = rl.get(key).filter(|x| !x.is_null()) {
                if let Some(win) = parse_codex_window(w, id, event_ts) {
                    windows.push(win);
                }
            }
        }
        if windows.is_empty() {
            continue;
        }
        return Some(AgentUsage {
            available: true,
            detail: None,
            windows,
            as_of: event_ts.map(str::to_owned),
            account: None, // 계정은 커맨드 레이어가 auth 파일에서 별도 주입.
        });
    }
    None
}

fn parse_codex_window(
    w: &serde_json::Value,
    id: &str,
    event_ts: Option<&str>,
) -> Option<UsageWindow> {
    let used_percent = w.get("used_percent")?.as_f64()?.clamp(0.0, 100.0);
    // resets_at(unix 초) 우선, 없으면 resets_in_seconds + 이벤트 시각으로 환산.
    let resets_at = w
        .get("resets_at")
        .and_then(|r| r.as_i64())
        .and_then(unix_to_iso)
        .or_else(|| {
            let secs = w.get("resets_in_seconds")?.as_i64()?;
            let base = chrono::DateTime::parse_from_rfc3339(event_ts?).ok()?;
            Some(
                (base.with_timezone(&chrono::Utc) + chrono::Duration::seconds(secs))
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            )
        });
    Some(UsageWindow {
        id: id.to_owned(),
        used_percent,
        resets_at,
    })
}

fn unix_to_iso(secs: i64) -> Option<String> {
    Some(
        chrono::DateTime::from_timestamp(secs, 0)?
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

// ── claude: OAuth usage 엔드포인트 ───────────────────────────────────────────

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// Claude Code가 저장한 OAuth access token을 찾는다 (macOS keychain → 파일 fallback).
/// 토큰 값은 호출자에게만 반환 — 로그/에러 메시지에 절대 싣지 않는다.
pub fn claude_access_token(home: &std::path::Path) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(token) = token_from_keychain() {
            return Ok(token);
        }
    }
    let path = home.join(".claude").join(".credentials.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| "Claude Code 로그인 정보를 찾지 못함 (keychain/credentials)".to_owned())?;
    extract_access_token(&text).ok_or_else(|| "credentials 파일에 accessToken 없음".to_owned())
}

#[cfg(target_os = "macos")]
fn token_from_keychain() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    extract_access_token(String::from_utf8_lossy(&out.stdout).trim())
}

/// credentials JSON(`{claudeAiOauth:{accessToken}}` 또는 flat)에서 accessToken 추출. 순수 — 테스트 대상.
pub fn extract_access_token(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let token = v
        .get("claudeAiOauth")
        .and_then(|o| o.get("accessToken"))
        .or_else(|| v.get("accessToken"))?
        .as_str()?;
    (!token.is_empty()).then(|| token.to_owned())
}

/// claude usage 호출 결과 — 캐시 레이어가 429(백오프)와 일반 실패(stale 폴백)를
/// 구분해야 해서 AgentUsage가 아니라 3분기 enum으로 돌려준다.
#[derive(Debug)]
pub enum ClaudeUsageFetch {
    Ok(AgentUsage),
    /// HTTP 429 — `Retry-After` 헤더(초)가 있으면 함께.
    RateLimited {
        retry_after_secs: Option<u64>,
    },
    /// 그 외 실패 (사람이 읽을 사유, 토큰/PII 없음).
    Failed(String),
}

/// usage 엔드포인트 단일 시도 호출 (timeout은 client 빌더에서). 응답 본문은 로그 금지.
pub async fn fetch_claude_usage(client: &reqwest::Client, token: &str) -> ClaudeUsageFetch {
    let resp = match client
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // reqwest 에러 Display에는 URL만 — 토큰/본문 없음.
            let kind = if e.is_timeout() { "timeout" } else { "network" };
            return ClaudeUsageFetch::Failed(format!("usage API 연결 실패 ({kind})"));
        }
    };
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return ClaudeUsageFetch::Failed("Claude Code 토큰 만료 — claude에서 재로그인 필요".into());
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after_secs = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok());
        return ClaudeUsageFetch::RateLimited { retry_after_secs };
    }
    if !status.is_success() {
        return ClaudeUsageFetch::Failed(format!("usage API {status}"));
    }
    let Ok(v) = resp.json::<serde_json::Value>().await else {
        return ClaudeUsageFetch::Failed("usage API 응답 파싱 실패".into());
    };
    let usage = parse_claude_usage(&v);
    if usage.available {
        ClaudeUsageFetch::Ok(usage)
    } else {
        ClaudeUsageFetch::Failed(
            usage
                .detail
                .unwrap_or_else(|| "usage API 응답에 한도 정보 없음".into()),
        )
    }
}

/// usage 응답(`five_hour`/`seven_day` × `{utilization, resets_at}`) 파싱. 순수 — 테스트 대상.
pub fn parse_claude_usage(v: &serde_json::Value) -> AgentUsage {
    let mut windows = Vec::new();
    for (key, id) in [("five_hour", "five_hour"), ("seven_day", "weekly")] {
        let Some(w) = v.get(key).filter(|x| !x.is_null()) else {
            continue;
        };
        let Some(used_percent) = w.get("utilization").and_then(|u| u.as_f64()) else {
            continue;
        };
        windows.push(UsageWindow {
            id: id.to_owned(),
            used_percent: used_percent.clamp(0.0, 100.0),
            resets_at: w
                .get("resets_at")
                .and_then(|r| r.as_str())
                .map(str::to_owned),
        });
    }
    if windows.is_empty() {
        return AgentUsage::unavailable("usage API 응답에 한도 정보 없음");
    }
    AgentUsage {
        available: true,
        detail: None,
        windows,
        as_of: None,   // 호출 시점 데이터 = 캐시 레이어가 시각을 안다.
        account: None, // 계정은 커맨드 레이어가 auth 파일에서 별도 주입.
    }
}

// ── 로그인 계정 (로컬 auth 파일 — 네트워크 0, PII는 반환값으로만) ────────────

/// claude 로그인 계정 — `~/.claude.json`의 `oauthAccount.emailAddress`.
/// 파일 부재/파싱 실패는 조용히 None (게이지 가용성과 무관한 부가 정보).
pub fn claude_account(home: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join(".claude.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("oauthAccount")?
        .get("emailAddress")?
        .as_str()
        .map(str::to_owned)
}

/// codex 로그인 계정 — `~/.codex/auth.json`의 `tokens.id_token` JWT `email` 클레임.
/// 표시 전용이라 서명 검증 없이 payload만 디코드. API-key 모드(토큰 없음)는 None.
pub fn codex_account(home: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join(".codex").join("auth.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let id_token = v.get("tokens")?.get("id_token")?.as_str()?;
    email_from_id_token(id_token)
}

/// JWT id_token → `email` 클레임 (서명 미검증 — 로컬 표시 전용). 순수 함수, 테스트 대상.
/// 토큰 원문은 절대 로그/에러에 싣지 않는다.
pub fn email_from_id_token(id_token: &str) -> Option<String> {
    use base64::Engine as _;
    let payload_b64 = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload_b64)
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    claims.get("email")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// codex 세션 라인(최신부터 스캔)에서 마지막 non-null rate_limits를 집는다.
    #[test]
    fn codex_parses_latest_non_null_rate_limits() {
        let lines = [
            // 최신 라인이지만 rate_limits=null → 스킵하고 더 과거로.
            r#"{"timestamp":"2026-06-11T10:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":null}}"#,
            r#"{"timestamp":"2026-06-10T09:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":1781200000},"secondary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1781700000}}}}"#,
        ];
        let u = parse_codex_rate_limits(lines.into_iter()).unwrap();
        assert!(u.available);
        assert_eq!(u.as_of.as_deref(), Some("2026-06-10T09:00:00Z"));
        assert_eq!(u.windows.len(), 2);
        assert_eq!(u.windows[0].id, "five_hour");
        assert_eq!(u.windows[0].used_percent, 42.5);
        // unix 1781200000 → ISO 변환됨 (2026-06-11T17:46:40Z).
        assert!(u.windows[0]
            .resets_at
            .as_deref()
            .unwrap()
            .starts_with("2026-06-11T"));
        assert_eq!(u.windows[1].id, "weekly");
    }

    /// resets_at이 없고 resets_in_seconds만 있으면 이벤트 시각 기준으로 환산.
    #[test]
    fn codex_falls_back_to_resets_in_seconds() {
        let line = r#"{"timestamp":"2026-06-10T00:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":7,"resets_in_seconds":3600}}}}"#;
        let u = parse_codex_rate_limits([line].into_iter()).unwrap();
        assert_eq!(
            u.windows[0].resets_at.as_deref(),
            Some("2026-06-10T01:00:00Z")
        );
    }

    /// id_token payload의 email 클레임만 디코드(서명 미검증 — 표시 전용). 비-JWT는 None.
    #[test]
    fn id_token_email_claim() {
        use base64::Engine as _;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"email":"a@b.c","sub":"x"}"#);
        let tok = format!("eyJhbGciOiJSUzI1NiJ9.{payload}.sig");
        assert_eq!(email_from_id_token(&tok).as_deref(), Some("a@b.c"));
        assert!(email_from_id_token("not-a-jwt").is_none());
        let no_email = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"x"}"#);
        assert!(email_from_id_token(&format!("h.{no_email}.s")).is_none());
    }

    /// rate_limits가 전혀 없으면 None (호출자가 더 과거 파일로 — bounded).
    #[test]
    fn codex_returns_none_without_rate_limits() {
        let lines = [r#"{"type":"event_msg","payload":{"type":"agent_message"}}"#];
        assert!(parse_codex_rate_limits(lines.into_iter()).is_none());
    }

    /// 파일 선택 = mtime 최신순(파일명 아님) — 장수 세션(이른 시작·최신 기록)이
    /// 늦게 시작했지만 이미 끝난 세션에 가려지지 않는다 (2026-06-12 게이지 동결 회귀).
    #[test]
    fn codex_picks_freshest_mtime_not_filename() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions = dir.path().join(".codex").join("sessions").join("2026");
        std::fs::create_dir_all(&sessions).expect("mkdir");
        let snap = |pct: f64, ts: &str| {
            format!(
                r#"{{"timestamp":"{ts}","payload":{{"type":"token_count","rate_limits":{{"primary":{{"used_percent":{pct},"resets_at":1781300000}}}}}}}}"#
            )
        };
        // 파일명상 "더 최신"이지만 이미 끝난 세션(옛 스냅샷, 옛 mtime).
        let finished = sessions.join("rollout-2026-06-12T16-53-00-bbb.jsonl");
        std::fs::write(&finished, snap(100.0, "2026-06-12T08:13:00Z")).expect("write");
        // 파일명상 "더 과거"지만 아직 살아서 최신 스냅샷을 쓰는 세션(새 mtime).
        let live = sessions.join("rollout-2026-06-12T12-30-00-aaa.jsonl");
        std::fs::write(&live, snap(37.0, "2026-06-12T12:50:00Z")).expect("write");
        let now = std::time::SystemTime::now();
        std::fs::File::options()
            .write(true)
            .open(&finished)
            .and_then(|f| f.set_modified(now - std::time::Duration::from_secs(3600)))
            .expect("set old mtime");
        std::fs::File::options()
            .write(true)
            .open(&live)
            .and_then(|f| f.set_modified(now))
            .expect("set new mtime");

        let u = read_codex_usage(dir.path());
        assert!(u.available);
        assert_eq!(u.as_of.as_deref(), Some("2026-06-12T12:50:00Z"));
        assert_eq!(u.windows[0].used_percent, 37.0);
    }

    /// claude usage 응답: five_hour/seven_day → 윈도 2개, utilization 0..=100 clamp.
    #[test]
    fn claude_parses_usage_response() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":61.2,"resets_at":"2026-06-11T15:00:00Z"},
                "seven_day":{"utilization":140,"resets_at":"2026-06-18T00:00:00Z"},
                "extra_usage":{"utilization":0}}"#,
        )
        .unwrap();
        let u = parse_claude_usage(&v);
        assert!(u.available);
        assert_eq!(u.windows.len(), 2);
        assert_eq!(u.windows[0].id, "five_hour");
        assert_eq!(u.windows[0].used_percent, 61.2);
        assert_eq!(u.windows[1].used_percent, 100.0, "100 초과는 clamp");
        assert_eq!(
            u.windows[0].resets_at.as_deref(),
            Some("2026-06-11T15:00:00Z")
        );
    }

    /// 한도 키가 없으면 unavailable (조용한 빈 게이지 금지).
    #[test]
    fn claude_empty_response_is_unavailable() {
        let u = parse_claude_usage(&serde_json::json!({}));
        assert!(!u.available);
    }

    /// credentials JSON 양쪽 형태(nested/flat)에서 accessToken 추출.
    #[test]
    fn extracts_access_token_from_both_shapes() {
        assert_eq!(
            extract_access_token(r#"{"claudeAiOauth":{"accessToken":"tok-a"}}"#).as_deref(),
            Some("tok-a")
        );
        assert_eq!(
            extract_access_token(r#"{"accessToken":"tok-b"}"#).as_deref(),
            Some("tok-b")
        );
        assert!(extract_access_token(r#"{"accessToken":""}"#).is_none());
        assert!(extract_access_token("not json").is_none());
    }
}
