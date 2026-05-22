//! 정본 에러 타입 — IPC 경계를 넘는 유일한 에러(AppError).
//!
//! 규칙(정본 스펙 docs/specs/2026-05-22-error-handling-logging-design.md):
//!  - 모든 #[tauri::command]는 Result<T, AppError>를 반환(Stage 2 전환).
//!  - retryable은 kind에서 파생(Transient만 true) — 호출자가 임의 설정 못 함.
//!  - 단일 로그 호출 지점: 생성 헬퍼에서 1회 tracing 기록(From은 헬퍼 경유).
//!    이벤트는 레벨에 따라 errors.log/app.log 양쪽 레이어에 기록될 수 있다(파일 단일 아님).
//!  - 토큰/PII는 어떤 메시지/필드에도 넣지 않는다(keychain INVARIANT).

use serde::Serialize;

/// 에러 분류. 큐 전이·재시도·UI surfacing의 입력(INVARIANT #2/#5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// 네트워크/429/5xx — bounded retry/큐잉 대상.
    Transient,
    /// 4xx 일반/검증 실패 — 재시도 무의미.
    Terminal,
    /// 404 — DB ID/공유 등 액션 가능.
    NotFound,
    /// 403/권한 — 통합 권한 등 액션 가능.
    Forbidden,
    /// kill switch/사용자 취소.
    Cancelled,
    /// 입력 검증 실패.
    #[allow(dead_code)] // Stage 2 검증 커맨드에서 사용.
    Validation,
    /// 버그/불변식 위반 — 로그 + 버그리포트 유도.
    Unexpected,
}

impl ErrorKind {
    /// Transient만 재시도 가능.
    fn retryable(self) -> bool {
        matches!(self, ErrorKind::Transient)
    }
}

/// 액션 가능 힌트(열기/이동 등). 프런트가 버튼/링크로 노출.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorAction {
    pub label: String,
    /// 외부 딥링크(예: Notion DB 공유 안내).
    pub url: Option<String>,
    /// 앱 내부 네비게이션 키(예: "settings").
    pub nav: Option<String>,
}

/// IPC 경계를 넘는 유일한 에러 타입.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    /// 머신 식별자(예: "notion.not_found", "db.query").
    pub code: String,
    /// 사람용 메시지(현지화) — Display 출력.
    pub message: String,
    /// 토스트 ↔ 로그 상관키(base32 8자).
    pub trace_id: String,
    /// kind에서 파생(Transient → true).
    pub retryable: bool,
    pub action: Option<ErrorAction>,
}

/// 프런트 genTraceId(src/lib/toast.ts)와 동일 사양: base32 8자.
const BASE32_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";

/// CSPRNG 기반 base32 8자 trace id. (프런트와 동일 알파벳·길이.)
pub fn gen_trace_id() -> String {
    let mut bytes = [0u8; 8];
    // CSPRNG 실패는 복구 불가능한 환경 결함 — 명시적 expect.
    getrandom::getrandom(&mut bytes).expect("CSPRNG(getrandom) 실패");
    bytes
        .iter()
        .map(|b| BASE32_ALPHABET[(*b % 32) as usize] as char)
        .collect()
}

impl AppError {
    /// 내부 공통 생성자 — trace_id 부여 + retryable 파생 + 단일 로그.
    fn new(kind: ErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        let err = AppError {
            kind,
            code: code.into(),
            message: message.into(),
            trace_id: gen_trace_id(),
            retryable: kind.retryable(),
            action: None,
        };
        err.log();
        err
    }

    pub fn transient(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Transient, code, message)
    }
    pub fn terminal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Terminal, code, message)
    }
    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, code, message)
    }
    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Forbidden, code, message)
    }
    pub fn cancelled(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Cancelled, code, message)
    }
    #[allow(dead_code)] // Stage 2 검증 커맨드에서 사용.
    pub fn validation(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Validation, code, message)
    }
    pub fn unexpected(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Unexpected, code, message)
    }

    /// 액션 힌트 부착(빌더).
    #[allow(dead_code)] // Stage 2 매핑에서 사용.
    pub fn with_action(mut self, action: ErrorAction) -> Self {
        self.action = Some(action);
        self
    }

    /// 단일 로그 호출 지점 — kind별 레벨로 1회 기록. 토큰/PII는 message에 없어야 한다.
    fn log(&self) {
        match self.kind {
            ErrorKind::Unexpected | ErrorKind::Terminal => {
                tracing::error!(trace_id = %self.trace_id, code = %self.code, kind = ?self.kind, "{}", self.message);
            }
            ErrorKind::Transient
            | ErrorKind::Validation
            | ErrorKind::NotFound
            | ErrorKind::Forbidden => {
                tracing::warn!(trace_id = %self.trace_id, code = %self.code, kind = ?self.kind, "{}", self.message);
            }
            ErrorKind::Cancelled => {
                tracing::info!(trace_id = %self.trace_id, code = %self.code, kind = ?self.kind, "{}", self.message);
            }
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AppError {}

// ── 도메인 enum → AppError (경계에서만 접힘. 도메인 enum은 내부 유지) ──────────────

impl From<crate::notion::NotionError> for AppError {
    fn from(e: crate::notion::NotionError) -> Self {
        use crate::notion::NotionError as E;
        match e {
            E::Transient(m) => AppError::transient("notion.transient", m),
            E::Terminal(m) => AppError::terminal("notion.terminal", m),
            E::NotFound(m) => AppError::not_found("notion.not_found", m),
            E::Forbidden(m) => AppError::forbidden("notion.forbidden", m),
        }
    }
}

impl From<crate::github::GithubError> for AppError {
    fn from(e: crate::github::GithubError) -> Self {
        use crate::github::GithubError as E;
        match e {
            E::Transient(m) => AppError::transient("github.transient", m),
            E::Terminal(m) => AppError::terminal("github.terminal", m),
        }
    }
}

impl From<crate::calendar::CalendarError> for AppError {
    fn from(e: crate::calendar::CalendarError) -> Self {
        use crate::calendar::CalendarError as E;
        match e {
            E::Transient(m) => AppError::transient("calendar.transient", m),
            E::Terminal(m) => AppError::terminal("calendar.terminal", m),
            // 스코프 불일치 재연결 필요(403) — 권한 계열 + 액션 힌트.
            E::ReconnectRequired(m) => AppError::forbidden("calendar.reconnect_required", m)
                .with_action(ErrorAction {
                    label: "캘린더 재연결".into(),
                    url: None,
                    nav: Some("settings".into()),
                }),
        }
    }
}

impl From<crate::messenger::MessengerError> for AppError {
    fn from(e: crate::messenger::MessengerError) -> Self {
        use crate::messenger::MessengerError as E;
        match e {
            E::Transient(m) => AppError::transient("messenger.transient", m),
            E::Terminal(m) => AppError::terminal("messenger.terminal", m),
        }
    }
}

impl From<crate::agent::AgentError> for AppError {
    fn from(e: crate::agent::AgentError) -> Self {
        use crate::agent::AgentError as E;
        match e {
            E::Timeout => AppError::terminal("agent.timeout", "timeout 초과로 kill됨"),
            E::Cancelled => AppError::cancelled("agent.cancelled", "사용자가 취소(kill)함"),
            E::MaxTurnsExceeded(n) => {
                AppError::terminal("agent.max_turns", format!("max_turns({n}) 초과로 kill됨"))
            }
            E::CostCapExceeded(c) => {
                AppError::terminal("agent.cost_cap", format!("cost cap(${c:.4}) 초과로 kill됨"))
            }
            E::Spawn(m) => AppError::terminal("agent.spawn", format!("잡 시작 실패: {m}")),
            E::Failed(m) => AppError::terminal("agent.failed", format!("잡 실패: {m}")),
        }
    }
}

impl From<crate::git::GitError> for AppError {
    fn from(e: crate::git::GitError) -> Self {
        AppError::terminal("git.error", e.0)
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match e {
            sqlx::Error::RowNotFound => {
                AppError::not_found("db.row_not_found", "행을 찾을 수 없음")
            }
            // 로컬 DB는 대체로 버그/불변식 위반 — Unexpected.
            other => AppError::unexpected("db.query", other.to_string()),
        }
    }
}

impl From<keyring::Error> for AppError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => AppError::not_found("token.missing", "토큰이 등록되지 않음")
                .with_action(ErrorAction {
                    label: "설정에서 토큰 등록".into(),
                    url: None,
                    nav: Some("settings".into()),
                }),
            other => AppError::terminal("token.keychain", other.to_string()),
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() || e.is_connect() {
            AppError::transient("net.transient", e.to_string())
        } else {
            AppError::terminal("net.error", e.to_string())
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::unexpected("io.error", e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_id_is_8_base32_chars() {
        let id = gen_trace_id();
        assert_eq!(id.len(), 8);
        assert!(id.bytes().all(|b| BASE32_ALPHABET.contains(&b)));
    }

    #[test]
    fn transient_is_retryable_others_not() {
        assert!(AppError::transient("x.t", "m").retryable);
        assert!(!AppError::terminal("x.t", "m").retryable);
        assert!(!AppError::not_found("x.t", "m").retryable);
        assert!(!AppError::cancelled("x.t", "m").retryable);
    }

    #[test]
    fn constructor_sets_kind_code_message_and_traceid() {
        let e = AppError::not_found("notion.not_found", "DB 없음");
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert_eq!(e.code, "notion.not_found");
        assert_eq!(e.message, "DB 없음");
        assert_eq!(e.trace_id.len(), 8);
        assert!(e.action.is_none());
    }

    #[test]
    fn with_action_attaches_action() {
        let e = AppError::forbidden("notion.forbidden", "권한 없음").with_action(ErrorAction {
            label: "통합 권한 보기".into(),
            url: Some("https://notion.so".into()),
            nav: None,
        });
        assert!(e.action.is_some());
    }

    #[test]
    fn display_is_message() {
        let e = AppError::terminal("x.t", "사람용 메시지");
        assert_eq!(e.to_string(), "사람용 메시지");
    }

    #[test]
    fn notion_error_maps_to_kinds() {
        use crate::notion::NotionError;
        assert_eq!(
            AppError::from(NotionError::Transient("a".into())).kind,
            ErrorKind::Transient
        );
        assert_eq!(
            AppError::from(NotionError::Terminal("a".into())).kind,
            ErrorKind::Terminal
        );
        assert_eq!(
            AppError::from(NotionError::NotFound("a".into())).kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            AppError::from(NotionError::Forbidden("a".into())).kind,
            ErrorKind::Forbidden
        );
        assert_eq!(
            AppError::from(NotionError::NotFound("a".into())).code,
            "notion.not_found"
        );
    }

    #[test]
    fn calendar_reconnect_is_forbidden_with_action() {
        use crate::calendar::CalendarError;
        let e = AppError::from(CalendarError::ReconnectRequired("scope".into()));
        assert_eq!(e.kind, ErrorKind::Forbidden);
        assert_eq!(e.code, "calendar.reconnect_required");
        assert!(e.action.is_some());
    }

    #[test]
    fn agent_cancelled_is_cancelled_others_terminal() {
        use crate::agent::AgentError;
        assert_eq!(
            AppError::from(AgentError::Cancelled).kind,
            ErrorKind::Cancelled
        );
        assert_eq!(
            AppError::from(AgentError::Timeout).kind,
            ErrorKind::Terminal
        );
        assert_eq!(
            AppError::from(AgentError::MaxTurnsExceeded(5)).code,
            "agent.max_turns"
        );
    }

    #[test]
    fn sqlx_row_not_found_maps_not_found_else_unexpected() {
        assert_eq!(
            AppError::from(sqlx::Error::RowNotFound).kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn keyring_no_entry_is_not_found_with_action() {
        let e = AppError::from(keyring::Error::NoEntry);
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert_eq!(e.code, "token.missing");
        assert!(e.action.is_some());
    }
}
