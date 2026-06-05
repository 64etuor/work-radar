//! Gmail send 연동 클라이언트 (External Action Gate 5번째 암, Phase 5).
//! INVARIANT: 외부 호출은 Rust(reqwest)에, 자격증명(client_id/secret/refresh_token)은 keychain blob에서만
//! 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//! 스코프는 send-only(`gmail.send`) — 메일 송신만, 읽기/리스트 권한 없음.
//! send는 **AI-origin(자동화 제안)** 경로라 External Action Gate를 거친다(US-004~006). 게이트가
//! 통과한 뒤에야 Rust가 실제 송신한다(INVARIANT #2 — 자동화의 외부 mutate 차단). 외부 호출은
//! bounded retry + graceful terminal failure.
//!
//! 모듈 레이아웃(현재 US-001):
//!  - `oauth`   PKCE/auth_url/redirect 파싱 · GmailCreds blob · TokenResponse · connect/refresh_core
//!
//! 향후 슬라이스(US-002~006)가 mime/http/gate/mcp/connect 커맨드를 추가한다.
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): 무한 retry/poll 금지.
//!  - OAuth = Auth Code + PKCE(S256) + loopback redirect(RFC 8252 installed-app). client는 사용자 제공.
//!  - 테스트 가능 seam: 순수 함수 + `GmailProvider` 트레잇 fake로 connect/refresh 오케스트레이션을
//!    cargo test. 실 OAuth loopback·실 Google send·keychain 영속은 사용자 관찰.
//!
//! gmail은 자체 `GmailError`/`GmailProvider`를 소유한다(calendar/notion/github와 비공유) — Google OAuth는
//! calendar와 토큰 흐름이 닮았지만 스코프·송신 관심사가 달라 모듈별로 분리(선례: github≠notion).

// US-001은 OAuth foundation만 — 이 모듈의 pub surface(creds blob·순수 OAuth 헬퍼·connect/refresh_core·
// GmailError·GmailProvider)는 US-002~006(mime/http/gate/mcp/connect)이 소비한다. 그 전까지는 crate
// 내부에서 아무도 호출하지 않아 dead_code 경고가 전면 발생하므로, 이 슬라이스 한정으로 모듈 레벨 allow.
// (테스트는 전부 구성·호출하므로 로직 자체는 cargo test로 검증됨.)
#![allow(dead_code)]

mod http;
mod message;
mod oauth;

use crate::retry::Retryable;

// US-002~006이 이 surface를 소비한다(mime/http/gate/mcp/connect). 현재 crate 내부에서
// 아직 안 쓰여 unused 경고가 나는데, 의도적 보존이므로 allow(calendar와 동일 패턴).
#[allow(unused_imports)]
pub use http::HttpGmailProvider;
#[allow(unused_imports)]
pub use message::build_raw_message;
#[allow(unused_imports)]
pub use oauth::{
    auth_url, connect_core, gen_code_verifier, gen_state, merge_refresh, parse_redirect_query,
    parse_token_response, pkce_challenge, refresh_core, GmailCreds, TokenResponse,
};

// ── GmailError ─────────────────────────────────────────────────────────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
/// ReconnectRequired = 스코프 불일치·refresh 무효로 재연결이 필요한 경우(invalid_grant 등).
#[derive(Debug, Clone, thiserror::Error)]
pub enum GmailError {
    // Transient/ReconnectRequired는 US-003 HTTP provider가 응답 상태로 분류하며 구성한다.
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

    /// Gmail로 메시지 전송(bounded retry). `raw` = base64url RFC822(message.rs build_raw_message 산출).
    /// 반환: Gmail 메시지 id(external_ref). 사람-경로 없음 — 전부 AI-origin 게이트 경유. bounded retry.
    fn send_message(
        &self,
        access_token: &str,
        raw: &str,
    ) -> impl std::future::Future<Output = Result<String, GmailError>> + Send;

    /// 전송 — **단일 시도(재시도 없음)**. External Action Gate(AI-origin) 전용.
    /// messages.send는 멱등하지 않다 — 요청이 Gmail에 도달한 뒤 응답만 유실되면(transport drop=
    /// transient) `send_message`의 bounded retry가 **중복 발송**을 낸다(이메일은 캘린더 중복보다
    /// 비대칭적으로 위험). 그래서 게이트 write는 재시도 대신 실패를 노출해 사용자가 재제안하게 한다
    /// (calendar create_event_once / github WRITE_MAX_ATTEMPTS=1 선례).
    ///
    /// 기본 구현은 `send_message`로 위임한다 — **실 HTTP provider(HttpGmailProvider)는 단일-시도
    /// POST로 override**해야 한다(중복 발송 방지). 기본 위임은 retry가 무의미한 테스트 fake 전용이다.
    fn send_message_once(
        &self,
        access_token: &str,
        raw: &str,
    ) -> impl std::future::Future<Output = Result<String, GmailError>> + Send {
        self.send_message(access_token, raw)
    }
}
