//! Gmail send 연동 클라이언트 (External Action Gate 5번째 암, Phase 5).
//! INVARIANT: 외부 호출은 Rust(reqwest)에, 자격증명(client_id/secret/refresh_token)은 keychain blob에서만
//! 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//! 스코프는 send-only(`gmail.send`) — 메일 송신만, 읽기/리스트 권한 없음.
//! send는 **AI-origin(자동화 제안)** 경로라 External Action Gate를 거친다(US-004~006). 게이트가
//! 통과한 뒤에야 Rust가 실제 송신한다(INVARIANT #2 — 자동화의 외부 mutate 차단). 외부 호출은
//! bounded retry + graceful terminal failure.
//!
//! 모듈 레이아웃:
//!  - `oauth`    PKCE/auth_url/redirect 파싱 · GmailCreds blob · TokenResponse · connect/refresh_core
//!  - `loopback` RFC 8252 loopback redirect 수신기 + LOOPBACK_TIMEOUT
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): 무한 retry/poll 금지.
//!  - OAuth = Auth Code + PKCE(S256) + loopback redirect(RFC 8252 installed-app). client는 사용자 제공.
//!  - 테스트 가능 seam: 순수 함수 + `GmailProvider` 트레잇 fake로 connect/refresh 오케스트레이션을
//!    cargo test. 실 OAuth loopback·실 Google send·keychain 영속은 사용자 관찰.
//!
//! gmail은 자체 `GmailError`/`GmailProvider`를 소유한다(calendar/notion/github와 비공유) — Google OAuth는
//! calendar와 토큰 흐름이 닮았지만 스코프·송신 관심사가 달라 모듈별로 분리(선례: github≠notion).

mod http;
mod loopback;
mod message;
mod oauth;
mod write;

use crate::retry::Retryable;

pub use http::HttpGmailProvider;
pub use loopback::{Loopback, LOOPBACK_TIMEOUT};
pub use message::build_raw_message;
// `gmail::`로 실제 소비되는 심볼만 재export한다(connect 커맨드 + 이 모듈 본문/트레잇 시그니처).
// oauth 내부 전용(merge_refresh)이나 submodule이 `super::oauth::`로 직접 쓰는 헬퍼
// (parse_redirect_query=loopback, parse_token_response=http, parse_redirect_error=loopback)는
// 이 표면으로 끌어올리지 않는다(불필요 재export = 거짓 공개 API).
pub use oauth::{
    auth_url, connect_core, gen_code_verifier, gen_state, pkce_challenge, refresh_core, GmailCreds,
    TokenResponse,
};
pub(crate) use write::execute_gmail_action;

// ── GmailError ─────────────────────────────────────────────────────────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
/// ReconnectRequired = 스코프 불일치·refresh 무효로 재연결이 필요한 경우(invalid_grant 등).
#[derive(Debug, Clone, thiserror::Error)]
pub enum GmailError {
    // HTTP provider가 응답으로 분류한다: ReconnectRequired는 refresh-time `invalid_grant`(토큰
    // 취소/만료, status 400+body 분류)에서, Transient는 429/5xx에서 구성된다(classify_token_error/
    // classify_http). body는 분류용으로만 검사하며 메시지엔 넣지 않는다(INVARIANT #7).
    #[error("{0}")]
    Transient(String),
    #[error("{0}")]
    Terminal(String),
    #[error("{0}")]
    ReconnectRequired(String),
}

impl Retryable for GmailError {
    fn is_retryable(&self) -> bool {
        matches!(self, GmailError::Transient(_))
    }
}

// ── 트레잇 seam (RPITIT, CalendarProvider/PrProvider/NotionReader 패턴) ────────────

/// OAuth 토큰 교환/갱신 계약. 오케스트레이션(connect/refresh_core)은 이 트레잇에만 의존 → fake로
/// cargo test. 실 HTTP는 US-003이 추가할 `HttpGmailProvider`.
///
/// US-003이 이 트레잇을 `send_message`/`send_message_once`로 확장한다(메일 송신, gate write 단일-시도).
/// US-001은 OAuth foundation만 — connect_core/refresh_core가 필요한 두 메서드만 둔다.
pub trait GmailProvider {
    /// authorization code → 토큰(첫 동의: refresh_token 포함). PKCE verifier·redirect_uri 동봉.
    fn exchange_code(
        &self,
        creds: &GmailCreds,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> impl std::future::Future<Output = Result<TokenResponse, GmailError>> + Send;

    /// refresh_token → 새 access_token(만료 재발급). refresh_token은 응답에 없을 수 있다.
    fn refresh_access(
        &self,
        creds: &GmailCreds,
    ) -> impl std::future::Future<Output = Result<TokenResponse, GmailError>> + Send;

    /// 전송 — **단일 시도(재시도 없음)**. External Action Gate(AI-origin) 전용 · 유일한 send 표면.
    /// messages.send는 멱등하지 않다 — 요청이 Gmail에 도달한 뒤 응답만 유실되면(transport drop=
    /// transient) bounded retry는 **중복 발송**을 낸다(이메일은 캘린더 중복보다 비대칭적으로 위험).
    /// 그래서 게이트 write는 재시도 대신 실패를 노출해 사용자가 재제안하게 한다(calendar
    /// create_event_once / github WRITE_MAX_ATTEMPTS=1 선례).
    ///
    /// `raw` = base64url RFC822(message.rs build_raw_message 산출). 반환: Gmail 메시지 id(external_ref).
    /// 사람-경로 없음 — 전부 AI-origin 게이트 경유. **bounded-retry `send_message`는 존재하지 않는다**
    /// (footgun 제거): 비멱등 send에 obvious-named retry 메서드를 두면 오용으로 중복 발송이 난다.
    fn send_message_once(
        &self,
        access_token: &str,
        raw: &str,
    ) -> impl std::future::Future<Output = Result<String, GmailError>> + Send;
}

// ── cref → access token (gate 라우터가 소비, US-004) ───────────────────────────────

/// cref(=project credential_ref)로 Gmail access token을 확보한다(refresh_core 재발급, bounded).
/// gate 라우터가 승인된 액션의 project_ref로만 토큰을 resolve하는 단일 레시피(전역/주변 토큰 금지 =
/// 개인/업무 프로필 격리). `commands::calendar::access_token_for_cref`를 미러한다. 미연결(creds/refresh
/// 없음)은 Ok(None) — 라우터가 not_connected로 노출. refresh_token 회전 시에만 keychain 갱신. 토큰
/// 본문 미반환.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(gate 경계 함수와 동일).
#[allow(clippy::result_large_err)]
pub(crate) async fn access_token_for_cref(
    cref: &str,
) -> Result<Option<String>, crate::error::AppError> {
    use crate::keychain;
    use crate::models::TokenKind;

    // 에러는 `?`로 전파한다 — keychain::get_token=keyring::Error(From<keyring::Error>),
    // GmailCreds::from_blob/refresh_core=GmailError(From<GmailError>). refresh-time invalid_grant는
    // ReconnectRequired→forbidden+'Gmail 재연결' nav로 UI에 그대로 도달한다(flatten 금지).
    let Some(blob) = keychain::get_token(cref, TokenKind::Gmail)? else {
        return Ok(None);
    };
    let creds = GmailCreds::from_blob(&blob)?;
    if !creds.has_refresh() {
        return Ok(None);
    }
    let provider = HttpGmailProvider::new()?;
    let before = creds.refresh_token.clone();
    let (access, updated) = refresh_core(&provider, creds).await?;
    if updated.refresh_token != before {
        keychain::set_token(cref, TokenKind::Gmail, &updated.to_blob())?;
    }
    Ok(Some(access))
}
