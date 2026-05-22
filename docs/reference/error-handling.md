# 에러 처리 · 로깅 지침

> 정본 설계: `docs/specs/2026-05-22-error-handling-logging-design.md`. 이 문서는 일상 작업용 요약·규칙이다.

## AppError — IPC 정본 에러

모든 `#[tauri::command]`는 `Result<T, error::AppError>`를 반환한다. `String`/도메인 enum 직접 반환 금지.

| 필드 | 의미 |
|---|---|
| `kind` | `transient`/`terminal`/`notFound`/`forbidden`/`cancelled`/`validation`/`unexpected` |
| `code` | 머신 식별자(`notion.not_found`, `db.query` …) |
| `message` | 사람용(현지화). 토큰/PII 금지. |
| `traceId` | 토스트 ↔ 로그 상관키(base32 8자) |
| `retryable` | `kind`에서 파생(`transient`만 true). 직접 설정 불가. |
| `action` | 액션 힌트(`label`/`url`/`nav`) |

### 도메인 enum → AppError

도메인 enum(`NotionError` 등)은 내부 분류 로직으로 **유지**한다. 커맨드 경계에서 `?`로만 `AppError`에 접힌다(변환 표는 정본 스펙 §3.2). 변환을 추가하면 `error.rs`에 `From` + 단위테스트를 같이 둔다.

### 커맨드 변환 idiom (수렴 규칙)

- **From이 있는 에러(도메인/sqlx/keyring/reqwest/io)**: `?`로 승격. 분류(transient/terminal/...)가 보존되므로 `.map_err(|e| e.to_string())`로 절대 납작화하지 말 것. 본문이 그 한 식이면 `Ok(expr?)`.
- **From이 없는 String 헬퍼/serde 등**: 의미에 맞는 생성자로 명시 — 검증 `AppError::validation`, 없음 `AppError::not_found`, 내부버그(serde 직렬화 등) `AppError::unexpected`, 그 외 `AppError::terminal`. `code`는 `"<모듈>.<사유>"`.
- 같은 연산은 같은 `code`+같은 `kind`로 통일(예: `agents.new_run_id`는 항상 `unexpected`).

## Do / Don't

- ✅ 커맨드는 `Result<T, AppError>`. 내부 함수는 `?`로 승격.
- ✅ 외부 호출은 `transient`/`terminal` 분류 → bounded retry(INVARIANT #5). terminal은 반드시 노출(삼키지 않음).
- ✅ `traceId`로 토스트와 로그를 잇는다.
- ❌ `Result<_, String>` 반환.
- ❌ 비테스트 코드 bare `.unwrap()` — **CI 강제**(`lib.rs`의 `#![cfg_attr(not(test), deny(clippy::unwrap_used))]`, clippy `-D warnings`). 불변식이면 `.expect("이유")`(사유 명시 = 허용된 탈출구), 아니면 `?`+`AppError`. 테스트는 unwrap 허용.
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
