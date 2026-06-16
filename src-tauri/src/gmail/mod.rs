//! Gmail send 연동 클라이언트 (External Action Gate 5번째 암, Phase 5).
//! INVARIANT: 외부 호출은 Rust(reqwest)에, 자격증명(client_id/secret/refresh_token)은 keychain blob에서만
//! 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//! 스코프는 send-only(`gmail.send`) — 메일 송신만, 읽기/리스트 권한 없음.
//! send는 **AI-origin(자동화 제안)** 경로라 non-Hermes MCP caller에서는 External Action Gate를
//! 거친다(US-004~006). Work Radar가 주입한 Hermes MCP caller는 Hermes permission card를 사람 게이트로
//! 간주해 Work Radar approval queue를 한 번 더 거치지 않고 같은 Rust connector를 직접 쓴다.
//! 외부 호출은 bounded retry + graceful terminal failure.
//!
//! **Gmail은 Google 계정 OAuth에 통합**되어 별도 Gmail 연결(oauth/loopback/PKCE/connect)은 폐지됐다.
//! 발송 토큰은 `access_token_for_cref`가 calendar의 통합 Google access token(스코프에 `gmail.send`
//! 포함)을 그대로 위임받아 쓴다.
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): 무한 retry/poll 금지.
//!  - 테스트 가능 seam: 순수 함수 + `GmailProvider` 트레잇 fake로 send 오케스트레이션을
//!    cargo test. 실 Google send·keychain 영속은 사용자 관찰.
//!
//! gmail은 자체 `GmailError`/`GmailProvider`를 소유한다(calendar/notion/github와 비공유) — 스코프·
//! 송신 관심사가 달라 모듈별로 분리(선례: github≠notion).

mod http;
mod message;
mod write;

use crate::retry::Retryable;

pub use http::HttpGmailProvider;
pub use message::build_raw_message;
pub(crate) use write::execute_gmail_action;

// ── GmailError ─────────────────────────────────────────────────────────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
#[derive(Debug, Clone, thiserror::Error)]
pub enum GmailError {
    // HTTP provider가 응답으로 분류한다: Transient는 429/5xx에서, Terminal은 그 외 4xx/디코드
    // 실패에서 구성된다(classify_http/classify_reqwest). body는 분류용으로만 검사하며 메시지엔
    // 넣지 않는다(INVARIANT #7).
    #[error("{0}")]
    Transient(String),
    #[error("{0}")]
    Terminal(String),
}

impl Retryable for GmailError {
    fn is_retryable(&self) -> bool {
        matches!(self, GmailError::Transient(_))
    }
}

// ── 트레잇 seam (RPITIT, CalendarProvider/PrProvider/NotionReader 패턴) ────────────

/// 메일 송신 계약. 오케스트레이션(`execute_gmail_action`)은 이 트레잇에만 의존 → fake로 cargo test.
/// 실 HTTP는 `HttpGmailProvider`.
pub trait GmailProvider {
    /// 전송 — **단일 시도(재시도 없음)**. AI-origin write 표면.
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

/// cref(=project credential_ref)로 Gmail 발송 access token을 확보한다. **Gmail은 Google 계정 OAuth에
/// 통합**되어(별도 Gmail 연결 폐지) 토큰은 `calendar::access_token_for_cref`가 발급하는 통합 Google
/// access token을 그대로 쓴다(스코프에 gmail.send 포함). gate 라우터가 승인된 액션의 project_ref로만
/// 토큰을 resolve하는 단일 레시피(전역/주변 토큰 금지 = 개인/업무 프로필 격리). 미연결(creds/refresh
/// 없음)은 Ok(None) — 라우터가 not_connected로 노출. 토큰 본문 미반환.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(gate 경계 함수와 동일).
#[allow(clippy::result_large_err)]
pub(crate) async fn access_token_for_cref(
    cref: &str,
) -> Result<Option<String>, crate::error::AppError> {
    crate::commands::calendar::access_token_for_cref(cref)
        .await
        .map_err(|e| crate::error::AppError::terminal("gmail.token_resolve", e))
}
