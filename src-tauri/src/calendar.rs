//! Google Calendar 연동 클라이언트 (read 레일, Phase 10). INVARIANT: 외부 호출은 Rust(reqwest)에,
//! 자격증명(client_id/secret/refresh_token)은 keychain blob에서만 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//! read-only 스코프(`calendar.readonly`) → 외부 mutate 0 → Acceptance 불요(PR Radar read 선례).
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): `with_retry`(github.rs/notion.rs와 동일 패턴) + reqwest timeout +
//!    loopback timeout. 무한 retry/poll 금지.
//!  - OAuth = Auth Code + PKCE(S256) + loopback redirect(RFC 8252 installed-app). client는 사용자 제공.
//!  - 테스트 가능 seam: 순수 함수(PKCE/auth_url/redirect 파싱/토큰 응답 파싱/blob 병합) + `CalendarProvider`
//!    트레잇 fake로 connect/refresh 오케스트레이션을 cargo test. 실 OAuth loopback·실 Google fetch·keychain
//!    영속은 사용자 관찰(실 네트워크/브라우저 없음 — Notion/GitHub/codex 선례).
//!
//! calendar.rs는 자체 `CalendarError`를 소유한다(notion/github와 비공유) — Google OAuth/Calendar는
//! 자체 토큰 엔드포인트·refresh 흐름·재시도 관심사를 가지므로 모듈별로 분리(선례: github≠notion).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// 한 토큰 교환/갱신 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// loopback redirect 대기 상한(bounded — 무한 대기 금지). 사용자 동의 시간 포함.
pub const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(180);

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
/// read-only 스코프 — 외부 mutate 불가(INVARIANT #2: Acceptance 불요).
const CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly";

/// loopback에 redirect 도착 시 사용자 브라우저에 보여줄 최소 HTML(200).
const SUCCESS_HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: 96\r\n\r\n<html><body style=\"font-family:sans-serif\"><h3>연결되었습니다.</h3><p>이 창을 닫아도 됩니다.</p></body></html>";
/// code 없는 잡음 요청(favicon 등)에 대한 최소 200.
const WAIT_HTML: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 7\r\n\r\nwaiting";

// ── 에러 분류 + bounded retry (github.rs/notion.rs와 동일 패턴) ─────────────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
#[derive(Debug, Clone)]
pub enum CalendarError {
    Transient(String),
    Terminal(String),
}

impl std::fmt::Display for CalendarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CalendarError::Transient(m) => write!(f, "{m}"),
            CalendarError::Terminal(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for CalendarError {}

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
fn classify_http(status: u16, body: &str) -> CalendarError {
    let snippet: String = body.chars().take(300).collect();
    if status == 429 || status >= 500 {
        CalendarError::Transient(format!("HTTP {status}: {snippet}"))
    } else {
        CalendarError::Terminal(format!("HTTP {status}: {snippet}"))
    }
}

/// reqwest 전송 에러 → 분류. 네트워크/타임아웃은 일시적, 디코드 실패는 영구.
fn classify_reqwest(e: &reqwest::Error) -> CalendarError {
    if e.is_decode() {
        CalendarError::Terminal(format!("decode error: {e}"))
    } else {
        CalendarError::Transient(e.to_string())
    }
}

/// base_delay 기반 소량 jitter(0..base). rand 의존성 없이 시스템 클록 nanos에서 파생한다.
fn jitter(base: Duration) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    base.mul_f64((nanos % 997) as f64 / 997.0)
}

/// bounded retry (INVARIANT #5): Terminal은 즉시 반환(재시도 0), Transient만 backoff+jitter 후
/// 재시도하며 max_attempts 소진 시 마지막 Transient를 노출한다. base_delay는 테스트 고속화용 인자.
pub async fn with_retry<T, F, Fut>(
    max_attempts: u32,
    base_delay: Duration,
    mut op: F,
) -> Result<T, CalendarError>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, CalendarError>>,
{
    let mut attempt = 0u32;
    loop {
        match op(attempt).await {
            Ok(v) => return Ok(v),
            Err(CalendarError::Terminal(m)) => return Err(CalendarError::Terminal(m)),
            Err(CalendarError::Transient(m)) => {
                attempt += 1;
                if attempt >= max_attempts {
                    return Err(CalendarError::Transient(m));
                }
                let backoff = base_delay.saturating_mul(2u32.saturating_pow(attempt - 1));
                tokio::time::sleep(backoff + jitter(base_delay)).await;
            }
        }
    }
}

// ── 자격증명 blob (keychain 전용 — 절대 DTO/렌더러로 나가지 않는다) ──────────────────

/// keychain blob `{credential_ref}:google_calendar`의 내용. INVARIANT: DTO/반환/캐시 어디에도 안 나간다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCreds {
    pub client_id: String,
    pub client_secret: String,
    /// OAuth 연결 완료 시 저장. refresh 시 응답에 없으면 기존 유지(merge_refresh).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

impl CalendarCreds {
    /// keychain JSON 문자열 → creds. 깨진 JSON은 Terminal(자동 재시도 무의미).
    pub fn from_blob(s: &str) -> Result<Self, CalendarError> {
        serde_json::from_str(s)
            .map_err(|e| CalendarError::Terminal(format!("creds blob 파싱: {e}")))
    }

    /// creds → keychain JSON 문자열.
    pub fn to_blob(&self) -> String {
        serde_json::to_string(self).expect("CalendarCreds serialize")
    }

    /// refresh_token 보유 여부(연결 완료 판정).
    pub fn has_refresh(&self) -> bool {
        self.refresh_token.as_deref().is_some_and(|t| !t.is_empty())
    }
}

/// 토큰 응답의 refresh_token을 기존 creds에 병합한다. 응답에 없으면(refresh 시 흔함) 기존 유지. 순수.
pub fn merge_refresh(mut creds: CalendarCreds, resp: &TokenResponse) -> CalendarCreds {
    if let Some(rt) = resp.refresh_token.as_deref() {
        if !rt.is_empty() {
            creds.refresh_token = Some(rt.to_string());
        }
    }
    creds
}

// ── 순수 OAuth 헬퍼 (단위 테스트 대상) ─────────────────────────────────────────────

/// PKCE code_verifier: CSPRNG 32바이트 → base64url(no pad) = 43자(43~128 unreserved 범위).
pub fn gen_code_verifier() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("CSPRNG code_verifier");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// PKCE S256 challenge = base64url(no pad, SHA-256(verifier)). 순수 — RFC 7636 테스트 벡터로 검증.
pub fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize())
}

/// CSRF state: CSPRNG 16바이트 → base64url(no pad).
pub fn gen_state() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("CSPRNG state");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// authorization URL 조립(파라미터 percent-encoding은 reqwest::Url가 처리). 순수.
pub fn auth_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let mut url = reqwest::Url::parse(AUTH_ENDPOINT).expect("valid auth endpoint");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", CALENDAR_SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("state", state);
    url.to_string()
}

/// loopback GET 요청 첫 줄("GET /?code=..&state=.. HTTP/1.1")에서 (code, state)를 뽑는다. 순수.
/// code 또는 state가 없으면(잡음 요청·OAuth error) None — 호출자가 state 일치까지 검증한다.
pub fn parse_redirect_query(request_line: &str) -> Option<(String, String)> {
    let path = request_line.split_whitespace().nth(1)?;
    // 상대 path를 절대 URL로 감싸 query_pairs로 안전하게 percent-decode.
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).ok()?;
    let mut code = None;
    let mut state = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    Some((code?, state?))
}

/// Google 토큰 엔드포인트 응답(access_token/refresh_token/expires_in).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenResponse {
    pub access_token: String,
    /// 첫 동의 시 발급, refresh 응답엔 보통 없음.
    pub refresh_token: Option<String>,
    pub expires_in: u64,
}

/// 토큰 응답 JSON → TokenResponse. access_token 누락은 Terminal(재시도 무의미). 순수.
pub fn parse_token_response(body: &serde_json::Value) -> Result<TokenResponse, CalendarError> {
    let access_token = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let snippet: String = body.to_string().chars().take(200).collect();
            CalendarError::Terminal(format!("토큰 응답에 access_token 없음: {snippet}"))
        })?
        .to_string();
    let refresh_token = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);
    Ok(TokenResponse {
        access_token,
        refresh_token,
        expires_in,
    })
}

// ── 트레잇 seam (RPITIT, PrProvider/NotionReader 패턴) ────────────────────────────

/// OAuth 토큰 교환/갱신 계약. connect/refresh 오케스트레이션은 이 트레잇에만 의존 → fake로 cargo test.
/// (이번 PR=10a는 교환/갱신만. calendarList/events fetch는 10b에서 트레잇 확장.)
pub trait CalendarProvider {
    /// authorization code → 토큰(첫 동의: refresh_token 포함). PKCE verifier·redirect_uri 동봉.
    fn exchange_code(
        &self,
        creds: &CalendarCreds,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> impl std::future::Future<Output = Result<TokenResponse, CalendarError>> + Send;

    /// refresh_token → 새 access_token(만료 재발급). refresh_token은 응답에 없을 수 있다.
    fn refresh_access(
        &self,
        creds: &CalendarCreds,
    ) -> impl std::future::Future<Output = Result<TokenResponse, CalendarError>> + Send;
}

/// 코드 교환 후 자격증명 갱신(refresh_token 병합). 첫 동의면 refresh_token 필수 — 없으면 Terminal.
/// 반환된 creds를 호출자가 keychain blob에 저장한다. 트레잇 의존 → fake로 검증.
pub async fn connect_core<P: CalendarProvider>(
    provider: &P,
    creds: CalendarCreds,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<CalendarCreds, CalendarError> {
    let resp = provider
        .exchange_code(&creds, code, verifier, redirect_uri)
        .await?;
    let updated = merge_refresh(creds, &resp);
    if !updated.has_refresh() {
        return Err(CalendarError::Terminal(
            "Google이 refresh_token을 반환하지 않았습니다 (이미 승인된 client일 수 있음 — \
             Google 계정의 앱 권한을 제거 후 재연결하세요)."
                .into(),
        ));
    }
    Ok(updated)
}

/// refresh_token으로 access token 재발급(bounded). refresh_token 응답 누락 시 기존 보존.
/// 반환: (access_token, 갱신된 creds). access token in-memory 캐시는 호출자(Phase 10b)가 맡는다.
pub async fn refresh_core<P: CalendarProvider>(
    provider: &P,
    creds: CalendarCreds,
) -> Result<(String, CalendarCreds), CalendarError> {
    if !creds.has_refresh() {
        return Err(CalendarError::Terminal(
            "refresh_token 없음 — 먼저 연결하세요".into(),
        ));
    }
    let resp = provider.refresh_access(&creds).await?;
    let access = resp.access_token.clone();
    let updated = merge_refresh(creds, &resp);
    Ok((access, updated))
}

// ── loopback 서버 (실 OAuth 흐름 — cargo test 아님, 사용자 관찰) ────────────────────

/// 임의 loopback 포트에 bind한 단일 OAuth redirect 수신기. bind 후 redirect_uri를 노출하고,
/// 그 URI로 브라우저를 연 뒤 `wait_for_redirect`로 code를 받는다(bounded timeout).
pub struct Loopback {
    listener: tokio::net::TcpListener,
    pub redirect_uri: String,
}

impl Loopback {
    /// 127.0.0.1 임의 포트 bind → redirect_uri 확정. 웹 프레임워크 없음(tokio TcpListener).
    pub async fn bind() -> Result<Self, CalendarError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| CalendarError::Terminal(format!("loopback bind 실패: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| CalendarError::Terminal(format!("loopback addr: {e}")))?
            .port();
        Ok(Self {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}"),
        })
    }

    /// redirect(GET /?code=..&state=..)를 bounded timeout 안에 받아 (code, state) 반환.
    /// code 없는 잡음 요청(favicon 등)은 무시하고 계속 대기한다.
    pub async fn wait_for_redirect(
        self,
        timeout: Duration,
    ) -> Result<(String, String), CalendarError> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let accept_loop = async {
            loop {
                let (mut stream, _) = self
                    .listener
                    .accept()
                    .await
                    .map_err(|e| CalendarError::Transient(format!("loopback accept: {e}")))?;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                if let Some((code, state)) = parse_redirect_query(first_line) {
                    let _ = stream.write_all(SUCCESS_HTML.as_bytes()).await;
                    let _ = stream.flush().await;
                    return Ok::<_, CalendarError>((code, state));
                }
                let _ = stream.write_all(WAIT_HTML.as_bytes()).await;
                let _ = stream.flush().await;
            }
        };

        match tokio::time::timeout(timeout, accept_loop).await {
            Ok(result) => result,
            Err(_) => Err(CalendarError::Terminal(format!(
                "OAuth redirect {}초 내 미수신 (timeout)",
                timeout.as_secs()
            ))),
        }
    }
}

// ── 실 HTTP provider (reqwest, rustls) ────────────────────────────────────────────

/// 실제 Google OAuth token provider. reqwest(rustls) + bounded retry.
pub struct HttpCalendarProvider {
    http: reqwest::Client,
}

impl HttpCalendarProvider {
    pub fn new() -> Result<Self, CalendarError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| CalendarError::Terminal(format!("client build: {e}")))?;
        Ok(Self { http })
    }

    /// 토큰 엔드포인트 form POST 1회. 200대가 아니면 분류된 에러.
    async fn post_token(&self, form: &[(&str, &str)]) -> Result<TokenResponse, CalendarError> {
        let resp = self
            .http
            .post(TOKEN_ENDPOINT)
            .form(form)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &body));
        }
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| CalendarError::Terminal(format!("token parse: {e}")))?;
        parse_token_response(&json)
    }
}

impl CalendarProvider for HttpCalendarProvider {
    async fn exchange_code(
        &self,
        creds: &CalendarCreds,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, CalendarError> {
        // form은 fn 본문이 소유 → with_retry 클로저가 참조해도 await 너머까지 산다.
        let form = [
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect_uri),
        ];
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_token(&form)).await
    }

    async fn refresh_access(&self, creds: &CalendarCreds) -> Result<TokenResponse, CalendarError> {
        let refresh_token = creds
            .refresh_token
            .as_deref()
            .ok_or_else(|| CalendarError::Terminal("refresh_token 없음".into()))?;
        let form = [
            ("client_id", creds.client_id.as_str()),
            ("client_secret", creds.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ];
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_token(&form)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PKCE S256: RFC 7636 Appendix B 테스트 벡터(고정 verifier → 알려진 challenge).
    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = pkce_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    /// code_verifier: 43자(32바이트 base64url no-pad) + unreserved 문자만, 매번 달라야 한다.
    #[test]
    fn gen_code_verifier_length_and_charset() {
        let v = gen_code_verifier();
        assert_eq!(v.len(), 43, "32바이트 base64url(no pad) = 43자");
        assert!(
            v.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "unreserved(base64url) 문자만: {v}"
        );
        assert_ne!(
            gen_code_verifier(),
            gen_code_verifier(),
            "CSPRNG라 매번 다름"
        );
    }

    /// state: 비어있지 않고 매번 다르다.
    #[test]
    fn gen_state_is_random_nonempty() {
        let a = gen_state();
        assert!(!a.is_empty());
        assert_ne!(a, gen_state());
    }

    /// auth_url: 모든 필수 파라미터 + S256 + read-only scope를 담는다(percent-encoding 라운드트립).
    #[test]
    fn auth_url_contains_required_params() {
        let url = auth_url("cid.apps", "http://127.0.0.1:54321", "CHAL", "STATE");
        let parsed = reqwest::Url::parse(&url).unwrap();
        let pairs: std::collections::HashMap<String, String> = parsed
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert_eq!(parsed.host_str(), Some("accounts.google.com"));
        assert_eq!(pairs.get("client_id").unwrap(), "cid.apps");
        assert_eq!(pairs.get("redirect_uri").unwrap(), "http://127.0.0.1:54321");
        assert_eq!(pairs.get("response_type").unwrap(), "code");
        assert_eq!(pairs.get("scope").unwrap(), CALENDAR_SCOPE);
        assert_eq!(pairs.get("code_challenge").unwrap(), "CHAL");
        assert_eq!(pairs.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(pairs.get("access_type").unwrap(), "offline");
        assert_eq!(pairs.get("prompt").unwrap(), "consent");
        assert_eq!(pairs.get("state").unwrap(), "STATE");
    }

    /// redirect 파싱: 정상 / code 누락 / state 누락 / 잡음(favicon) / percent-encoded code.
    #[test]
    fn parse_redirect_query_cases() {
        assert_eq!(
            parse_redirect_query("GET /?code=abc123&state=xyz HTTP/1.1"),
            Some(("abc123".into(), "xyz".into()))
        );
        // 순서 무관 + 추가 파라미터.
        assert_eq!(
            parse_redirect_query("GET /?scope=foo&state=s1&code=c1 HTTP/1.1"),
            Some(("c1".into(), "s1".into()))
        );
        // code에 percent-encoded 문자(/)가 있어도 디코드.
        assert_eq!(
            parse_redirect_query("GET /?code=4%2Fabc&state=s HTTP/1.1"),
            Some(("4/abc".into(), "s".into()))
        );
        // code 누락.
        assert_eq!(parse_redirect_query("GET /?state=only HTTP/1.1"), None);
        // state 누락.
        assert_eq!(parse_redirect_query("GET /?code=only HTTP/1.1"), None);
        // OAuth error redirect(코드 없음).
        assert_eq!(
            parse_redirect_query("GET /?error=access_denied&state=s HTTP/1.1"),
            None
        );
        // 잡음(favicon).
        assert_eq!(parse_redirect_query("GET /favicon.ico HTTP/1.1"), None);
    }

    /// 토큰 응답 파싱: 전체 / refresh 없음 / expires_in 기본값 / access_token 누락=Terminal.
    #[test]
    fn parse_token_response_cases() {
        let full = serde_json::json!({
            "access_token": "at", "refresh_token": "rt", "expires_in": 3599
        });
        assert_eq!(
            parse_token_response(&full).unwrap(),
            TokenResponse {
                access_token: "at".into(),
                refresh_token: Some("rt".into()),
                expires_in: 3599
            }
        );
        // refresh_token 없음(갱신 응답) + expires_in 기본값.
        let refresh_resp = serde_json::json!({ "access_token": "at2" });
        let r = parse_token_response(&refresh_resp).unwrap();
        assert_eq!(r.access_token, "at2");
        assert!(r.refresh_token.is_none());
        assert_eq!(r.expires_in, 3600, "expires_in 누락 시 기본 3600");
        // access_token 누락 → Terminal.
        let bad = serde_json::json!({ "error": "invalid_grant" });
        assert!(matches!(
            parse_token_response(&bad),
            Err(CalendarError::Terminal(_))
        ));
    }

    /// merge_refresh: 응답에 refresh 있으면 교체, 없으면(빈 문자열 포함) 기존 유지.
    #[test]
    fn merge_refresh_preserves_existing_when_absent() {
        let base = CalendarCreds {
            client_id: "c".into(),
            client_secret: "s".into(),
            refresh_token: Some("OLD".into()),
        };
        // 응답에 refresh 없음 → OLD 유지.
        let kept = merge_refresh(
            base.clone(),
            &TokenResponse {
                access_token: "a".into(),
                refresh_token: None,
                expires_in: 3600,
            },
        );
        assert_eq!(kept.refresh_token.as_deref(), Some("OLD"));
        // 응답에 새 refresh → 교체.
        let replaced = merge_refresh(
            base,
            &TokenResponse {
                access_token: "a".into(),
                refresh_token: Some("NEW".into()),
                expires_in: 3600,
            },
        );
        assert_eq!(replaced.refresh_token.as_deref(), Some("NEW"));
    }

    /// blob 라운드트립 + has_refresh. (토큰 본문은 keychain에만 — 이 구조는 그 직렬화 단위)
    #[test]
    fn calendar_creds_blob_roundtrip() {
        let creds = CalendarCreds {
            client_id: "id".into(),
            client_secret: "sec".into(),
            refresh_token: Some("rt".into()),
        };
        let blob = creds.to_blob();
        assert_eq!(CalendarCreds::from_blob(&blob).unwrap(), creds);
        assert!(creds.has_refresh());
        // client만 입력(연결 전): refresh 없음.
        let client_only = CalendarCreds {
            client_id: "id".into(),
            client_secret: "sec".into(),
            refresh_token: None,
        };
        assert!(!client_only.has_refresh());
        assert!(!CalendarCreds::from_blob(&client_only.to_blob())
            .unwrap()
            .has_refresh());
    }

    /// HTTP 분류: 429/5xx=Transient, 그 외 4xx=Terminal.
    #[test]
    fn classify_http_buckets() {
        assert!(matches!(
            classify_http(429, "rate"),
            CalendarError::Transient(_)
        ));
        assert!(matches!(
            classify_http(503, "down"),
            CalendarError::Transient(_)
        ));
        assert!(matches!(
            classify_http(401, "auth"),
            CalendarError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(400, "invalid_grant"),
            CalendarError::Terminal(_)
        ));
    }

    // ── 트레잇 seam: connect_core / refresh_core 오케스트레이션 (fake provider) ──────

    struct FakeProvider {
        exchange: Result<TokenResponse, CalendarError>,
        refresh: Result<TokenResponse, CalendarError>,
    }

    impl CalendarProvider for FakeProvider {
        async fn exchange_code(
            &self,
            _creds: &CalendarCreds,
            _code: &str,
            _verifier: &str,
            _redirect_uri: &str,
        ) -> Result<TokenResponse, CalendarError> {
            self.exchange.clone()
        }
        async fn refresh_access(
            &self,
            _creds: &CalendarCreds,
        ) -> Result<TokenResponse, CalendarError> {
            self.refresh.clone()
        }
    }

    fn client_only() -> CalendarCreds {
        CalendarCreds {
            client_id: "cid".into(),
            client_secret: "sec".into(),
            refresh_token: None,
        }
    }

    /// connect_core: 교환이 refresh_token을 주면 creds에 박혀 연결 완료.
    #[tokio::test]
    async fn connect_core_stores_refresh_token() {
        let provider = FakeProvider {
            exchange: Ok(TokenResponse {
                access_token: "at".into(),
                refresh_token: Some("RT".into()),
                expires_in: 3600,
            }),
            refresh: Err(CalendarError::Terminal("unused".into())),
        };
        let out = connect_core(
            &provider,
            client_only(),
            "code",
            "ver",
            "http://127.0.0.1:1",
        )
        .await
        .unwrap();
        assert_eq!(out.refresh_token.as_deref(), Some("RT"));
        assert_eq!(out.client_id, "cid", "client는 보존");
    }

    /// connect_core: refresh_token 없는 교환 응답(이미 승인된 client)은 Terminal로 막힌다.
    #[tokio::test]
    async fn connect_core_errors_without_refresh_token() {
        let provider = FakeProvider {
            exchange: Ok(TokenResponse {
                access_token: "at".into(),
                refresh_token: None,
                expires_in: 3600,
            }),
            refresh: Err(CalendarError::Terminal("unused".into())),
        };
        let r = connect_core(
            &provider,
            client_only(),
            "code",
            "ver",
            "http://127.0.0.1:1",
        )
        .await;
        assert!(matches!(r, Err(CalendarError::Terminal(_))));
    }

    /// refresh_core: 새 access 발급 + refresh 응답 누락 시 기존 refresh_token 보존.
    #[tokio::test]
    async fn refresh_core_preserves_refresh_when_absent() {
        let connected = CalendarCreds {
            client_id: "cid".into(),
            client_secret: "sec".into(),
            refresh_token: Some("OLD".into()),
        };
        let provider = FakeProvider {
            exchange: Err(CalendarError::Terminal("unused".into())),
            refresh: Ok(TokenResponse {
                access_token: "fresh".into(),
                refresh_token: None,
                expires_in: 3600,
            }),
        };
        let (access, updated) = refresh_core(&provider, connected).await.unwrap();
        assert_eq!(access, "fresh");
        assert_eq!(
            updated.refresh_token.as_deref(),
            Some("OLD"),
            "refresh 보존"
        );
    }

    /// refresh_core: refresh_token 없으면(미연결) Terminal — provider 호출 없이 막힌다.
    #[tokio::test]
    async fn refresh_core_errors_when_not_connected() {
        let provider = FakeProvider {
            exchange: Err(CalendarError::Terminal("unused".into())),
            refresh: Err(CalendarError::Terminal("unused".into())),
        };
        let r = refresh_core(&provider, client_only()).await;
        assert!(matches!(r, Err(CalendarError::Terminal(_))));
    }
}
