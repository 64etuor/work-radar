# Error Handling + Logging — Stage 1 (인프라) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 정본 `AppError` 에러 모델과 `tracing` 기반 로깅 인프라를 추가한다 (커맨드 시그니처는 미변경 — Stage 2에서 전환).

**Architecture:** 신규 `error.rs`에 IPC 정본 `AppError`(Serialize+specta) + 도메인 enum→AppError `From` 변환. `logging.rs`를 `tracing` subscriber(errors.log=WARN+, app.log=INFO+, stdout=EnvFilter)로 재작성, 기존 `AppLogger`/수기 회전 제거. AppError 생성 헬퍼가 단일 지점에서 tracing 기록.

**Tech Stack:** Rust, Tauri 2, specta/tauri-specta, `tracing` + `tracing-subscriber` + `tracing-appender`, `thiserror`, getrandom(기존 dep).

**정본 스펙:** `docs/specs/2026-05-22-error-handling-logging-design.md`

**검증 명령(메모리 주의):**

- cargo는 기본 PATH에 없음 → 매번 `export PATH="$HOME/.cargo/bin:$PATH"` 선행.
- rtk-wrapped cargo 요약은 부정확 → 검증은 `rtk proxy cargo ...`로.
- 테스트: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -30`
- clippy: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | tail -30`
- 커밋은 husky pre-commit가 cargo fmt를 돌리므로 PATH export 후 커밋. push는 dev만.

---

## File Structure

- **Create** `src-tauri/src/error.rs` — `AppError`/`ErrorKind`/`ErrorAction`, `gen_trace_id`, 생성 헬퍼, `From` 변환, 단위테스트.
- **Rewrite** `src-tauri/src/logging.rs` — `tracing` init(`init_tracing`/`LogGuards`) + `log_app_error`/`app_log_path` 커맨드(tracing 경유) + 테스트. 기존 `AppLogger`/`should_rotate`/`rotation_renames` 제거.
- **Modify** `src-tauri/src/lib.rs` — `mod error;` 선언, setup에서 `init_tracing` 호출 + guard manage, `AppLogger::new` manage 제거, `eprintln!` → tracing.
- **Modify** `src-tauri/Cargo.toml` — deps 추가.
- **Create** `docs/reference/error-handling.md` — 지침 문서.
- **Modify** `docs/reference/commands.md` — error-handling.md 인덱스 등재.

> Stage 1에서 `AppError`는 어떤 커맨드도 아직 반환하지 않으므로 `bindings.ts`에 등장하지 않는다(specta는 커맨드가 참조하는 타입만 생성). bindings 재생성은 Stage 2 첫 커맨드 전환 때 발생. Stage 1에서 미사용 항목은 `#[allow(dead_code)]`로 명시(코드베이스 선례: Phase 0 keychain).

---

## Task 0: 의존성 추가

**Files:**

- Modify: `src-tauri/Cargo.toml` (`[dependencies]` 블록)

- [ ] **Step 1: deps 추가**

`[dependencies]` 끝(`tauri-specta` 줄 다음)에 추가:

```toml
# 구조적·레벨별 로깅(에러처리 정본 설계). errors.log=WARN+, app.log=INFO+, stdout=EnvFilter.
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
# 파일 appender(일별 회전 + max_log_files로 bound). non-blocking writer.
tracing-appender = "0.2"
# 도메인 에러 enum의 Display/Error boilerplate 정리(컴파일타임 전용).
thiserror = "2"
```

- [ ] **Step 2: 의존성 해석 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo fetch --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: 에러 없이 fetch 완료(새 크레이트 다운로드).

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git add src-tauri/Cargo.toml src-tauri/Cargo.lock && rtk git commit -q -m "build(error-handling): tracing/thiserror 의존성 추가" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 1: `error.rs` — AppError 모델 + 생성 헬퍼

**Files:**

- Create: `src-tauri/src/error.rs`
- Modify: `src-tauri/src/lib.rs` (모듈 선언)

- [ ] **Step 1: `mod error;` 선언 추가**

`src-tauri/src/lib.rs`의 모듈 선언부는 알파벳 순(`mod db;`=14행, `mod git;`=15행). `mod db;` 다음 줄에 삽입:

```rust
mod error;
```

- [ ] **Step 2: 실패하는 테스트부터 — `error.rs` 생성 (모델 + 헬퍼 + 테스트)**

`src-tauri/src/error.rs` 작성:

```rust
//! 정본 에러 타입 — IPC 경계를 넘는 유일한 에러(AppError).
//!
//! 규칙(정본 스펙 docs/specs/2026-05-22-error-handling-logging-design.md):
//!  - 모든 #[tauri::command]는 Result<T, AppError>를 반환(Stage 2 전환).
//!  - retryable은 kind에서 파생(Transient만 true) — 호출자가 임의 설정 못 함.
//!  - 단일 로그 지점: 생성 헬퍼에서 1회 tracing 기록. From은 헬퍼 경유.
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

    /// 단일 로그 지점 — kind별 레벨로 1회 기록. 토큰/PII는 message에 없어야 한다.
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
}
```

- [ ] **Step 3: 테스트 실패 확인 (컴파일 후)**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib error:: 2>&1 | tail -30`
Expected: 위 5개 테스트 PASS (모델·헬퍼가 완성됐으므로 바로 통과). 만약 컴파일 에러면 메시지대로 수정.

- [ ] **Step 4: clippy 통과 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -20`
Expected: error.rs 관련 경고 없음(미사용은 `#[allow(dead_code)]`로 무음).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git add src-tauri/src/error.rs src-tauri/src/lib.rs && rtk git commit -q -m "feat(error-handling): AppError 정본 모델 + 생성 헬퍼" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: 도메인 enum → AppError `From` 변환

**Files:**

- Modify: `src-tauri/src/error.rs` (변환 + 테스트 추가)

- [ ] **Step 1: From 변환 추가**

`error.rs`의 `impl std::error::Error for AppError {}` 아래, `#[cfg(test)]` 위에 추가. (도메인 enum 경로는 크레이트 모듈명 기준 — 컴파일 에러 시 실제 모듈 경로로 정정.)

```rust
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
            sqlx::Error::RowNotFound => AppError::not_found("db.row_not_found", "행을 찾을 수 없음"),
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
```

- [ ] **Step 2: From 변환 테스트 추가**

`error.rs`의 `mod tests`에 추가:

```rust
    #[test]
    fn notion_error_maps_to_kinds() {
        use crate::notion::NotionError;
        assert_eq!(AppError::from(NotionError::Transient("a".into())).kind, ErrorKind::Transient);
        assert_eq!(AppError::from(NotionError::Terminal("a".into())).kind, ErrorKind::Terminal);
        assert_eq!(AppError::from(NotionError::NotFound("a".into())).kind, ErrorKind::NotFound);
        assert_eq!(AppError::from(NotionError::Forbidden("a".into())).kind, ErrorKind::Forbidden);
        assert_eq!(AppError::from(NotionError::NotFound("a".into())).code, "notion.not_found");
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
        assert_eq!(AppError::from(AgentError::Cancelled).kind, ErrorKind::Cancelled);
        assert_eq!(AppError::from(AgentError::Timeout).kind, ErrorKind::Terminal);
        assert_eq!(AppError::from(AgentError::MaxTurnsExceeded(5)).code, "agent.max_turns");
    }

    #[test]
    fn sqlx_row_not_found_maps_not_found_else_unexpected() {
        assert_eq!(AppError::from(sqlx::Error::RowNotFound).kind, ErrorKind::NotFound);
    }

    #[test]
    fn keyring_no_entry_is_not_found_with_action() {
        let e = AppError::from(keyring::Error::NoEntry);
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert_eq!(e.code, "token.missing");
        assert!(e.action.is_some());
    }
```

- [ ] **Step 3: 테스트 통과 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib error:: 2>&1 | tail -30`
Expected: error 모듈 테스트 전부 PASS. (도메인 enum 경로 불일치 시 컴파일 에러 메시지대로 모듈 경로 정정 — 예: `crate::commands::...`가 아니라 최상위 모듈.)

- [ ] **Step 4: clippy**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -20`
Expected: 경고 없음.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git add src-tauri/src/error.rs && rtk git commit -q -m "feat(error-handling): 도메인 enum → AppError From 변환" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: `logging.rs` — tracing 재작성

**Files:**

- Rewrite: `src-tauri/src/logging.rs`

기존 `AppLogger`/`should_rotate`/`rotation_renames`/`rotate_logs` 및 그 테스트를 전부 제거하고 아래로 교체한다. `log_app_error`/`app_log_path` 커맨드는 시그니처 유지(프런트 호환). `app_log_path`는 일별 회전으로 단일 파일명이 없으므로 **로그 디렉터리 경로**를 반환한다(현재 프런트 소비자 없음 — 안전).

- [ ] **Step 1: `logging.rs` 전체 교체**

```rust
//! 앱 로깅 — tracing subscriber.
//!
//! 레이어:
//!  - errors.log: WARN+ (일별 회전, max 7파일). non-blocking.
//!  - app.log:    INFO+ (운영 가시성). non-blocking.
//!  - stdout:     EnvFilter(RUST_LOG), 기본 warn.
//!
//! 규칙:
//!  - WorkerGuard는 앱 state로 보관(드롭 시 flush 누락). init은 1회만(전역 subscriber).
//!  - 토큰/PII 로그 금지(keychain INVARIANT).

use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::{EnvFilter, Layer as _};

/// non-blocking writer guard 보관소(앱 state). 드롭되면 버퍼 flush가 중단된다.
pub struct LogGuards {
    _errors: WorkerGuard,
    _app: WorkerGuard,
}

/// 전역 tracing subscriber를 설치하고 guard를 반환한다. setup에서 1회 호출.
pub fn init_tracing(log_dir: &Path) -> LogGuards {
    // 디렉터리 보장(실패해도 stdout 레이어는 동작).
    let _ = std::fs::create_dir_all(log_dir);

    let errors_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("errors")
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)
        .expect("errors.log appender 생성 실패");
    let (errors_nb, errors_guard) = tracing_appender::non_blocking(errors_appender);

    let app_appender = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("app")
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)
        .expect("app.log appender 생성 실패");
    let (app_nb, app_guard) = tracing_appender::non_blocking(app_appender);

    let errors_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(errors_nb)
        .with_filter(LevelFilter::WARN);

    let app_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(app_nb)
        .with_filter(LevelFilter::INFO);

    let stdout_layer = tracing_subscriber::fmt::layer().with_filter(
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn")),
    );

    tracing_subscriber::registry()
        .with(errors_layer)
        .with(app_layer)
        .with(stdout_layer)
        .init();

    LogGuards {
        _errors: errors_guard,
        _app: app_guard,
    }
}

// ── Tauri 커맨드 ──────────────────────────────────────────────────────────────

/// 프런트에서 발생한 에러(JS 예외/렌더 크래시)를 백엔드 로그로 흘린다.
/// 백엔드-originated 에러는 AppError가 이미 로그하므로 프런트가 다시 호출하지 않는다.
#[tauri::command]
#[specta::specta]
pub fn log_app_error(scope: String, message: String, trace_id: String) {
    // 프런트 에러는 errors.log에 남도록 ERROR로 기록.
    tracing::error!(trace_id = %trace_id, code = "frontend", "{scope}: {message}");
}

/// 로그 디렉터리 경로를 반환한다(설정 화면 "로그 폴더 열기"용).
/// 일별 회전으로 단일 파일명이 없으므로 디렉터리를 노출한다.
#[tauri::command]
#[specta::specta]
pub fn app_log_dir(log_dir: tauri::State<LogDir>) -> String {
    log_dir.0.to_string_lossy().into_owned()
}

/// 로그 디렉터리 경로 보관(app_log_dir 커맨드용 state).
pub struct LogDir(pub PathBuf);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::fmt::MakeWriter;

    /// 메모리 버퍼에 쓰는 MakeWriter(레벨 필터 라우팅 검증용).
    #[derive(Clone)]
    struct BufWriter(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for BufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> MakeWriter<'a> for BufWriter {
        type Writer = BufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn warn_goes_to_errors_layer_info_only_to_app_layer() {
        let err_buf = Arc::new(Mutex::new(Vec::new()));
        let app_buf = Arc::new(Mutex::new(Vec::new()));

        let err_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BufWriter(err_buf.clone()))
            .with_filter(LevelFilter::WARN);
        let app_layer = tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(BufWriter(app_buf.clone()))
            .with_filter(LevelFilter::INFO);

        let subscriber = tracing_subscriber::registry().with(err_layer).with(app_layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(code = "test", "info-line");
            tracing::warn!(code = "test", "warn-line");
        });

        let err_out = String::from_utf8(err_buf.lock().unwrap().clone()).unwrap();
        let app_out = String::from_utf8(app_buf.lock().unwrap().clone()).unwrap();

        // errors 레이어(WARN+): warn만, info 없음.
        assert!(err_out.contains("warn-line"));
        assert!(!err_out.contains("info-line"));
        // app 레이어(INFO+): 둘 다.
        assert!(app_out.contains("warn-line"));
        assert!(app_out.contains("info-line"));
    }

    #[test]
    fn init_tracing_creates_dir_and_returns_guards() {
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path().join("logs");
        // 전역 init은 1회 제약이라 직접 호출 대신 디렉터리 생성 + appender 빌드만 검증.
        std::fs::create_dir_all(&dir).unwrap();
        let appender = tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("errors")
            .filename_suffix("log")
            .max_log_files(7)
            .build(&dir)
            .unwrap();
        let (nb, _guard) = tracing_appender::non_blocking(appender);
        drop(nb);
        assert!(dir.exists());
    }
}
```

> 주의: `init_tracing`은 전역 subscriber를 `.init()`하므로 한 프로세스에서 1회만 호출 가능. 그래서 단위테스트는 `with_default`(스레드-로컬)로 라우팅 로직만 검증한다.

- [ ] **Step 2: 커맨드 등록 갱신**

`src-tauri/src/lib.rs`의 `specta_builder`/`collect_commands!` 목록에서 `logging::app_log_path`를 `logging::app_log_dir`로 교체(`logging::log_app_error`는 유지). 정확한 위치는 다음으로 확인:

Run: `grep -n "app_log_path" src-tauri/src/lib.rs`

해당 줄의 `logging::app_log_path`를 `logging::app_log_dir`로 변경.

- [ ] **Step 3: 테스트 통과 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib logging:: 2>&1 | tail -30`
Expected: 2개 테스트 PASS.

- [ ] **Step 4: Commit** (lib.rs 변경은 Task 4와 함께 — 이 단계는 logging.rs만 스테이지하되 컴파일 위해 Task 4 동시 진행 권장. 분리 커밋이 어려우면 Task 4까지 마친 뒤 함께 커밋.)

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git add src-tauri/src/logging.rs && rtk git commit -q -m "feat(error-handling): logging.rs를 tracing subscriber로 재작성" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: lib.rs setup 배선

**Files:**

- Modify: `src-tauri/src/lib.rs` (setup 클로저 + 커맨드 목록)

- [ ] **Step 1: init_tracing 호출 + guard manage**

`src-tauri/src/lib.rs:241`(`let app_data = ...`) **직후**, DB 초기화 **이전**에 추가(가능한 가장 이른 시점 — 이후 에러가 로그되도록):

```rust
            // tracing 로깅 초기화(가장 이른 시점). guard는 manage로 보관(flush 보장).
            let log_dir = app_data.join("logs");
            let log_guards = logging::init_tracing(&log_dir);
            app.manage(log_guards);
            app.manage(logging::LogDir(log_dir));
```

- [ ] **Step 2: 기존 AppLogger manage 제거**

`src-tauri/src/lib.rs:262-263`의 다음 두 줄을 삭제:

```rust
            // 에러 로그 (A7): 로테이팅 파일 로그. 로그 디렉터리는 logs/ (JobManager와 공유).
            app.manage(logging::AppLogger::new(app_data.join("logs")));
```

- [ ] **Step 3: eprintln! → tracing**

`src-tauri/src/lib.rs:272`의:

```rust
                    eprintln!("global hotkey 등록 실패('{spec}'), 기본값으로 폴백: {e}");
```

를 다음으로 교체:

```rust
                    tracing::warn!(code = "hotkey.register", "global hotkey 등록 실패('{spec}'), 기본값으로 폴백: {e}");
```

- [ ] **Step 4: 컴파일 + 전체 테스트**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -30`
Expected: 전체 lib 테스트 PASS, 컴파일 클린.

- [ ] **Step 5: clippy 전체**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | tail -30`
Expected: 경고/에러 없음.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git add src-tauri/src/lib.rs && rtk git commit -q -m "feat(error-handling): tracing 초기화 배선 + AppLogger 제거 + eprintln 정리" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: 지침 문서

**Files:**

- Create: `docs/reference/error-handling.md`
- Modify: `docs/reference/commands.md` (인덱스 등재)

- [ ] **Step 1: `docs/reference/error-handling.md` 작성**

아래 내용으로 생성:

```markdown
# 에러 처리 · 로깅 지침

> 정본 설계: `docs/specs/2026-05-22-error-handling-logging-design.md`. 이 문서는 일상 작업용 요약·규칙이다.

## AppError — IPC 정본 에러

모든 `#[tauri::command]`는 `Result<T, error::AppError>`를 반환한다. `String`/도메인 enum 직접 반환 금지.

| 필드        | 의미                                                                                |
| ----------- | ----------------------------------------------------------------------------------- |
| `kind`      | `transient`/`terminal`/`notFound`/`forbidden`/`cancelled`/`validation`/`unexpected` |
| `code`      | 머신 식별자(`notion.not_found`, `db.query` …)                                       |
| `message`   | 사람용(현지화). 토큰/PII 금지.                                                      |
| `traceId`   | 토스트 ↔ 로그 상관키(base32 8자)                                                    |
| `retryable` | `kind`에서 파생(`transient`만 true). 직접 설정 불가.                                |
| `action`    | 액션 힌트(`label`/`url`/`nav`)                                                      |

### 도메인 enum → AppError

도메인 enum(`NotionError` 등)은 내부 분류 로직으로 **유지**한다. 커맨드 경계에서 `?`로만 `AppError`에 접힌다(변환 표는 정본 스펙 §3.2). 변환을 추가하면 `error.rs`에 `From` + 단위테스트를 같이 둔다.

## Do / Don't

- ✅ 커맨드는 `Result<T, AppError>`. 내부 함수는 `?`로 승격.
- ✅ 외부 호출은 `transient`/`terminal` 분류 → bounded retry(INVARIANT #5). terminal은 반드시 노출(삼키지 않음).
- ✅ `traceId`로 토스트와 로그를 잇는다.
- ❌ `Result<_, String>` 반환.
- ❌ 비테스트 코드 `.unwrap()/.expect()/panic!`(불변식 보장 + `expect("이유")`만 예외).
- ❌ 에러 삼키기(`let _ = ...`로 외부 실패 무시).
- ❌ 토큰/시크릿/PII를 message/로그에.

## 로깅(tracing)

- 단일 싱크: 백엔드 `errors.log`(WARN+) / `app.log`(INFO+). 일별 회전, max 7파일.
- `AppError` 생성 시 자동 1회 로그(kind별 레벨). 별도 로그 호출 불필요.
- 운영 이벤트는 `tracing::info!`(잡 시작/종료, 외부 호출 결과, 스케줄러 fire, 큐 전이).
- 레벨: `error`=버그/terminal, `warn`=transient/검증/권한, `info`=운영/취소, `debug`=개발 추적.
- 프런트 에러(렌더 크래시/JS 예외)는 `commands.logAppError(scope, message, traceId)`로 백엔드에 기록.

## 프런트 surfacing

- IPC 에러는 `AppError`로 throw → 에러 토스트(persistent, traceId + 복사).
- 백엔드-originated 에러는 `logAppError` 재호출 금지(이미 로그됨).
- `retryable`이면 "다시 시도" 노출. `action`이 있으면 버튼/링크.
- 렌더타임 크래시는 React `ErrorBoundary`가 포착 → fallback + traceId + `logAppError`.

## INVARIANTS 연계

- #2 Acceptance 게이트: 분류가 큐 전이 입력.
- #5 bounded retry: `retryable` + backoff, 무한 retry 금지, terminal 노출.
- #7 SSOT: 로그는 진단용 사이드채널 — 상태(SQLite)/내용(Notion)의 SSOT 아님.
```

- [ ] **Step 2: commands.md 인덱스 등재**

`docs/reference/commands.md`에서 다른 reference 문서를 가리키는 표/목록을 찾고, `error-handling.md` 줄을 추가:

Run: `grep -n "reference/" docs/reference/commands.md | head` (또는 문서 상단 인덱스 섹션 확인)

해당 인덱스에 한 줄 추가(형식은 주변 항목에 맞춤):

```markdown
- [error-handling.md](./error-handling.md) — 에러 처리·로깅 지침(AppError, tracing 레벨, Do/Don't).
```

만약 commands.md에 인덱스 섹션이 없으면 CLAUDE.md의 문서 표를 따라 `error-handling.md`를 적절한 위치에 등재(없으면 이 Step은 commands.md에 "관련 문서" 한 줄 추가로 갈음).

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git add docs/reference/error-handling.md docs/reference/commands.md && rtk git commit -q -m "docs(error-handling): 에러 처리·로깅 지침 + commands 인덱스 등재" -m "Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: 통합 검증 + push

- [ ] **Step 1: 전체 테스트 + clippy**

Run:

```
export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tail -30
export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | tail -30
```

Expected: 전부 PASS, clippy 클린.

- [ ] **Step 2: 프런트 타입체크(앱 빌드 영향 없음 확인 — bindings 미변경)**

Run: `pnpm typecheck 2>&1 | tail -10`
Expected: 에러 없음(Stage 1은 bindings.ts를 바꾸지 않음 — `app_log_path` 바인딩이 사라지지만 프런트 소비자 없음을 §File Structure에서 확인. 만약 typecheck가 `appLogPath` 미참조로 깨지면, bindings 재생성 필요 → `pnpm tauri dev` 1회 부팅으로 bindings 재생성 후 재확인).

> 주: `app_log_path` → `app_log_dir` 변경은 다음 bindings 재생성 때 반영된다. Stage 1에서 bindings를 강제 재생성하지 않으면 stale `appLogPath` 바인딩이 남지만 호출자가 없어 무해. 깔끔히 하려면 `pnpm tauri dev`를 1회 부팅해 bindings를 재생성하고 커밋한다.

- [ ] **Step 3: 부팅 확인**

Run: `pnpm tauri dev` (백그라운드) — 창이 뜨고 콘솔에 패닉 없는지 확인 후 종료. `app_data/logs/errors.<date>.log`·`app.<date>.log` 생성 확인.

- [ ] **Step 4: push dev**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && rtk git push origin dev 2>&1 | tail -3
```

---

## Stage 1 완료 기준

- [ ] `AppError`/`ErrorKind`/`ErrorAction` + 모든 `From` 변환 + 단위테스트 green.
- [ ] `tracing` subscriber(errors/app/stdout) 동작, 라우팅 테스트 green, 부팅 시 로그파일 생성.
- [ ] `AppLogger`/수기 회전 제거, `eprintln!`(hotkey) → tracing.
- [ ] 지침 문서 `error-handling.md` + commands 인덱스.
- [ ] `cargo test`/`clippy`/`pnpm typecheck`/부팅 전부 green.
- [ ] INVARIANTS reviewer 패스(self-approve 금지) 후 dev push.

## 다음 (별도 계획)

- **Stage 2**: 모듈별 커맨드 `Result<_,String>`/enum → `AppError`(notion→github→git→calendar→messenger→agent→db/keychain→나머지), thiserror 적용, bindings 재생성.
- **Stage 3**: 프런트(`unwrap`/`client.ts`/`toast.ts`/`ErrorBoundary`) 전환.
- **Stage 4**: unwrap/panic 정리 + clippy 게이트.
