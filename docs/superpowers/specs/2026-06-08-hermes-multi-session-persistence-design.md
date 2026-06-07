# Hermes 다중 세션 + 영구 기억 — Design Spec

- **Date:** 2026-06-08
- **Status:** Approved (design), pending implementation plan
- **Area routing:** `src/components/hermes/**` (frontend-shell), `src-tauri/src/commands/hermes_agent.rs` + `src-tauri/src/hermes_agent/**` (ipc-conventions), `src-tauri/migrations/**` + `src-tauri/src/db.rs` (data-layer-conventions), `DESIGN.md` (visual)

## 1. Problem

Hermes(별도 자율 코딩 에이전트, ACP over stdio)의 세션 라이프사이클 관리가 빈약하다:

- 세션이 `Hermes 1 / 2 / 3` 순번으로만 명명된다(`pickDefaultName` — 단순 카운팅, 카테고리 아님).
- 동시 세션이 **하드캡 3개**로 제한된다(`HERMES_TAB_CAP = 3`, Rust SSOT + FE fallback).
- 대화 내용이 **RAM(Zustand)에만** 존재 → 앱 재시작 시 전부 소실. DB 테이블 없음.
- UX가 좁은 탭 바 하나뿐 — 현대 에이전트 관리 앱(ChatGPT/Claude desktop 류)의 세션 목록·검색·영속 대화 같은 기준에 못 미친다.

## 2. Goals

1. **"1/2/3" 순번 명명 제거** → 첫 사용자 메시지 기반 자동 제목 + 인라인 rename.
2. **3개 제한 제거** → 무제한 세션 목록 + 동시 _실행_ 세션이 많을 때 부드러운 경고 배너만.
3. **대화 영구 저장 + 재개** → SQLite 영속화, 앱 재시작 후 전체 히스토리 즉시 복원, 다음 전송 시 직전 대화 컨텍스트 replay.
4. **좌측 세션 사이드바 UX** — 기존 떠 있는 panel 안에서 세션 목록/검색/상태/미리보기.
5. **현대 앱 UX 디테일** — 검색, 상태점, 상대 시각, 키보드 단축키, 빈 상태/스켈레톤, 자동 제목.

## 3. Non-Goals (YAGNI / 후속)

- 세션별 서로 다른 작업 디렉터리(cwd). (현재 전 세션 공유 cwd 유지)
- ACP `session/load` 기반 진짜 서버사이드 재개. (capability 감지 + 라이브 스모크 후 후속 최적화)
- 세션 폴더/태그 그룹핑, 클라우드 동기화.
- 새 메시지 producer / inbox 연동.

## 4. Current Architecture (as-found)

- **Panel:** `HermesPanel.tsx` — 떠 있는 `role="dialog"`, 드래그/리사이즈, bounds는 `app_config`에 영속(`useHermesPanelState`).
- **State:** `useHermesTabsStore.ts` (zustand) + `useHermesTabs.ts`(reducer). `TabState { id, name, status, messages[], commandsList[] }` — RAM only.
- **Cap:** `hermes_agent_cap()` → 3, FE는 mount 시 읽음. spawn 시 Rust가 cap 재검사(`hermes_agent.rs`).
- **ACP:** `acp_client.rs::AcpSession::spawn` — `hermes acp` child spawn → `initialize` → `session/new {cwd, mcpServers}` → `sessionId`. child는 `kill_on_drop`. **`session/load` 미구현.** 메시지는 `session/update` 노티 → Tauri 이벤트 → FE reducer가 조립.
- **불변:** 항상 ≥1 탭 유지(마지막 탭 닫으면 빈 탭 자동 생성).

## 5. Target Architecture

### 5.1 데이터 모델 (새 마이그레이션)

마이그레이션으로만 스키마 변경(임의 ALTER 금지 — data-layer-conventions). 새 파일 `src-tauri/migrations/00XX_hermes_sessions.sql`:

```sql
CREATE TABLE hermes_session (
  id            TEXT PRIMARY KEY,           -- uuid (FE uid()와 동일 형식)
  name          TEXT NOT NULL,              -- 자동 제목 또는 사용자 지정
  status        TEXT NOT NULL DEFAULT 'idle', -- idle|running|error (마지막 관측 상태; 재시작 후 idle로 정규화)
  cwd           TEXT,                        -- 향후 세션별 cwd 대비(현재 NULL = 공유 cwd)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE hermes_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES hermes_session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,             -- 세션 내 정렬 순서
  role        TEXT NOT NULL,                -- user|assistant|system
  content     TEXT NOT NULL DEFAULT '',     -- 누적 텍스트
  tool_json   TEXT,                          -- 직렬화된 tool-call 요약(assistant turn). NULL 가능
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_hermes_message_session ON hermes_message(session_id, seq);
```

> id 타입: PK는 정수(AUTOINCREMENT)지만 IPC로 넘기는 PK는 항상 i32(specta i64 금지 — 메모리 규율). `hermes_message.id`를 IPC로 노출할 경우 i32 캐스팅. `session.id`는 TEXT(uuid)라 무관.

### 5.2 Rust 영속 계층 + IPC

`src-tauri/src/hermes_agent/session_store.rs`(신규, sqlx) + `hermes_agent.rs`에 커맨드 추가. 모든 외부/DB I/O는 Rust(렌더러 토큰/직접 DB 접근 금지 — ipc-conventions). `Result<_, AppError>` envelope.

새 커맨드(tauri-specta → `bindings.ts` 재생성, drift = CI 게이트):

- `hermes_sessions_list() -> Vec<HermesSessionRow>` — archived=0, last_active_at desc.
- `hermes_session_create(name?) -> HermesSessionRow`
- `hermes_session_rename(id, name)`
- `hermes_session_archive(id)` / `hermes_session_delete(id)` (delete = CASCADE 메시지 제거)
- `hermes_session_messages(id) -> Vec<HermesMessageRow>`
- `hermes_message_append(session_id, role, content, tool_json?) -> i32(seq)` — updated_at/last_active_at 갱신.

기존 `HERMES_TAB_CAP`/`hermes_agent_cap()` **삭제**. FE의 cap 분기 제거.

### 5.3 저장 시점 (프런트 주도)

리듀서가 이미 user/assistant 메시지를 조립하므로 재사용:

- `send()`에서 user dispatch 직후 `hermes_message_append(role="user")`.
- `turn-end` 처리 시 해당 turn의 누적 assistant 텍스트 + tool 요약을 `hermes_message_append(role="assistant", tool_json=...)`.
- `system` 레벨 메시지(에러 등)도 best-effort append(role="system").

append 실패는 best-effort(대화 흐름 막지 않음) — 단 실패를 조용히 삼키지 말고 한 번 system 라인으로 노출.

### 5.4 복원 + 재개

- 앱 launch / 패널 첫 오픈 시 `hermes_sessions_list()` → 사이드바. 활성 세션 선택 시 `hermes_session_messages(id)`로 우측 대화 복원(전부 DB에서, child spawn 없음).
- **재개 계약:** 죽은(live child 없는) 세션에 새 메시지를 전송하면 Rust가 기존 lazy-spawn으로 fresh `session/new` 생성. 재시작 후 그 세션의 _첫_ 전송이면 **최근 N개 메시지(기본 N=20)를 컨텍스트 preamble로 replay**해서 이어서 진행.
  - replay 위치: Rust `hermes_agent_send`가 "이 tab의 첫 prompt이고 DB에 직전 히스토리가 있으면" preamble 블록을 prompt 앞에 prepend. (FE가 직전 메시지를 넘기거나, Rust가 `hermes_session_messages`로 조회 — 구현 플랜에서 확정. 토큰 bound 위해 N 제한.)
  - 정직성: 이는 "컨텍스트 이어가기"이지 에이전트 내부 메모리 복원이 아니다. 진짜 `session/load`는 Non-Goal.

### 5.5 프런트엔드

- `HermesPanel`은 floating shell 유지, 내부를 `[Sidebar | ChatPane]` 2-컬럼으로. 기본 bounds 폭 확대(≈720). 좁으면 사이드바 collapse(아이콘 레일).
- 신규: `components/hermes/HermesSidebar.tsx`(목록·검색·상태점·미리보기·rename·삭제/보관·+새 세션), 빈 상태/스켈레톤.
- `useHermesTabsStore` 확장: 세션 목록을 DB와 동기화(`sessions` 로드, create/rename/archive/delete가 IPC + 낙관적 갱신), 메시지 lazy-load + append 영속. "탭(tab)" 어휘는 "세션(session)"으로 정리하되 내부 reducer 재사용.
- 자동 제목: 첫 user 메시지 시 세션명이 비어있거나 기본이면 메시지 앞부분으로 rename(IPC 영속).
- 키보드: ⌘N 새 세션, ⌘W 활성 닫기/보관, ⌘1–9 세션 전환(패널 포커스 시). 기존 Esc 닫기 계약 유지(shadcn-migration Esc 규율).
- 경고 배너: 동시 live child ≥ 임계(기본 8) 시 사이드바 상단 가벼운 경고(차단 아님).

### 5.6 불변/규율 준수

- IPC = tauri-specta 생성 타입만, 수기 TS IPC 금지, bindings drift CI 게이트.
- 스키마는 마이그레이션으로만.
- 외부/DB I/O는 Rust, AppError 단일 envelope, clippy `-D warnings` + `unwrap_used` 금지.
- 로그 PII/시크릿 금지(대화 본문 로그 금지 — 크기/카운트만).
- 시각: shadcn/ui + lucide + `DESIGN.md` 토큰. 마케팅 컴포넌트 비대상.

## 6. 검증 (done-criteria 후보)

- Rust: `cargo test`(session_store CRUD + append seq + cascade delete 단위 테스트) + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
- FE: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`(사이드바 grouping/자동제목/검색 필터 순수 로직 테스트).
- bindings drift 0.
- 통합: `pnpm tauri dev` 부팅 → 세션 2개 생성·각각 대화 → 앱 재시작 → 두 세션 + 히스토리 복원 확인 → 한 세션에 후속 전송 시 컨텍스트 이어짐(라이브 스모크 = 사용자/cmux, 에이전트는 native WKWebView 클릭 불가).
- 제한 제거 회귀: 4개+ 세션 동시 생성 가능, 경고 배너 임계 동작.

## 7. 위험 / 롤백

- **replay 토큰 비용 / 컨텍스트 초과:** N bound + (후속) 요약. v1은 최근 N개 고정.
- **마이그레이션 비가역:** sqlx checksum immutable — 새 번호로만 추가, 기존 수정 금지.
- **"항상 ≥1 탭" 불변 완화:** 세션 0개 = 빈 상태 CTA로 대체(자동 생성 폐지) → 부팅 경로/StrictMode 이중 마운트 가드 재확인 필요.
- 롤백: 마이그레이션은 additive(기존 테이블 무변경), FE/Rust 커맨드는 신규 추가 위주 → 기능 플래그 없이도 이전 동작과 공존 가능하나, 한 PR=한 관심사로 슬라이스.

## 8. 슬라이싱(예비 — 플랜에서 확정)

1. 데이터 계층: 마이그레이션 + `session_store.rs` + CRUD 커맨드 + 단위 테스트(UI 미연결).
2. 영속 배선: send/turn-end append + 복원 로드(기존 탭 UI 그대로, 캡 유지).
3. 캡 제거 + 경고 배너.
4. 사이드바 UX 교체(자동 제목·검색·상태·rename·키보드).
5. 재개 replay preamble.

각 슬라이스: critic ACCEPT + 게이트 green 후 다음.
