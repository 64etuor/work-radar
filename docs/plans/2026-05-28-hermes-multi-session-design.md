# Hermes 멀티세션 — Design (2026-05-28)

> 한 Hermes 패널에서 codex 자식 프로세스를 탭별로 분리해 **최대 3개**의
> 독립 ACP 세션 메모리를 동시에 유지한다. lazy spawn, in-memory only,
> AgentStatusBar 통합. 본 문서는 spec — 구현 plan은 별도(`writing-plans`).

## 1. 동기

현재 `HermesAgentHolder = Arc<Mutex<Option<AcpSession>>>` 는 전역 슬롯 1개.
ACP 프로토콜은 `sessionId` 기반 멀티세션을 가정하지만 `AcpSession`은
"1 child = 1 sessionId"로 묶여 있어 동시 세션이 불가능하다. 사용자가 서로
다른 맥락(예: A 작업 디버깅, B 문서 작성)을 평행하게 끌어가려면 매번
"새 세션" → 기존 메모리 손실. 멀티탭이 필요하다.

## 2. 범위 / 비범위

**범위**

- 동시 최대 3개의 Hermes 탭(=ACP 세션) 보유 및 독립 진행.
- AgentStatusBar의 hermes 박스를 탭당 1개로 enumerate, 박스 클릭 = 탭 포커스.
- 패널 헤더에 ⊕(새 탭) + 🗑(현재 탭 닫기); 기존 X는 패널 닫기로 유지.
- 박스 더블클릭으로 in-memory rename.

**비범위 (별도 follow-up)**

- 영속화(SQLite 탭/메시지 저장, FTS5 검색).
- idle eviction 타이머(N분 비활성 시 child kill, history 유지).
- AgentStatusBar 상태등을 좌측 dot → 박스 하단 border 색으로 이전 — 코드 헬스
  개선이지만 codex/cmux 공통 시각 변경이라 "한 PR=한 관심사" 룰에 따라 별도 PR
  (`DESIGN.md` agent-status-bar 섹션 갱신 동반).
- 멀티 윈도우 pop-out, 영구 탭 이름 저장.

## 3. 결정 사항 (브레인스토밍 결과)

| 결정           | 값                                                         | 근거                                                                          |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 동시 세션 모델 | 1 탭 = 1 codex 자식 프로세스 (HashMap holder)              | 현 `AcpSession` 구조 재사용, 한 세션 crash 자연 격리, bounded retry 규율 부합 |
| 상한           | **3**                                                      | 사용자 결정. UI 폭/리소스 균형                                                |
| spawn 시점     | **lazy** (첫 send 시 child spawn)                          | 평소 비용 ≈ 0                                                                 |
| 영속성         | **in-memory only**                                         | 단일세션과 UX 일관, PR 범위 최소                                              |
| 상한 도달 동작 | ⊕ disabled + tooltip("최대 3")                             | LRU eviction은 사용자 컨텍스트 침묵 손실, 모달은 마찰                         |
| 탭 영역 위치   | **AgentStatusBar의 hermes 박스 그룹**                      | 기존 P10a 박스 모델 그대로 흡수, 패널 닫혀도 상태 가시                        |
| 탭 닫기 위치   | **패널 헤더 🗑** (X는 패널 닫기 유지)                      | 사용자 결정. 박스에는 × 없음                                                  |
| 탭 이름        | 자동 `Hermes 1/2/3` + 박스 **더블클릭 rename** (in-memory) | `useAgentNames` UX 재사용, 영속은 follow-up                                   |
| 최소 탭 수     | **1** (마지막 탭을 닫으면 빈 탭 자동 생성)                 | 0개 상태 분기 제거                                                            |

## 4. 아키텍처

### 4.1 Rust holder

```rust
// src-tauri/src/commands/hermes_agent.rs
pub type TabId = String;            // UI uuid
pub type HermesAgentHolder =
    Arc<RwLock<HashMap<TabId, AcpSession>>>;
```

- 동시 세션 cap = 3. 백엔드에서도 강제하며 위반 시
  `AppError::unexpected("hermes.tab.cap", "max 3")`.
- `AcpSession` 에 `tab_id: String` 필드 추가 — emit payload 주입에 사용.

### 4.2 IPC (tauri-specta로 `src/bindings.ts` 생성)

```rust
hermes_agent_open_tab(tab_id: String) -> Result<(), AppError>;
hermes_agent_send(tab_id: String,
                  text: String,
                  image_paths: Vec<String>) -> Result<(), AppError>;
hermes_agent_cancel(tab_id: String) -> Result<(), AppError>;
hermes_agent_close_tab(tab_id: String) -> Result<(), AppError>;
hermes_agent_stop()                       -> Result<(), AppError>; // 앱 종료/긴급
hermes_agent_list_tabs() -> Result<Vec<TabSummary>, AppError>;     // 디버그용
```

- `open_tab`: 슬롯만 생성, child spawn 없음. 이미 존재하면 no-op.
- `send`: slot에 child 없으면 lazy `AcpSession::spawn(tab_id)`. 그 후 송신.
- `close_tab`: child kill + 슬롯 제거. 마지막 탭이면 빈 탭 자동 생성은
  **프런트 책임** (백엔드는 단순 close).
- 기존 `hermes_agent_start` 제거 — 호환 마이그레이션 없이 새 API로 cutover
  (in-memory only이므로 호환층 불필요).

### 4.3 이벤트 (payload 일관 변경)

모든 이벤트 payload 최상위에 `tabId: string` 필드를 **반드시** 포함.

| 이벤트                            | 페이로드 변화                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `hermes-agent:chunk`              | + `tabId`                                                                       |
| `hermes-agent:tool-call`          | + `tabId`                                                                       |
| `hermes-agent:tool-call-update`   | + `tabId`                                                                       |
| `hermes-agent:turn-end`           | + `tabId`                                                                       |
| `hermes-agent:session-ready`      | + `tabId` (기존 `session_id`는 ACP 식별자, `tabId`는 UI 라우팅 키 — 둘 다 유지) |
| `hermes-agent:available-commands` | + `tabId`                                                                       |
| `hermes-agent:error`              | + `tabId`                                                                       |

`AcpSession::dispatch_incoming`가 `app.emit` 할 때 자기 `tab_id`를 항상
주입. `tab_id` 없이 emit 하는 경로는 grep으로 0건이어야 한다(검증 항목).

### 4.4 프런트 훅

```ts
// src/components/hermes/useHermesTabs.ts (신규)
type TabState = {
  id: TabId;
  name: string;
  status: SessionStatus;
  messages: HermesMessage[];
  commandsList: AcpCommand[];
};
type TabsState = {
  tabs: Map<TabId, TabState>;
  activeTabId: TabId | null;
};
```

- 이벤트 리스너는 mount 시 1벌만 등록(현 코드와 동일 패턴).
  Listener에서 `payload.tabId`로 해당 탭 reducer에 dispatch.
- 액션: `openTab() / closeTab(id) / send(id, text, imgs) / cancel(id) /
restart(id) / setActive(id) / renameTab(id, name)`.
- `useHermesAgent` 는 제거. 호출부(HermesPanel) 마이그레이션 1회.

### 4.5 HermesPanel UI

- 본문: `activeTabId`의 messages만 렌더.
- 헤더 우측 버튼 순서: **⊕(새 탭)** · **🗑(현재 탭 닫기)** · **↻(재시작)** · **X(패널 닫기)**.
  - ⊕: 탭 3 도달 시 disabled + tooltip "최대 3개".
  - 🗑: 현재 탭 close. 마지막 탭이었다면 즉시 `openTab()` 호출 → 빈 탭 1개로
    교체 후 `setActive` (UI는 한 프레임도 0탭 상태 노출 안 함).
- 패널 자체엔 탭 행이 없다 — 탭 전환은 AgentStatusBar에서.

### 4.6 AgentStatusBar 통합

- `boxes` enumerate 변경:
  - 기존: `hermes.data?.configured` ⇒ 박스 1개.
  - 신규: `useHermesTabs()` 의 `tabs` 순회 ⇒ 탭당 박스 1개. `engine: "hermes"`,
    `state`: tab status 매핑(streaming=working, error=error, otherwise=idle),
    `name`: `tabState.name`.
- hermes 박스 그룹 우측에 **⊕ 칩**(상한 미달일 때만 렌더). 클릭 → `openTab()` +
  `setActive`.
- 박스 클릭 → `setActive(id)` + `emit("hermes:toggle")` (패널 닫혀 있으면 열기).
- 박스 **더블클릭** → `renameTab(id, …)` (`useAgentNames` 의 inline edit UI 재사용,
  단 저장 destination 은 메모리 `Map`).
- 박스에 hover × 없음(기존 codex 박스와 동일 — close는 패널에서만).
- INVARIANT #1 ("표시 전용") 위반 없음 — 박스 클릭은 단순 네비게이션.

### 4.7 라이프사이클

- 앱 시작: 어떤 탭도 자동 생성하지 않음. 사용자가 ⊕ 누르면 첫 탭 생성, 첫 send 시
  child spawn.
- 패널 닫기(X): child 유지(다시 열면 그대로).
- 앱 종료: `hermes_agent_stop()` 가 holder 의 모든 child kill (현 Drop 동작 확장).
- 탭 close: 해당 child 즉시 kill + 슬롯 제거 + pending oneshot 모두 drop.

## 5. 에러 / 경계 동작

- 상한 위반(send 가 lazy spawn 시도 시 child spawn 실패 포함) → `AppError`, UI에는
  system warn 메시지로 표시(`docs/areas/ipc-conventions.md` AppError envelope).
- 한 탭의 codex 자식이 crash → reader task 종료, 해당 탭만 status=error,
  다른 탭 무관.
- 동일 `tabId` 로 `open_tab` 재호출 → no-op (idempotent).
- 알 수 없는 `tabId` 로 `send/cancel/close_tab` → `AppError::unexpected
("hermes.tab.missing", id)`.

## 6. 데이터 / 영속성

영속화 없음. 어떤 sqlx 마이그레이션도 추가하지 않는다(`docs/areas/
data-layer-conventions.md` SSOT 규율 — 추가 테이블은 사용 가치가 분명할 때만).

## 7. 테스트

- Rust 유닛: `HermesAgentHolder` HashMap insert/cap/close 동작, `AppError`
  매핑.
- Rust 통합(가능 범위): `AcpSession::spawn` 두 번 호출 후 각자의 sessionId 가
  다른지(stub child 또는 dev-only 모킹) — 환경에 따라 skip 가능.
- 프런트 vitest: `useHermesTabs` reducer — `tabId` 라우팅, 마지막 탭 닫기 후
  빈 탭 자동 생성, 상한 disabled.
- 수동 스모크 (`pnpm tauri dev`):
  1. 탭 3개 만들고 각각 다른 질문 → 응답이 섞이지 않음.
  2. 한 탭 중단 → 다른 탭 streaming 무영향.
  3. AgentStatusBar 박스 3개 표시, 클릭으로 전환, 더블클릭 rename 즉시 반영.
  4. ⊕ 상한 시 disabled + tooltip.
  5. 패널 닫았다 다시 열기 → 메시지/탭 보존.
  6. 앱 재시작 → 모든 탭 사라짐 (in-memory only 의도).

## 8. 검증 (Phase done-criteria)

- [ ] `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` green.
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` green.
- [ ] `src/bindings.ts` drift 0 (CI 게이트).
- [ ] 위 수동 스모크 6개 전부 관찰 결과로 기록.
- [ ] reviewer/critic 별도 패스 ACCEPT (self-approve 금지).

## 9. 위험 / 롤백

- **위험 1:** 이벤트 payload 누락 — emit 경로 중 하나가 `tabId` 빼먹으면 그 탭은
  "응답 안 옴". 대책: `AcpSession::dispatch_incoming` 한 곳에 emit 래퍼
  (`emit_with_tab`)를 만들고 직접 `app.emit("hermes-agent:*", ...)` 호출 0건임을
  grep 으로 확인 (CI grep gate는 follow-up).
- **위험 2:** 동시 3 child = 메모리 압박. codex CLI 1개당 RSS 측정값 미관측.
  스모크 시 `ps`/`Activity Monitor` 로 합계 RSS 기록 → 1.5 GB 초과 시 lazy
  eviction(follow-up) 필요성 평가.
- **위험 3:** AgentStatusBar 폭 — 상한 3 + cmux + codex 활성 잡 동시 시 `+N`
  overflow 자연 처리(기존 8 cap + overflowSplit). 추가 작업 없음.
- **롤백:** 단일 PR 단위로 revert. PR 1(Rust)만 들어가고 PR 2(프런트)가 미머지
  상태에서도 빌드/실행 가능해야 함 → PR 1 머지 시 기존 `hermes_agent_start`
  호출자(현 `useHermesAgent`)는 일시적으로 깨질 수 있어 **PR 1+2 묶음 머지**가
  안전 (PR 3, 4 는 분리).

## 10. PR 분할

| PR              | 범위                                                                                                          | 종속             |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| **PR 1**        | Rust holder HashMap화 + 새 IPC 5종 + AcpSession `tab_id` 주입 + 모든 emit에 `tabId` payload + bindings 재생성 | 없음             |
| **PR 2**        | 프런트 `useHermesTabs` + HermesPanel 헤더(⊕/🗑) + 본문 active tab 렌더                                        | PR 1 (묶음 머지) |
| **PR 3**        | AgentStatusBar hermes 박스 탭별 enumerate + ⊕ 칩 + 더블클릭 rename + 클릭 focus                               | PR 2             |
| **PR 4 (분리)** | AgentStatusBar 상태등 좌측 dot → 박스 하단 border 색 (codex/hermes/cmux 공통) + `DESIGN.md` 갱신              | 독립             |

## 11. 후속 (이번 phase 밖)

- 탭 영속화: `hermes_tabs(id, name, created_at)` + `hermes_messages(tab_id, idx, role, payload_json, ts)` 마이그레이션, FTS5는 아직 보류.
- idle eviction: 30분 비활성 child kill, `setActive` 시 lazy 재 spawn (history 유지, ACP sessionId 재발급 안내 system msg).
- 멀티 윈도우 pop-out.
- PR 4 시각 변경 후 dot 관련 CSS deadcode 제거.

---

### 변경 영향 인덱스

- `src-tauri/src/commands/hermes_agent.rs` — holder 타입, IPC 5종.
- `src-tauri/src/hermes_agent/acp_client.rs` — `AcpSession.tab_id` 필드, emit 래퍼.
- `src-tauri/src/lib.rs` / state 등록부 — holder 타입 교체.
- `src/bindings.ts` — 자동 생성(drift 0).
- `src/components/hermes/useHermesAgent.ts` — 제거.
- `src/components/hermes/useHermesTabs.ts` — 신규.
- `src/components/hermes/HermesPanel.tsx` — 헤더 버튼 추가, 본문 활성 탭 렌더.
- `src/components/hermes/HermesChatLog.tsx`, `HermesChatInput.tsx` — props 라우팅
  (어떤 tabId 의 reducer/send 를 받을지).
- `src/components/AgentStatusBar.tsx` — hermes enumerate 변경, ⊕ 칩, rename, focus.

### Area 문서 영향

- `docs/areas/ipc-conventions.md` — emit payload에 `tabId` 라우팅 키 규약 한 줄 추가(emit 래퍼 강제).
- `docs/areas/decision-rails.md` — INVARIANT 신규 추가 없음. 박스 클릭은 표시 네비, 결정 아님.
- `docs/decisions.md` — 본 phase 한 줄 결정 로그 추가(완료 시).
