# SSOT Governance Harness (Boule) — P2b Approval/Ask-User Card (work-radar slice) — Design

> Status: design approved 2026-06-01. Next step = `writing-plans`. Scope confirmed with user:
> **work-radar slice only, headless-verified**; **bespoke `hermes-agent:ask-user` event** (not a raw
> ACP-permission passthrough); live end-to-end + governance `ask_user` MCP tool + in-app GUI smoke
> are **deferred** (the latter blocked by the dev-DB migration skew `VersionMissing(38)`).

상위 설계 정본: `governance/docs/design/2026-05-31-ssot-governance-harness-design.md` §5.2/§5.3.
P2a(결정 거버넌스 코어) 정본: `governance/docs/plans/2026-05-31-ssot-governance-harness-p2a.md`
(P2b를 deferred follow-up으로 명시).

---

## 1. Goal

스펙 §5.2/§5.3의 "tappable buttons 승인 카드"를 work-radar Hermes 패널에 구현하되, **work-radar
쪽 IPC + 카드 표면만** 만든다. 에이전트가 사용자에게 선택지를 묻는 ACP 요청을 받아 패널에 shadcn
카드로 렌더하고, 사용자의 탭을 ACP 응답으로 에이전트에 되돌린다.

이 슬라이스는 그 자체로 독립적 가치가 있다: 현재 `acp_client.rs`는 에이전트가 보내는 **요청(request,
`method`+`id`)** — `session/request_permission` 포함 — 을 **조용히 무시**한다(`acp_client.rs:367`,
`:390-391`). 그래서 권한이 필요한 도구 호출은 응답을 영원히 기다리며 **행(hang)** 한다. 이 카드가 그
공백을 메운다. 추후 거버넌스 approve/reject 게이트가 이 표면 위에 올라탄다.

### Non-goals (deferred)

- 거버넌스 MCP `ask_user`/`send_file` 도구 자체(스펙 §5.1/§6.3) — P2a에서 미구현, 여기서도 비대상.
- MCP elicitation → Hermes → ACP 로 ask_user 가 전파되는 **end-to-end 라이브 경로** 검증.
- 인앱 GUI 스모크(`pnpm tauri dev`) — dev-DB 마이그레이션 skew(`VersionMissing(38)`)로 차단.
  헤드리스 단위/통합 검증으로 동등 고도(P2a 패턴)를 달성하고, 라이브 스모크는 "could not run" 으로
  **명시적 deferred**.

---

## 2. Architecture

새 **와이어** 행위는 단 하나 — 인바운드 에이전트 요청(`method`+`id`)을 처리하는 것. 베스포크
이벤트/커맨드는 우리 고유의 일반화된 모양이며, **ACP 의미론은 프런트엔드에 절대 노출되지 않는다**.

```
agent → session/request_permission { id, params.options }   (오늘: 무시됨 → hang)
  └─ dispatch_incoming: parse_permission_request() → 정규화 → emit_with_tab(
        "hermes-agent:ask-user", { tabId, requestId, toolName?, options:[{id,label}] })
       └─ FE useHermesTabsBootstrap 리스너 → dispatch({type:"ask-user", …})
            └─ reducer: role:"ask" HermesMessage append (tabId 스코프)
                 └─ HermesChatLog: shadcn 카드(스택형 Button 선택지) 렌더
                      └─ 탭 → commands.hermesAskUserRespond(tabId, requestId, optionId, cancelled)
                           └─ Rust: tabId로 세션 조회 → build_ask_user_response() 응답 프레임을
                                stdin_tx 로 송신(요청 id 그대로 echo) → 에이전트 unblock
```

**상관(correlation) = 에이전트의 요청 `id` 자체.** 이벤트에 실어 프런트로 보내고 그대로 돌려받아
응답에 echo 한다. 따라서 서버측 pending-asks 맵이 필요 없다(stateless) — `hermes_agent_cancel`이
`stdin_tx`로 프레임을 쓰는 패턴과 동일.

**No-hang 보장.** 카드 닫힘(dismiss) 또는 탭 종료 시 `cancelled` outcome 을 보내 에이전트가 무한
대기하지 않게 한다.

**id 공간 충돌 없음.** `pending` 맵은 _우리(client→agent)_ 아웃바운드 요청용이다. 에이전트의
인바운드 요청 id 는 에이전트 고유 공간 — `pending`에 넣지 않고 응답에 echo 만 한다. 충돌 불가.

---

## 3. Rust changes (`src-tauri`)

### 3.1 `hermes_agent/acp_client.rs`

순수 헬퍼 두 개를 추출(테스트 가능 seam — 기존에 단위 테스트된 `governance_mcp_servers` 헬퍼와 동일
패턴, `AppHandle` mock 불요):

```rust
/// 정규화된 ask-user 페이로드(프런트로 emit 할 일반 모양).
struct AskUser {
    request_id: String,              // 원본 JSON-RPC id를 문자열로 보존(specta-safe; echo 시 원형 복원)
    tool_name: Option<String>,
    options: Vec<AskUserOption>,      // { id, label }
}

/// session/request_permission 요청 프레임 → AskUser. 비권한/형식오류 → None.
/// 관대(tolerant): 형식 불량 옵션은 건너뛰고, name 누락 시 optionId를 label fallback.
fn parse_permission_request(val: &Json) -> Option<AskUser> { … }

/// 선택/취소 outcome 의 JSON-RPC **응답** 본문 바이트.
/// request_id 는 원본 JSON 타입 보존(숫자였으면 숫자로 echo).
fn build_ask_user_response(request_id: &str, option_id: &str, cancelled: bool) -> Vec<u8> { … }
```

`dispatch_incoming`은 `session/update` 분기 **이전에** 인바운드 요청 분기를 추가:
`parse_permission_request(&val)`가 `Some` 이면 `emit_with_tab(app, tab_id, "hermes-agent:ask-user", …)`.
그 외 에이전트 요청(`fs/*`, `terminal/*`)은 오늘처럼 무시(범위 밖). **시그니처 변경 없음** — 응답은
나중에 커맨드가 보내므로 `stdin_tx`가 여기 필요 없다.

가정한 ACP 스키마: 요청 `params.options: [{optionId, name, kind}]`, 응답
`result.outcome: { outcome: "selected", optionId } | { outcome: "cancelled" }`. **미검증** — 정규화는
의도적으로 관대해 스키마 불일치 시 크래시 대신 graceful degrade. 라이브 확인은 deferred 스모크.

### 3.2 `commands/hermes_agent.rs`

`hermes_agent_cancel`을 그대로 미러:

```rust
#[tauri::command]
#[specta::specta]
pub async fn hermes_ask_user_respond(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
    request_id: String,
    option_id: String,
    cancelled: bool,
) -> Result<(), AppError> {
    let stdin_tx = { holder.read().await.get(&tab_id).map(|s| s.stdin_tx.clone()) };
    if let Some(stdin_tx) = stdin_tx {
        let frame = encode_frame(&build_ask_user_response(&request_id, &option_id, cancelled));
        stdin_tx.send(frame).await
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))?;
    }
    Ok(()) // 세션 부재 = graceful no-op(탭이 이미 닫힘)
}
```

`build_ask_user_response`를 `acp_client`에서 `pub(crate)`로 노출(또는 frame 모듈에 배치).

### 3.3 `lib.rs`

`collect_commands![…]`에 `commands::hermes_ask_user_respond` 등록(기존 `hermes_agent_*` 옆).

---

## 4. IPC contract

- **Event** `hermes-agent:ask-user` — 다른 hermes 이벤트처럼 raw `emit_with_tab`(specta 비대상,
  `tabId` top-level 주입):
  `{ tabId: string, requestId: string, toolName?: string, options: { id: string; label: string }[] }`.
- **Command** `hermesAskUserRespond(tabId, requestId, optionId, cancelled)` → **specta 생성**으로
  `src/bindings.ts`에 추가. 이것이 의도된 bindings drift — INVARIANT #4는 **수기 타입이 아니라
  생성 타입**이므로 충족. 재생성 후 CI 게이트 green, diff = 이 커맨드 한 개뿐.

`requestId`를 `String`으로 옮기는 이유: ACP 요청 id 는 정수일 수 있고 specta는 i64/u64 금지
(메모리: "specta i64 금지"). 문자열로 운반하고 Rust echo 시 원본 JSON 타입으로 복원.

---

## 5. Frontend (`src`)

### 5.1 `components/hermes/types.ts`

`HermesMessage` 유니온에 추가:

```ts
| {
    role: "ask";
    id: string;
    requestId: string;
    toolName?: string;
    options: { id: string; label: string }[];
    resolved?: string | null; // 선택된 optionId | "cancelled" | undefined(미응답)
  }
```

### 5.2 `components/hermes/useHermesTabsStore.ts`

`useHermesTabsBootstrap()`의 기존 `setup<T>(event, handler)` 패턴으로 리스너 추가:

```ts
await setup<{ requestId?: string; toolName?: string; options?: { id: string; label: string }[] }>(
  "hermes-agent:ask-user",
  (e) => {
    if (!e.payload.tabId || !e.payload.requestId) return;
    dispatch({
      type: "ask-user",
      tabId: e.payload.tabId,
      requestId: e.payload.requestId,
      toolName: e.payload.toolName,
      options: e.payload.options ?? [],
    });
  },
);
```

reducer에 `ask-user` 액션 케이스 추가 → 해당 tabId 메시지 목록에 `role:"ask"` 메시지 append.
응답 후 낙관적(optimistic) `resolved` 갱신 액션(`ask-resolve`)도 추가.

### 5.3 `components/hermes/HermesChatLog.tsx`

`role:"ask"` 메시지를 shadcn 카드로 렌더(테두리 카드 + 스택형 `Button` 선택지, Tailwind v4 토큰,
DESIGN.md Cohere white editorial). 탭 → `unwrap(commands.hermesAskUserRespond(tabId, requestId,
optionId, false))` + 낙관적 `resolved` 표시(버튼 비활성화, 선택지 강조). 카드 dismiss → `cancelled:true`.

`tabId`가 카드 콜백에 필요 → `HermesChatLog` props에 `tabId`(또는 `onRespond` 콜백)를 주입. 가장 작은
변경: 부모(`HermesView`/탭 컨테이너)가 `onRespond(requestId, optionId, cancelled)`를 내려준다.

---

## 6. Verification — 전부 헤드리스(GUI 불요)

1. **Rust 단위 테스트**(`acp_client.rs` `#[cfg(test)]`):
   - `parse_permission_request`: 정상 프레임 → `Some` + 옵션 정규화 / 옵션 누락 / 비-permission method → `None` / 형식불량 옵션 skip.
   - `build_ask_user_response`: selected outcome / cancelled outcome 프레임 모양·바이트.
2. **vitest**: ask 메시지로 `HermesChatLog` 렌더 → 옵션 버튼 단언; 클릭 → `hermesAskUserRespond`가
   올바른 인자로 호출(bindings mock) + `resolved` 비활성화 단언.
3. **bindings drift**: `cargo test`로 재생성 → `git diff src/bindings.ts` = 신규 `hermesAskUserRespond`
   한 줄만(INVARIANT #4 — 생성물).
4. **게이트**: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`;
   `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`. (명령 정본: `docs/reference/commands.md`.)
5. **라이브 GUI 스모크**: **deferred / "could not run"** — dev-DB skew 차단. 헤드리스 1–3이 P2a
   라운드트립과 동등 고도로 대체. 정직하게 미실행으로 기록.
6. **critic 별도 패스**(self-approve 금지): INVARIANT #1/#4/#7 + 정규화 관대성 + id echo 정확성 +
   no-hang(cancel) 검토. ACCEPT(0 BLOCKER/MAJOR) 후에만 done.

---

## 7. INVARIANT compliance & risks

| #   | 준수                                                                                       |
| --- | ------------------------------------------------------------------------------------------ |
| 1   | 카드는 **사람의 탭을 라우팅**할 뿐 — 자체 결정 불가. 거버넌스 approve 게이트는 MCP에 잔류. |
| 2   | 토큰 무관(키체인 비대상).                                                                  |
| 3   | 외부 네트워크 없음(로컬 ACP stdio).                                                        |
| 4   | 신규 커맨드는 specta 생성 → `bindings.ts` drift = 그 커맨드만, CI 게이트 green.            |
| 5   | bounded retry 무관(단발 응답 송신; 무한 poll 없음). no-hang은 cancel outcome로.            |
| 6   | SQLite 무변경.                                                                             |
| 7   | 카드 = shadcn Button + Tailwind v4 토큰 + DESIGN.md.                                       |

**위험.** (a) **ACP 옵션 스키마 미검증** — `{optionId, name, kind}` 가정, 정규화 관대(degrade) +
라이브 스모크 deferred로 정직 처리. (b) **id echo 타입** — `String` 운반, 원본 JSON 타입 보존 echo.
(c) **카드 콜백의 tabId 배선** — 부모에서 `onRespond` 주입(최소 변경).

---

## 8. File touch list

- `src-tauri/src/hermes_agent/acp_client.rs` — `parse_permission_request`/`build_ask_user_response`
  순수 헬퍼 + `dispatch_incoming` 인바운드 요청 분기 + `#[cfg(test)]` 단위 테스트.
- `src-tauri/src/commands/hermes_agent.rs` — `hermes_ask_user_respond` 커맨드.
- `src-tauri/src/lib.rs` — `collect_commands!` 등록.
- `src/bindings.ts` — **생성물**(`cargo test` 재생성).
- `src/components/hermes/types.ts` — `role:"ask"` 유니온 멤버.
- `src/components/hermes/useHermesTabsStore.ts` — 리스너 + reducer 액션.
- `src/components/hermes/HermesChatLog.tsx` — ask 카드 렌더 + vitest.
- `src/components/hermes/HermesView.tsx`(또는 탭 컨테이너) — `onRespond` 주입(최소).
- `docs/decisions.md` — done-line 한 줄(critic ACCEPT 후).

라우팅 정본: `docs/areas/ipc-conventions.md`(tauri-specta) + `docs/areas/shadcn-migration.md`
(카드 = shadcn) + `DESIGN.md`.
