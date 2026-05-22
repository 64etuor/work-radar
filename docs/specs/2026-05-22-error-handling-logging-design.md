# Error Handling + Logging — 정본 설계

> 상태: 승인됨 (2026-05-22) · 범위: 전면 마이그레이션 · 로깅: `tracing` 생태계 · 에러: 단일 정본 `AppError` envelope · `thiserror` 채택

이 문서는 Work Radar의 **이상적 에러 처리·로깅 체계**의 정본 설계다. 구현은 여러 PR로
분할되며(§9), 완료 후 규칙은 `docs/reference/error-handling.md`(지침)로 요약·상주한다.

관련 정본: `AGENTS.md`(기술 제약), `PLAN.md §1`(INVARIANTS), `docs/architecture.md`(IPC 계약).

---

## 1. 동기 — 현재 상태의 갭

세 가지 에러 패턴이 공존하고, IPC 경계에서 분류가 손실된다.

| 영역 | 현재 | 문제 |
|---|---|---|
| IPC 에러 타입 | 149개 커맨드가 `Result<_, String>` | 분류 손실 — 프런트가 transient/terminal 구분 불가 |
| 도메인 enum | `NotionError`/`GithubError`/`CalendarError`/`MessengerError`/`AgentError` (Transient/Terminal/NotFound/Forbidden 분류 우수) | `Serialize`/`specta::Type` 미파생 → 경계에서 `Display`로 납작해짐 |
| 기타 | `GitError(String)` newtype, `sqlx::Error`/`keyring::Error` 시그니처 누출 | 내부 에러 형이 IPC로 새어나갈 위험 |
| 백엔드 로깅 | `AppLogger`(rotating `errors.log`)가 **프런트(`toast.ts`)에서만 호출** | Rust 측 retry 소진·잡 kill·삼킨 에러가 추적 불가 |
| 로깅 수준 | `tracing`/레벨/스팬 없음, ERROR-only | 운영 가시성 없음, 구조적 필드 없음 |
| 프런트 | `unwrap()` throw, persistent 토스트(trace_id+복사), per-component mutation 처리 | React `ErrorBoundary` 부재 → 렌더 크래시 미포착 |

**유지할 좋은 자산**: `trace_id`(프런트 `genTraceId`, base32 8자)가 토스트↔로그 상관키로
이미 동작 — 이 척추(spine)에 백엔드 로깅을 끼워 넣는다.

---

## 2. INVARIANTS 연계

- **#2 모든 외부 변경은 Acceptance 게이트** — 에러 분류(Transient/Terminal)가 큐 전이·재시도 결정의 입력. 분류를 IPC로 보존해야 한다.
- **#5 bounded retry only** — `retryable` 플래그 + backoff. 무한 retry/poll 금지. terminal failure는 반드시 노출(삼키지 않음).
- **#7 SSOT 분리** — 로그는 진단용 사이드채널. 상태는 SQLite, 내용은 Notion. 로그가 SSOT가 되면 안 된다.
- **토큰/PII 금지** — keychain INVARIANT. 토큰·시크릿·개인정보는 어떤 레벨에서도 로그 금지.

---

## 3. 정본 에러 모델 (`src-tauri/src/error.rs`, 신설)

IPC 경계를 넘는 **유일한** 에러 타입.

```rust
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub code: String,                 // 머신 식별자: "notion.not_found", "db.query", "agent.timeout" …
    pub message: String,              // 사람용(현지화) — Display 출력
    pub trace_id: String,             // 토스트 ↔ 로그 상관키 (base32 8자)
    pub retryable: bool,              // kind에서 파생 (Transient → true, 그 외 false)
    pub action: Option<ErrorAction>,  // 액션 가능 힌트
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Transient,   // 네트워크/429/5xx — bounded retry/큐잉 대상
    Terminal,    // 4xx 일반/검증 실패 — 재시도 무의미
    NotFound,    // 404 — 액션 가능(DB ID/공유 확인 등)
    Forbidden,   // 403/권한 — 액션 가능(통합 권한 등)
    Cancelled,   // kill switch/사용자 취소
    Validation,  // 입력 검증 실패
    Unexpected,  // 버그/불변식 위반 — 로그 + 버그리포트 유도
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorAction {
    pub label: String,          // "Notion에서 열기", "설정 열기"
    pub url: Option<String>,    // 외부 딥링크
    pub nav: Option<String>,    // 앱 내부 네비게이션 키
}
```

### 3.1 생성 헬퍼 + trace_id

- `AppError::transient(code, msg)` / `terminal` / `not_found` / `forbidden` / `cancelled` / `validation` / `unexpected`.
- `retryable`은 `kind`에서 파생(Transient=true). 생성자에서 강제 — 호출자가 직접 세팅 못 함.
- `with_action(action)` 빌더로 액션 부착.
- `trace_id`가 주어지지 않으면 백엔드가 생성(프런트 `genTraceId`와 **동일** base32 알파벳 `abcdefghijklmnopqrstuvwxyz234567`, 8자). 생성 로직은 Rust/TS 양쪽에 동일 사양으로 둔다.
- `impl std::error::Error + Display for AppError` — `message`를 Display로.

### 3.2 도메인 enum → AppError 변환 (`From`)

도메인 enum은 **내부에 그대로 유지**(분류 로직 보존). 커맨드 경계에서 `?`로만 접힌다.

| From | → ErrorKind | code 접두 | 비고 |
|---|---|---|---|
| `NotionError::Transient` | Transient | `notion.transient` | |
| `NotionError::Terminal` | Terminal | `notion.terminal` | |
| `NotionError::NotFound` | NotFound | `notion.not_found` | action: DB 공유 안내 |
| `NotionError::Forbidden` | Forbidden | `notion.forbidden` | action: 통합 권한 안내 |
| `GithubError::*` | (동형 매핑) | `github.*` | |
| `CalendarError::*` | (동형 매핑) | `calendar.*` | |
| `MessengerError::*` | (동형 매핑) | `messenger.*` | |
| `AgentError::Timeout` | Terminal | `agent.timeout` | bounds 초과 kill |
| `AgentError::Cancelled` | Cancelled | `agent.cancelled` | |
| `AgentError::MaxTurnsExceeded` | Terminal | `agent.max_turns` | |
| `AgentError::CostCapExceeded` | Terminal | `agent.cost_cap` | |
| `AgentError::Spawn` | Terminal | `agent.spawn` | |
| `AgentError::Failed` | Terminal | `agent.failed` | |
| `GitError(String)` | Terminal | `git.error` | 향후 분류 세분화 여지 |
| `sqlx::Error::RowNotFound` | NotFound | `db.row_not_found` | |
| `sqlx::Error` (그 외) | Unexpected | `db.query` | 로컬 DB=대체로 버그 |
| `keyring::Error::NoEntry` | NotFound | `token.missing` | action: 설정에서 토큰 등록 |
| `keyring::Error` (그 외) | Terminal | `token.keychain` | |
| `reqwest::Error` (timeout/connect) | Transient | `net.transient` | |
| `reqwest::Error` (그 외) | Terminal | `net.error` | |
| `std::io::Error` | Unexpected | `io.error` | |

> 모든 From 변환은 단위 테스트로 kind/retryable/code를 고정한다(§8).

### 3.3 `thiserror` 채택

도메인 enum의 수기 `Display`/`Error` impl을 `thiserror::Error` derive로 정리한다(컴파일타임
전용, 런타임 0). `#[error("...")]` 어트리뷰트로 Display 메시지를 선언적으로. `AppError` 자체는
`Serialize`+`specta::Type`가 필요하므로 수기 `Display`/`Error`를 유지(또는 thiserror와 병행).

---

## 4. IPC 경계 적용 (전면)

- **149개 `Result<_, String>` + 도메인 enum 반환 커맨드 전부 → `Result<T, AppError>`**.
- 내부 함수는 도메인 enum 유지, 커맨드에서 `?`로 `From` 승격.
- `anyhow` **도입 안 함** — 분류 보존 우선 + dep 최소. "기타 내부 에러"는 `AppError::unexpected`/`From<io::Error>` 등으로 직접.
- `bindings.ts` 재생성 → 에러 타입이 `string`에서 `AppError`로. specta가 `AppError`/`ErrorKind`/`ErrorAction` TS 타입 생성.

---

## 5. 로깅 (`tracing` 재작성 — `src-tauri/src/logging.rs`)

### 5.1 Subscriber 레이어

`init_tracing(log_dir) -> WorkerGuard`:

- **errors.log** — `tracing-appender` rolling + `WARN`/`ERROR` 필터, non-blocking. (기존 1 MiB×5 수기 회전을 appender rolling으로 대체.) 포맷: 타임스탬프 + level + `trace_id` + `code` + scope(target) + message.
- **app.log** — `INFO`+ 운영 가시성: 잡 시작/종료, 외부 호출 결과, 스케줄러 fire, 큐 전이, 마이그레이션. rolling.
- **stdout(dev)** — `EnvFilter`(`RUST_LOG`), 릴리즈 빌드는 `WARN`+ 또는 비활성.
- non-blocking `WorkerGuard`를 Tauri managed state로 보관(드롭 시 flush 누락 방지).

### 5.2 에러 ↔ 로그 통합

- **단일 로그 지점**: `AppError` 생성 헬퍼(§3.1) 내부에서 1회 `tracing` 기록한다. `From` 변환은 반드시 이 헬퍼를 경유하므로 로그 지점이 하나로 모인다. 이미 `AppError`인 값은 재래핑·재로깅하지 않는다(중복 금지). 레벨 매핑:
  - `Unexpected`/`Terminal` → `tracing::error!`
  - `Transient` → `tracing::warn!`
  - `Cancelled` → `tracing::info!`
  - `Validation`/`NotFound`/`Forbidden` → `tracing::warn!`
- 필드: `trace_id`, `code`, `kind`. **백엔드가 직접 로그**한다(현재 갭 해소).

### 5.3 trace_id 단일 싱크

- **백엔드-originated 에러**: 백엔드가 `trace_id` 생성 + 즉시 로그 → 프런트는 그 `trace_id`로 토스트만 표시(재로깅 금지, 중복 방지).
- **프런트-originated 에러**(IPC 외 JS 로직·렌더 크래시): 프런트 `genTraceId` → `log_app_error`로 백엔드 `errors.log`에 기록.
- 결과: **모든 로그는 백엔드 단일 싱크**(`errors.log`/`app.log`), `trace_id`가 토스트↔로그 상관.

### 5.4 유지 커맨드

- `log_app_error(scope, message, trace_id)` — 프런트 에러를 백엔드 tracing으로 흘리는 통로(여전히 `errors.log` 기록). 시그니처 유지(하위호환).
- `app_log_path()` — 설정 화면 "로그 열기"용 `errors.log` 경로 반환. 유지.

### 5.5 금지

- 토큰/시크릿/PII 로그 금지(모든 레벨). 외부 응답 바디를 통째로 로그하지 않는다(코드/상태만).

---

## 6. Frontend

- `unwrap()`(`client.ts`): `string` 대신 `AppError`를 throw. JS 측 `AppError` 래퍼로 `.message/.traceId/.kind/.retryable/.action` 노출.
- `toast.ts`: `pushError`가 `AppError`를 받으면 `traceId`/`action` 재사용(프런트 재생성 X). 백엔드-originated는 `logAppError` 호출 생략(이미 로그됨). `retryable`이면 "다시 시도" 액션 훅.
- **React `ErrorBoundary` 신설**(현재 부재): 렌더타임 크래시 포착 → fallback UI + `traceId` + `logAppError`. 앱 셸 루트에 장착.
- `QueryCache.onError`: `AppError` 인지(메시지/traceId 전달). mutation은 현행 per-component 유지.

---

## 7. unwrap / panic 정책

- 비테스트 코드의 `.unwrap()/.expect()/panic!`는 **불변식이 보장될 때만**, `expect("이유")`로 사유 명시. 그 외 `?` + `AppError`.
- workspace clippy: `unwrap_used`/`expect_used` = `warn`(현 ~442개라 일괄 `deny` 비현실적). 신규 코드 deny 지향, 마이그레이션 중 점진 제거. 정책은 지침 문서화(§8 산출물).

---

## 8. 산출물 — 지침 문서 `docs/reference/error-handling.md`

`docs/reference/commands.md` 인덱스에 등재. 내용:

- `AppError` 모델 + `ErrorKind` 의미 + `retryable`/`action` 규약.
- 도메인 enum → `AppError` 매핑 규칙(§3.2 표).
- **Do/Don't**: IPC에서 `String` 반환 금지 · `unwrap` 금지 · 에러 삼키기 금지(terminal 노출) · bounded retry · `trace_id` 규약.
- 로깅 레벨 가이드(error/warn/info/debug 언제) + 무엇을 로그/금지(토큰·PII).
- 프런트 surfacing 규약(persistent 토스트 · ErrorBoundary · retry).
- INVARIANTS(#2/#5/#7) 연계.

---

## 9. 검증

- `AppError` `From` 변환 단위테스트 — 각 variant → 올바른 `kind`/`retryable`/`code` 고정.
- 로깅 레이어 테스트(임시 dir) — ERROR는 `errors.log`에, INFO는 `app.log`에 기록되는지 분리 확인.
- `tracing-appender` 회전 smoke.
- specta 재생성 후 `pnpm typecheck`(프런트 `AppError` 사용처 컴파일).
- `cargo test` + `cargo clippy`, `pnpm typecheck` + lint, `pnpm tauri dev` 부팅.

---

## 10. Migration staging (PR 분할 — "한 PR=한 관심사")

분류 refactor는 단일 관심사이므로 PR을 모듈 단위로 쪼갠다. feature와 섞지 않는다(AGENTS 금지).

1. **PR1 — 인프라**: `error.rs`(`AppError`/`ErrorKind`/`ErrorAction` + `From` 변환들) + `tracing` init(`logging.rs` 재작성) + `Cargo.toml` deps(`tracing`/`tracing-subscriber`/`tracing-appender`/`thiserror`) + 지침 문서(`error-handling.md`). 커맨드 미변경(단 bindings에 `AppError` 타입 등장).
2. **PR2~n — 모듈별 커맨드 전환**: `notion` → `github` → `git` → `calendar` → `messenger` → `agent` → `db`/`keychain` → 나머지. 모듈당 1 PR, `Result<_,String>`/enum → `AppError`, 도메인 enum에 thiserror 적용.
3. **PRn+1 — 프런트**: `unwrap`/`client.ts`/`toast.ts`/`ErrorBoundary` 전환 + `bindings.ts` 재생성.
4. **PRn+2 — 정리**: `unwrap`/`panic` 정리 + clippy 게이트.

각 PR은 INVARIANTS reviewer 패스(self-approve 금지) 후 dev에 머지.

---

## 11. 비목표 (YAGNI)

- 원격 에러 수집(Sentry 등) — 로컬 단일 싱크로 충분, 도입 안 함.
- `anyhow` 전역 도입 — 분류 보존과 충돌.
- 로그를 SSOT로 승격 — INVARIANT #7 위반.
- 일괄 `unwrap` deny — 비현실적, 점진 제거.
