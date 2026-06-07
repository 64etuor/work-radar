//! OAuth (Auth Code + PKCE/S256, loopback redirect — RFC 8252) + 자격증명 blob + 토큰 응답.
//!
//! 순수 함수(PKCE/auth_url/redirect 파싱/토큰 응답 파싱/blob 병합) + 트레잇을 통한 연결/갱신 오케스트레이션.
//! 실 HTTP는 http.rs `HttpCalendarProvider`가 맡고, 이 슬라이스는 그와 무관한 순수 로직 + `connect_core`/
//! `refresh_core` 오케스트레이션만 담는다.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{CalendarError, CalendarProvider};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// Google 계정 통합 스코프: calendar full read+write **+ gmail.send**. 한 번의 동의로 캘린더와
/// 메일 발송을 모두 부여해, 별도 Gmail 연결 없이 "Google 계정" 연결 하나로 둘 다 커버한다.
/// (기존 calendar-only 토큰은 gmail.send가 없어 발송 시 403 → Google 계정 재연결 필요.)
/// `gmail.send`는 Google restricted scope — 동의 화면에 미확인-앱 경고가 뜰 수 있다.
/// write는 사용자 폼 제출(사람 결정)이라 Acceptance 게이트 불요 — 게이트는 자동화의 외부 mutate 차단용(#2).
pub(super) const CALENDAR_SCOPE: &str =
    "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send";

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
        // 응답 본문(OAuth 토큰 응답)은 메시지/로그에 넣지 않는다(스펙 §5.5).
        .ok_or_else(|| CalendarError::Terminal("토큰 응답에 access_token 없음".into()))?
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

// ── 오케스트레이션: connect_core / refresh_core (트레잇 의존 → fake로 cargo test) ──────

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

    /// auth_url: 모든 필수 파라미터 + S256 + events scope(read+write)를 담는다(percent-encoding 라운드트립).
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
        // access_token 누락 → Terminal. 응답 본문은 메시지에 노출되지 않는다(스펙 §5.5).
        let bad = serde_json::json!({ "error": "invalid_grant", "leak": "SECRET_xyz" });
        let Err(CalendarError::Terminal(m)) = parse_token_response(&bad) else {
            panic!("access_token 누락 → Terminal");
        };
        assert!(
            !m.contains("SECRET_xyz") && !m.contains("invalid_grant"),
            "본문 내용이 메시지에 노출되면 안 됨"
        );
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
}
