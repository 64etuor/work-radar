
# IPC Conventions — Rust ↔ TypeScript boundary

## tauri-specta = 타입 생성 정본

- 커맨드/이벤트는 `#[tauri::command]` + `#[specta::specta]`로 선언, `cargo test`가
  `src/bindings.ts`를 emit한다.
- **수기 TS IPC 타입 금지.** drift는 CI 게이트(`git diff --exit-code src/bindings.ts`).
- `specta`는 i64 export 금지(BigInt 정밀도) → DB가 `INTEGER`라도 IPC 모델은 `i32`/`String`
  으로 좁힌다(예: `today_rank: i32`).

## 커맨드 시그니처 = `Result<_, AppError>`

- 모든 `#[tauri::command]`는 `Result<T, AppError>`를 반환. 도메인 에러는 `From`으로
  `AppError`로 접힌다.
- 내부 헬퍼는 도메인/`String` 에러 사용 OK — 경계에서만 `AppError`로 접는다.
- `AppError`는 `{kind, code, message, traceId, retryable, action}` envelope. 단일 호출
  지점에서 tracing 1회 기록(`AppError::*` 생성 헬퍼). 재로그 금지(스펙 §5.3).
- 프로덕션 `unwrap()` 금지 — `lib.rs`에 `#![cfg_attr(not(test), deny(clippy::unwrap_used))]`.
  `expect(불변식 설명)`은 허용된 escape hatch.

## 외부 호출은 Rust에 (렌더러 노출 금지)

- Notion: `reqwest` (12s timeout, `Notion-Version` 헤더는 `notion::NOTION_VERSION` 단일 출처).
- GitHub: `octocrab` (rustls-tls).
- Google Calendar: `reqwest` + PKCE(S256) loopback OAuth.
- RSS/뉴스: `reqwest` + 어댑터(news-feature.md).
- Messenger(Hermes/Telegram): bot token + bounded `getUpdates`.

토큰은 **렌더러에 절대 노출되지 않는다**. `set_project_token(token: String)`처럼 입력으로만
받고 즉시 keychain 저장, 반환은 boolean 상태(`hasNotion`/`hasGithub`)만.

## Keychain (`keyring 3.x`)

- `keyring` 3.6.x `apple-native`. 4.x는 backend 재패키징으로 미채택.
- account 키 = `{credential_ref}:{kind}` — 같은 project가 Notion·GitHub·Calendar 토큰을
  각각 분리 저장. project 간 분리(개인 ≠ 업무).
- `credential_ref`는 백엔드가 생성하는 opaque(`lower(hex(randomblob(16)))`), `project.id`와 별개.

## Bounded retry only (INVARIANT #5)

- `src-tauri/src/retry.rs` `Retryable` 트레이트 + `with_retry`. 에러가 자기-분류
  (호출자 임의 설정 불가).
- backoff + jitter + terminal failure 노출. 무한 retry/poll 금지.
- 전부-실패 시 분류 보존(전부 transient → transient, 혼합 → terminal). `sync_pr_radar`
  결정(decisions 410e86f) 참조.

## Acceptance 게이트 (INVARIANT #2)

- 외부 mutate를 일으키는 모든 커맨드는 `record_acceptance`/`reject_run`/`finalize`
  (in `commands/agent_run_store.rs`)를 거친다. 단일 감사 지점.
- Today 승격(`Promotion(target:"today")`)은 로컬 액션이라 게이트 불요.
- 캘린더 이벤트 생성(Phase 19)은 사용자 폼=사람 결정으로 게이트 제거.

## Capabilities (`src-tauri/capabilities/default.json`)

새 커맨드는 capability에 추가해야 프런트에서 호출 가능. INVARIANT 6 (Codex danger 금지)
관련 capability는 신설 금지.

## 로그 PII / 외부 본문 금지

- `classify_http`(calendar/messenger/notion)는 응답 본문을 로그하지 않는다. 상태코드 +
  크기(`응답 {len}B`)만 노출(decisions `7ddcd0c`).
- `AppError.message`/`details`에 raw 토큰/PII 금지.

## 프런트 surfacing (`src/lib/query/client.ts`)

- `unwrap()`이 `IpcError extends Error`(AppError 보유) throw — traceId/retryable/action 보존.
- `pushError(string | AppError)` — backend traceId 재사용, 중복 토스트 가드, 재로그 금지.
- `ToastHost` action 버튼(url=openUrl / nav=goTo via NAV_BY_VIEW) + retryable 시 refetch
  (`QueryCache.onError`에서 `query.fetch()` 주입; mutation은 의도적 전역 미처리).
- React `ErrorBoundary`(main.tsx 마운트, 로그 payload 2KB 상한).

## 커맨드 모듈 구조

- `src-tauri/src/commands/<domain>.rs` 또는 `commands/<domain>/{mod,sub}.rs`로 분리.
- `mod.rs`가 `pub use`로 재노출 — IPC 표면 일관 유지.
- 큰 도메인(agents, today, routines)은 서브모듈로 분리됨 — 새 커맨드는 적절한 서브모듈 또는
  domain 파일에 추가.

## `commands/X.rs` ↔ `X.rs` 경계 — 의도된 글루 vs 도메인

이 레포는 의도적으로 두 층을 가진다:

| 층                          | 책임                                                                                | import 가능                                                |
| --------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `src-tauri/src/X.rs` (도메인) | 타입 / 트레이트 / HTTP provider / OAuth 순수 로직 / 파서 / 분류기 / RateLimiter      | `crate::retry`, `crate::error`, 표준 라이브러리만           |
| `src-tauri/src/commands/X.rs` (글루) | `#[tauri::command]` 핸들러 + **그 핸들러가 필요로 하는 cross-subsystem orchestration** | `crate::db`, `crate::keychain`, `crate::commands::*`, 도메인 모듈 |

**글루의 정상 거주지는 `commands/X.rs`.** DB + keychain + provider를 함께 부르는 함수
(`access_token_for`, `fetch_events_windowed` 등)는 `commands/X.rs`에 있는 것이 맞다.
이를 `X.rs`로 옮기면 도메인 모듈이 `use crate::db; use crate::keychain` 의존을 얻어
순수성이 깨진다 — **strictly 후퇴**.

분해 채택 기준(audit 권장을 실측 검증한 패턴):

1. **순수 도메인이면** `X.rs`로 옮긴다(분류기, 파서, HTTP provider 등).
2. **DB+keychain+provider 글루이면** `commands/X.rs`에 둔다(자연 위치).
3. **IPC 핸들러(`#[tauri::command]`)이면** `commands/X.rs`에 둔다(이동 불가).

audit-rust.md가 본 "leak"이 사실 의도된 글루 패턴인 경우가 있다(2026-05-26 PR-R-CalendarLeak
재평가 — `docs/plans/2026-05-26-harness-and-design-rigor.md` §후행 재평가 노트).
분해 전 위 기준으로 후보를 분류하라.

## 정본 / 참조

- `src-tauri/src/error.rs` — `AppError` 정의 + From
- `src-tauri/src/retry.rs` — `Retryable` 트레이트
- `src-tauri/src/keychain.rs` — keyring 래퍼
- `src-tauri/src/notion.rs` — `NOTION_VERSION` 단일 출처
- `src-tauri/src/commands/mod.rs` — 커맨드 색인
- `docs/specs/2026-05-22-error-handling-logging-design.md` — error envelope 정본
- `docs/reference/error-handling.md` — Do/Don't
