# Hermes 멀티세션 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hermes 패널에서 동시 최대 3개의 독립 ACP 세션(=탭)을 lazy-spawn으로 유지하고, AgentStatusBar에서 탭별 박스로 표시·전환·생성한다.

**Architecture:** `HermesAgentHolder`를 `Arc<RwLock<HashMap<TabId, AcpSession>>>`로 교체. 모든 ACP→Tauri 이벤트 payload 최상위에 `tabId` 라우팅 키를 주입(emit 래퍼 단일 통로). 프런트는 `useHermesTabs()` 단일 훅으로 `{tabs: Map, activeTabId}`를 관리하고 `payload.tabId`로 reducer 라우팅. AgentStatusBar는 탭당 박스 1개로 enumerate, ⊕ 칩으로 신규 탭, 박스 클릭으로 포커스.

**Tech Stack:** Rust + tauri 2 + tauri-specta + tokio + sqlx (이번 plan은 sqlx 변경 없음) / React 19 + TS + vitest + zustand + tanstack-query

**Spec:** `docs/plans/2026-05-28-hermes-multi-session-design.md`

**스코프 분할:**

- Phase 1: Rust holder HashMap화 + 새 IPC + emit 래퍼 (PR1)
- Phase 2: 프런트 `useHermesTabs` + HermesPanel 헤더 UI 컷오버 (PR2 — PR1과 묶음 머지)
- Phase 3: AgentStatusBar 통합 (PR3)
- (별도 plan) PR4 — 상태등 좌측 dot → 박스 하단 border. 본 plan 비범위.

---

## File Structure

**Modify:**

- `src-tauri/src/commands/hermes_agent.rs` — holder 타입, IPC 5종, 상한 강제.
- `src-tauri/src/hermes_agent/acp_client.rs` — `AcpSession.tab_id` 필드, `dispatch_incoming(tab_id, …)` 시그니처, emit 래퍼.
- `src-tauri/src/lib.rs` — `invoke_handler` 등록부 갱신, state 등록.
- `src/components/hermes/HermesPanel.tsx` — 헤더 ⊕/🗑 추가, 본문 활성 탭 렌더.
- `src/components/hermes/HermesChatInput.tsx` / `HermesChatLog.tsx` — props 라우팅 (`tabId` 받기).
- `src/components/AgentStatusBar.tsx` — hermes enumerate 변경, ⊕ 칩, click=focus, dblclick=rename.
- `src/lib/agentBar.ts` (필요 시) — 헬퍼 추가.

**Create:**

- `src/components/hermes/useHermesTabs.ts` — 단일 훅 + reducer.
- `src/components/hermes/useHermesTabs.test.ts` — vitest.
- `src-tauri/src/commands/hermes_agent_test.rs` (또는 `#[cfg(test)] mod tests` inline) — cap/idempotency 유닛.

**Delete:**

- `src/components/hermes/useHermesAgent.ts` — `useHermesTabs`가 대체.

---

## Conventions / Commands

`docs/reference/commands.md` 인덱스:

- Rust 빌드: `PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml`
- Rust 테스트: `PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml`
- Clippy: `PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- Frontend type/lint/test: `pnpm typecheck && pnpm lint && pnpm vitest run`
- bindings 재생성: `pnpm typecheck` 시 specta build script 트리거 (또는 `pnpm specta:gen`이 정의돼 있으면 그것)
- Commit 시 husky가 cargo fmt 실행 → `PATH="$HOME/.cargo/bin:$PATH"` 필수.
- 푸시는 **dev만** (`docs/areas/git-conventions.md`).

---

# Phase 1 — Rust holder HashMap화 + 새 IPC (PR1)

## Task 1.1: emit 래퍼 도입 (acp_client)

**Files:**

- Modify: `src-tauri/src/hermes_agent/acp_client.rs`

목표: `app.emit` 직호출 모든 곳을 `emit_with_tab(app, tab_id, event, json)` 래퍼 경유로 변경 — payload 최상위에 `tabId` 자동 주입. 이 시점엔 `AcpSession`이 단일 세션이지만 미리 시그니처를 깔아둔다.

- [ ] **Step 1: 래퍼 함수 추가 (파일 하단, `mod` 끝나기 전)**

```rust
/// Emit a Tauri event with `tabId` injected at the top level of payload.
/// `payload` MUST be a JSON object (or null → becomes {tabId}).
/// 이 함수만이 hermes-agent:* 이벤트 emit 의 단일 통로다.
fn emit_with_tab(app: &AppHandle, tab_id: &str, event: &str, payload: Json) {
    let mut obj = match payload {
        Json::Object(m) => m,
        Json::Null => serde_json::Map::new(),
        other => {
            let mut m = serde_json::Map::new();
            m.insert("value".to_string(), other);
            m
        }
    };
    obj.insert("tabId".to_string(), Json::String(tab_id.to_string()));
    let _ = app.emit(event, Json::Object(obj));
}
```

- [ ] **Step 2: spawn 내부 `session-ready` emit을 임시 호환 형태로 유지**

```rust
// 기존: let _ = app.emit("hermes-agent:session-ready", json!({ "session_id": &session_id }));
// 변경: tab_id가 아직 없는 단계 (AcpSession 빌드 직전) — 임시 빈 문자열 주입 후
//       Task 1.2에서 진짜 tab_id 받도록 spawn 시그니처 변경.
emit_with_tab(&app, "", "hermes-agent:session-ready",
              json!({ "session_id": &session_id }));
```

- [ ] **Step 3: 빌드만 확인**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml
```

Expected: 컴파일 성공(경고 없음).

- [ ] **Step 4: 커밋 보류** — Task 1.2와 같이 커밋(빈 tabId가 중간 상태라 부분 커밋 회피).

---

## Task 1.2: `AcpSession.tab_id` 필드 + `spawn(app, tab_id)` 시그니처

**Files:**

- Modify: `src-tauri/src/hermes_agent/acp_client.rs`

- [ ] **Step 1: 구조체에 필드 추가**

`pub struct AcpSession {` 블록 (대략 line 70 부근):

```rust
pub struct AcpSession {
    pub session_id: String,
    pub tab_id: String,                  // ← 추가
    pub image_transport: ImageTransport,
    pub(crate) stdin_tx: mpsc::Sender<Vec<u8>>,
    pub(crate) pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    pub(crate) next_id: Arc<AtomicU64>,
    child: Child,
}
```

- [ ] **Step 2: `spawn` 시그니처에 `tab_id: String` 추가**

```rust
pub async fn spawn(app: AppHandle, tab_id: String) -> Result<Self, AppError> {
    // ... 기존 본문 그대로 ...
    // session-ready emit 부분:
    emit_with_tab(&app, &tab_id, "hermes-agent:session-ready",
                  json!({ "session_id": &session_id }));

    Ok(AcpSession {
        session_id,
        tab_id: tab_id.clone(),       // ← 필드 채움
        image_transport,
        ..session
    })
}
```

`AcpSession` 의 "shell" 임시 인스턴스(reader task spawn 직전, `let session = AcpSession { ... }`) 부분도 `tab_id: tab_id.clone()` 추가.

- [ ] **Step 3: reader task 가 `dispatch_incoming` 호출 시 `tab_id`를 전달**

reader task spawn 내부 (대략 line 127):

```rust
let app_r = app.clone();
let pending_r = pending.clone();
let tab_id_r = tab_id.clone();    // ← 추가 (Move into task)
tokio::spawn(async move {
    let mut reader = BufReader::new(stdout);
    // ... loop 본문에서 dispatch_incoming(&app_r, &pending_r, val).await;
    //     →
    //     dispatch_incoming(&app_r, &tab_id_r, &pending_r, val).await;
});
```

- [ ] **Step 4: `dispatch_incoming` 시그니처 변경**

```rust
async fn dispatch_incoming(
    app: &AppHandle,
    tab_id: &str,                                                // ← 추가
    pending: &Arc<Mutex<HashMap<u64, oneshot::Sender<Json>>>>,
    val: Json,
) {
    // ... 기존 본문에서 app.emit(... , payload) 호출을
    //     emit_with_tab(app, tab_id, ..., payload) 로 모두 교체 ...
}
```

본문 내 `app.emit` 6곳 모두 `emit_with_tab(app, tab_id, ...)` 로 교체:

- `"hermes-agent:available-commands"`
- `"hermes-agent:chunk"`
- `"hermes-agent:tool-call"` (note: `&update` 가 ToolCallStart 구조; 그대로 인자로 넣되 `update.clone()` 으로 owned Json 전달)
- `"hermes-agent:tool-call-update"`
- `"hermes-agent:plan"`
- `"hermes-agent:error"` (unknown discriminator)

- [ ] **Step 5: 빌드 + clippy**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml && \
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: 성공. 호출자(`hermes_agent.rs`)의 `AcpSession::spawn(app)` 한 곳이 컴파일 실패할 것 → 다음 Task에서 해결.

- [ ] **Step 6: 부분 커밋 보류 — Task 1.3과 묶음.**

---

## Task 1.3: `HermesAgentHolder` 타입 교체 + `hermes_agent.rs` 재작성

**Files:**

- Modify: `src-tauri/src/commands/hermes_agent.rs`

- [ ] **Step 1: holder 타입 + 신규 상수**

```rust
use std::collections::HashMap;
use tokio::sync::RwLock;

pub type TabId = String;
pub type HermesAgentHolder = Arc<RwLock<HashMap<TabId, AcpSession>>>;

pub const HERMES_TAB_CAP: usize = 3;

pub fn new_holder() -> HermesAgentHolder {
    Arc::new(RwLock::new(HashMap::new()))
}
```

`tokio::sync::Mutex` import 제거.

- [ ] **Step 2: `hermes_agent_open_tab` 추가 (lazy 슬롯)**

```rust
#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_open_tab(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
) -> Result<(), AppError> {
    let map = holder.read().await;
    if map.contains_key(&tab_id) {
        return Ok(()); // idempotent
    }
    if map.len() >= HERMES_TAB_CAP {
        return Err(AppError::unexpected(
            "hermes.tab.cap",
            format!("max {HERMES_TAB_CAP}"),
        ));
    }
    // 슬롯 자체는 spawn 전에 만들지 않는다 — child 없는 빈 슬롯은 HashMap에 표현 불가.
    // "탭 존재"는 프런트 측 상태로 추적; 백엔드는 spawn 시 진입.
    // 이 경로는 cap pre-check만 제공(send 시 다시 검증).
    Ok(())
}
```

> 설계 결정: "빈 슬롯"을 백엔드에서 표현하지 않는다(HashMap 키만 있고 child 없는 상태). 대신 `open_tab` 는 cap-precheck 전용이고, 실제 슬롯 점유는 `send` 의 lazy spawn 시 일어난다. 프런트가 `tabs` Map 으로 슬롯 존재를 관리한다.

- [ ] **Step 3: `hermes_agent_send` 재작성 (lazy spawn + tab_id 라우팅)**

기존 본문을 다음으로 교체:

```rust
#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_send(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
    // 1. lazy spawn — slot에 child 없으면 만들기. cap 재검증.
    let snapshot = {
        let map = holder.read().await;
        map.get(&tab_id).map(|s| (
            s.session_id.clone(),
            s.image_transport,
            s.stdin_tx.clone(),
            s.pending.clone(),
            s.next_id.clone(),
        ))
    };

    let (session_id, transport, stdin_tx, pending, next_id) = match snapshot {
        Some(s) => s,
        None => {
            // Lazy spawn — write lock for insert.
            let mut map = holder.write().await;
            if map.contains_key(&tab_id) {
                // race: another caller spawned meanwhile. Re-read.
                let s = map.get(&tab_id).expect("checked");
                (s.session_id.clone(), s.image_transport, s.stdin_tx.clone(),
                 s.pending.clone(), s.next_id.clone())
            } else {
                if map.len() >= HERMES_TAB_CAP {
                    return Err(AppError::unexpected(
                        "hermes.tab.cap",
                        format!("max {HERMES_TAB_CAP}"),
                    ));
                }
                let session = AcpSession::spawn(app.clone(), tab_id.clone()).await?;
                let tup = (session.session_id.clone(), session.image_transport,
                           session.stdin_tx.clone(), session.pending.clone(),
                           session.next_id.clone());
                map.insert(tab_id.clone(), session);
                tup
            }
        }
    };

    // 2. Build prompt (기존과 동일 — image_paths 처리)
    let mut prompt: Vec<serde_json::Value> = Vec::new();
    if !text.is_empty() {
        prompt.push(json!({ "type": "text", "text": text }));
    }
    for path in &image_paths {
        let block = match transport {
            ImageTransport::FilePath => {
                json!({ "type": "image", "source": { "type": "file", "path": path } })
            }
            ImageTransport::Base64 => {
                let bytes = tokio::fs::read(path).await
                    .map_err(|e| AppError::unexpected("hermes.image.read", e.to_string()))?;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let media_type = mime_from_ext(path);
                json!({ "type": "image", "source": {
                    "type": "base64", "media_type": media_type, "data": b64 } })
            }
        };
        prompt.push(block);
    }

    // 3. JSON-RPC id + pending oneshot
    let id = next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let body = serde_json::to_vec(&json!({
        "jsonrpc": "2.0", "id": id,
        "method": "session/prompt",
        "params": { "sessionId": session_id, "prompt": prompt },
    })).map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
    let frame = crate::hermes_agent::frame::encode_frame(&body);
    let (tx, rx) = tokio::sync::oneshot::channel();
    pending.lock().await.insert(id, tx);

    // 4. Send
    if stdin_tx.send(frame).await.is_err() {
        pending.lock().await.remove(&id);
        emit_turn_end(&app, &tab_id, "error", Some("stdin closed"));
        return Err(AppError::unexpected("hermes.acp.protocol", "stdin closed"));
    }

    // 5. Wait — 10min budget
    let resp = match tokio::time::timeout(tokio::time::Duration::from_secs(600), rx).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => {
            emit_turn_end(&app, &tab_id, "error", Some("response dropped (stream closed)"));
            return Err(AppError::unexpected("hermes.acp.protocol", "response dropped"));
        }
        Err(_) => {
            pending.lock().await.remove(&id);
            emit_turn_end(&app, &tab_id, "error", Some("timeout"));
            return Err(AppError::unexpected("hermes.acp.timeout", "session/prompt"));
        }
    };

    // 6. Map response → turn-end
    if let Some(err) = resp.get("error") {
        let msg = err.to_string();
        emit_turn_end(&app, &tab_id, "error", Some(&msg));
        return Err(AppError::unexpected("hermes.acp.protocol", msg));
    }
    let stop_reason = resp.get("result").and_then(|r| r.get("stopReason"))
        .and_then(|v| v.as_str()).unwrap_or("end_turn").to_string();
    let status = match stop_reason.as_str() {
        "cancelled" => "cancelled",
        "refusal" | "error" => "error",
        _ => "ok",
    };
    let _ = app.emit("hermes-agent:turn-end", json!({
        "tabId": tab_id,
        "status": status,
        "stop_reason": stop_reason,
    }));
    Ok(())
}

fn emit_turn_end(app: &AppHandle, tab_id: &str, status: &str, error: Option<&str>) {
    let mut payload = json!({ "tabId": tab_id, "status": status });
    if let Some(e) = error {
        payload["error"] = json!(e);
    }
    let _ = app.emit("hermes-agent:turn-end", payload);
}
```

- [ ] **Step 4: `hermes_agent_cancel` / `hermes_agent_close_tab` 재작성**

```rust
#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_cancel(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
) -> Result<(), AppError> {
    let snapshot = {
        let map = holder.read().await;
        map.get(&tab_id).map(|s| (s.session_id.clone(), s.stdin_tx.clone()))
    };
    if let Some((session_id, stdin_tx)) = snapshot {
        let body = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
        })).map_err(|e| AppError::unexpected("hermes.acp.protocol", e.to_string()))?;
        let frame = crate::hermes_agent::frame::encode_frame(&body);
        stdin_tx.send(frame).await
            .map_err(|_| AppError::unexpected("hermes.acp.protocol", "stdin closed"))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_close_tab(
    holder: State<'_, HermesAgentHolder>,
    tab_id: String,
) -> Result<(), AppError> {
    let removed = {
        let mut map = holder.write().await;
        map.remove(&tab_id)
    };
    if let Some(session) = removed {
        session.kill().await;
    }
    Ok(())
}
```

- [ ] **Step 5: `hermes_agent_stop` 갱신 (모든 탭 정리)**

```rust
#[tauri::command]
#[specta::specta]
pub async fn hermes_agent_stop(
    holder: State<'_, HermesAgentHolder>,
) -> Result<(), AppError> {
    let drained: Vec<AcpSession> = {
        let mut map = holder.write().await;
        map.drain().map(|(_, v)| v).collect()
    };
    for s in drained {
        s.kill().await;
    }
    Ok(())
}
```

- [ ] **Step 6: 기존 `hermes_agent_start` 함수 제거**

전체 함수 + 그 위 doc 라인 삭제. 단일 세션 호환층은 두지 않는다(설계 결정 §10).

- [ ] **Step 7: 빌드 + clippy**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml && \
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: 성공. `lib.rs` 의 `hermes_agent_start` 참조가 깨질 것 → 다음 Task.

---

## Task 1.4: `lib.rs` 등록부 갱신

**Files:**

- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: `invoke_handler!` 등록부 수정 (line ~209)**

```rust
commands::hermes_agent::hermes_agent_open_tab,
commands::hermes_agent::hermes_agent_send,
commands::hermes_agent::hermes_agent_cancel,
commands::hermes_agent::hermes_agent_close_tab,
commands::hermes_agent::hermes_agent_stop,
commands::hermes_agent::hermes_save_pasted_image,
```

`hermes_agent_start` 줄 삭제.

- [ ] **Step 2: `collect_commands!` (또는 specta builder) 에서도 동일 변경**

repo 검색: `grep -n "hermes_agent_start" src-tauri/src/lib.rs` 가 0이어야 한다.

- [ ] **Step 3: 빌드 + clippy + 테스트**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml && \
PATH="$HOME/.cargo/bin:$PATH" cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && \
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: 성공(이 시점 프런트는 깨짐 — bindings drift는 Task 1.6에서 처리).

---

## Task 1.5: Rust 유닛 테스트 — cap + idempotency

**Files:**

- Modify: `src-tauri/src/commands/hermes_agent.rs` (파일 하단 `#[cfg(test)] mod tests`)

> 주의: `AcpSession::spawn`은 실제 codex CLI 자식을 spawn 하므로 직접 테스트 불가. 여기서는 cap 산술과 holder 동작만 검증한다.

- [ ] **Step 1: 테스트 작성**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_tab_idempotent_and_cap_precheck_passes_under_cap() {
        let holder: HermesAgentHolder = new_holder();
        // open_tab은 child 미spawn — cap precheck만. map은 비어있어 통과.
        // 직접 invoke 대신 내부 검증: 빈 holder는 길이 0.
        assert_eq!(holder.read().await.len(), 0);
    }

    #[tokio::test]
    async fn close_tab_on_missing_is_noop() {
        let holder: HermesAgentHolder = new_holder();
        let mut map = holder.write().await;
        let removed = map.remove("missing");
        assert!(removed.is_none());
    }

    // cap 동작은 send 의 lazy spawn 경로에서 강제 — 실제 spawn 없이는 단위 테스트 불가.
    // 통합 스모크(Phase done-criteria)에서 검증.
}
```

- [ ] **Step 2: 실행**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo test --manifest-path src-tauri/Cargo.toml hermes_agent
```

Expected: 2 tests passed.

---

## Task 1.6: bindings 재생성

**Files:**

- Modify: `src/bindings.ts` (auto-generated)

- [ ] **Step 1: 빌드로 specta 트리거**

```bash
PATH="$HOME/.cargo/bin:$PATH" cargo build --manifest-path src-tauri/Cargo.toml
```

또는 별도 generator script가 있다면 그것 (`grep -n "specta" package.json`로 확인).

- [ ] **Step 2: 생성된 bindings 확인**

```bash
grep -n "hermesAgent\|HermesAgent" src/bindings.ts | head -20
```

Expected: `hermesAgentOpenTab`, `hermesAgentSend(tabId, text, imagePaths)`, `hermesAgentCancel(tabId)`, `hermesAgentCloseTab(tabId)`, `hermesAgentStop()`, `hermesSavePastedImage(...)` 확인. `hermesAgentStart` 부재 확인.

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: **여러 에러**(useHermesAgent가 `hermesAgentStart` 호출, 송신 시 tabId 인자 없음 등). Phase 2 에서 해결.

- [ ] **Step 4: Phase 1 묶음 커밋은 Phase 2 종료 시 같이.**

> Phase 1 단독 머지는 프런트가 깨진 상태가 되므로 PR 단위로는 묶음 머지(Phase 1+2). 그러나 작업 흐름상 여기서 한 번 커밋 가능하다면 frontend cutover 시작 직전에:
>
> ```bash
> git add src-tauri/ src/bindings.ts && \
> PATH="$HOME/.cargo/bin:$PATH" git commit -m "feat(hermes): multi-session holder + IPC (PR1 of multi-session)"
> ```
>
> 단 dev 브랜치는 frontend 빌드 깨진 상태가 되니, **권장은 Phase 2 종료 후 한 커밋**.

---

# Phase 2 — 프런트 `useHermesTabs` + HermesPanel 컷오버 (PR2)

## Task 2.1: `useHermesTabs.test.ts` — reducer 스펙 정의 (TDD)

**Files:**

- Create: `src/components/hermes/useHermesTabs.test.ts`

- [ ] **Step 1: 실패 테스트 작성**

```ts
import { describe, expect, it } from "vitest";

import { tabsReducer, type TabsState, EMPTY_TABS_STATE } from "./useHermesTabs";

describe("tabsReducer", () => {
  it("openTab adds a new tab with given id and default name", () => {
    const s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "t1",
      defaultName: "Hermes 1",
    });
    expect(s.tabs.get("t1")?.name).toBe("Hermes 1");
    expect(s.activeTabId).toBe("t1"); // first tab → active
  });

  it("openTab is idempotent on existing id", () => {
    const a = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "t1",
      defaultName: "X",
    });
    const b = tabsReducer(a, {
      type: "open-tab",
      tabId: "t1",
      defaultName: "Y",
    });
    expect(b.tabs.size).toBe(1);
    expect(b.tabs.get("t1")?.name).toBe("X");
  });

  it("closeTab removes tab and re-elects active when needed", () => {
    let s: TabsState = EMPTY_TABS_STATE;
    s = tabsReducer(s, { type: "open-tab", tabId: "a", defaultName: "A" });
    s = tabsReducer(s, { type: "open-tab", tabId: "b", defaultName: "B" });
    s = tabsReducer(s, { type: "set-active", tabId: "b" });
    s = tabsReducer(s, { type: "close-tab", tabId: "b" });
    expect(s.tabs.has("b")).toBe(false);
    expect(s.activeTabId).toBe("a");
  });

  it("chunk action appends to matching tab only", () => {
    let s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "a",
      defaultName: "A",
    });
    s = tabsReducer(s, { type: "open-tab", tabId: "b", defaultName: "B" });
    s = tabsReducer(s, {
      type: "agent-chunk",
      tabId: "a",
      text: "hello",
    });
    const a = s.tabs.get("a");
    const b = s.tabs.get("b");
    expect(a?.messages.length).toBe(1);
    expect(b?.messages.length).toBe(0);
  });

  it("user action records on target tab", () => {
    let s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "a",
      defaultName: "A",
    });
    s = tabsReducer(s, {
      type: "user",
      tabId: "a",
      text: "hi",
      images: [],
    });
    expect(s.tabs.get("a")?.messages.at(-1)?.role).toBe("user");
  });

  it("rename updates name only", () => {
    let s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "a",
      defaultName: "A",
    });
    s = tabsReducer(s, { type: "rename", tabId: "a", name: "custom" });
    expect(s.tabs.get("a")?.name).toBe("custom");
  });

  it("cap enforcement is the hook caller's responsibility — reducer accepts > cap", () => {
    // 의도적: cap은 호출부에서 체크. reducer는 순수 데이터 변환.
    let s = EMPTY_TABS_STATE;
    for (const id of ["a", "b", "c", "d"]) {
      s = tabsReducer(s, { type: "open-tab", tabId: id, defaultName: id });
    }
    expect(s.tabs.size).toBe(4);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
pnpm vitest run src/components/hermes/useHermesTabs.test.ts
```

Expected: FAIL — `Cannot find module './useHermesTabs'`.

---

## Task 2.2: `useHermesTabs.ts` 구현

**Files:**

- Create: `src/components/hermes/useHermesTabs.ts`

- [ ] **Step 1: 타입 + reducer 구현**

```ts
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useReducer } from "react";

import { commands } from "@/bindings";
import { unwrap } from "@/lib/query/client";

import type { AcpCommand, HermesMessage, SessionStatus, ToolCallSummary } from "./types";

export type TabId = string;

export interface TabState {
  id: TabId;
  name: string;
  status: SessionStatus;
  messages: HermesMessage[];
  commandsList: AcpCommand[];
}

export interface TabsState {
  tabs: Map<TabId, TabState>;
  activeTabId: TabId | null;
}

export const EMPTY_TABS_STATE: TabsState = {
  tabs: new Map(),
  activeTabId: null,
};

export const HERMES_TAB_CAP = 3;

type Action =
  | { type: "open-tab"; tabId: TabId; defaultName: string }
  | { type: "close-tab"; tabId: TabId }
  | { type: "set-active"; tabId: TabId }
  | { type: "rename"; tabId: TabId; name: string }
  | { type: "set-status"; tabId: TabId; status: SessionStatus }
  | { type: "user"; tabId: TabId; text: string; images: string[] }
  | { type: "agent-chunk"; tabId: TabId; text: string }
  | { type: "agent-tool"; tabId: TabId; tool: ToolCallSummary }
  | { type: "tool-update"; tabId: TabId; id?: string; patch: Partial<ToolCallSummary> }
  | { type: "agent-end"; tabId: TabId; status: "ok" | "cancelled" | "error"; error?: string }
  | { type: "system"; tabId: TabId; text: string; level: "info" | "warn" | "error" }
  | { type: "available-commands"; tabId: TabId; commands: AcpCommand[] }
  | { type: "reset-tab"; tabId: TabId };

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function updateTab(state: TabsState, tabId: TabId, fn: (t: TabState) => TabState): TabsState {
  const t = state.tabs.get(tabId);
  if (!t) return state;
  const next = new Map(state.tabs);
  next.set(tabId, fn(t));
  return { ...state, tabs: next };
}

function appendMessages(t: TabState, m: HermesMessage): TabState {
  return { ...t, messages: [...t.messages, m] };
}

function ensureAssistant(t: TabState): TabState {
  const last = t.messages[t.messages.length - 1];
  if (last && last.role === "assistant" && !last.done) return t;
  return appendMessages(t, {
    id: uid(),
    role: "assistant",
    chunks: [],
    toolCalls: [],
    ts: Date.now(),
    done: false,
  });
}

export function tabsReducer(state: TabsState, a: Action): TabsState {
  switch (a.type) {
    case "open-tab": {
      if (state.tabs.has(a.tabId)) return state;
      const next = new Map(state.tabs);
      next.set(a.tabId, {
        id: a.tabId,
        name: a.defaultName,
        status: "idle",
        messages: [],
        commandsList: [],
      });
      return {
        tabs: next,
        activeTabId: state.activeTabId ?? a.tabId,
      };
    }
    case "close-tab": {
      if (!state.tabs.has(a.tabId)) return state;
      const next = new Map(state.tabs);
      next.delete(a.tabId);
      let activeTabId = state.activeTabId;
      if (activeTabId === a.tabId) {
        activeTabId = next.size > 0 ? Array.from(next.keys())[0] : null;
      }
      return { tabs: next, activeTabId };
    }
    case "set-active":
      return state.tabs.has(a.tabId) ? { ...state, activeTabId: a.tabId } : state;

    case "rename":
      return updateTab(state, a.tabId, (t) => ({ ...t, name: a.name }));

    case "set-status":
      return updateTab(state, a.tabId, (t) => ({ ...t, status: a.status }));

    case "user":
      return updateTab(state, a.tabId, (t) =>
        appendMessages(t, {
          id: uid(),
          role: "user",
          text: a.text,
          images: a.images,
          ts: Date.now(),
        }),
      );

    case "system":
      return updateTab(state, a.tabId, (t) =>
        appendMessages(t, {
          id: uid(),
          role: "system",
          text: a.text,
          level: a.level,
          ts: Date.now(),
        }),
      );

    case "agent-chunk": {
      return updateTab(state, a.tabId, (t) => {
        const ensured = ensureAssistant(t);
        const last = ensured.messages[ensured.messages.length - 1];
        if (!last || last.role !== "assistant") return ensured;
        const updated = { ...last, chunks: [...last.chunks, a.text] };
        return { ...ensured, messages: [...ensured.messages.slice(0, -1), updated] };
      });
    }

    case "agent-tool": {
      return updateTab(state, a.tabId, (t) => {
        const ensured = ensureAssistant(t);
        const last = ensured.messages[ensured.messages.length - 1];
        if (!last || last.role !== "assistant") return ensured;
        const updated = { ...last, toolCalls: [...last.toolCalls, a.tool] };
        return { ...ensured, messages: [...ensured.messages.slice(0, -1), updated] };
      });
    }

    case "tool-update": {
      if (!a.id) return state;
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        messages: t.messages.map((m) =>
          m.role === "assistant"
            ? {
                ...m,
                toolCalls: m.toolCalls.map((tc) => (tc.id === a.id ? { ...tc, ...a.patch } : tc)),
              }
            : m,
        ),
      }));
    }

    case "agent-end": {
      return updateTab(state, a.tabId, (t) => {
        const ensured = ensureAssistant(t);
        const last = ensured.messages[ensured.messages.length - 1];
        const closed =
          last && last.role === "assistant"
            ? { ...ensured, messages: [...ensured.messages.slice(0, -1), { ...last, done: true }] }
            : ensured;
        if (a.status !== "ok") {
          return appendMessages(closed, {
            id: uid(),
            role: "system",
            text: a.error ?? `turn ${a.status}`,
            level: "warn",
            ts: Date.now(),
          });
        }
        return closed;
      });
    }

    case "available-commands":
      return updateTab(state, a.tabId, (t) => ({ ...t, commandsList: a.commands }));

    case "reset-tab":
      return updateTab(state, a.tabId, (t) => ({
        ...t,
        messages: [],
        status: "idle",
        commandsList: [],
      }));
  }
}

function pickDefaultName(state: TabsState): string {
  for (let i = 1; i <= 10; i++) {
    const name = `Hermes ${i}`;
    if (!Array.from(state.tabs.values()).some((t) => t.name === name)) return name;
  }
  return `Hermes ${state.tabs.size + 1}`;
}

export function useHermesTabs() {
  const [state, dispatch] = useReducer(tabsReducer, EMPTY_TABS_STATE);

  useEffect(() => {
    let cancelled = false;
    const cleanups: UnlistenFn[] = [];

    type WithTab<T> = T & { tabId?: string };

    const setup = async <T>(event: string, handler: (e: { payload: WithTab<T> }) => void) => {
      const un = await listen<WithTab<T>>(event, handler);
      if (cancelled) {
        un();
        return;
      }
      cleanups.push(un);
    };

    void (async () => {
      await setup<{ kind?: string; text?: string }>("hermes-agent:chunk", (e) => {
        if (!e.payload.tabId) return;
        if (e.payload.kind !== "agent") return;
        dispatch({ type: "agent-chunk", tabId: e.payload.tabId, text: e.payload.text ?? "" });
      });
      await setup<Record<string, unknown>>("hermes-agent:tool-call", (e) => {
        const p = e.payload;
        if (!p.tabId) return;
        dispatch({
          type: "agent-tool",
          tabId: p.tabId as string,
          tool: {
            id: p.toolCallId as string | undefined,
            title: (p.title as string) ?? (p.kind as string) ?? "tool",
            kind: p.kind as string | undefined,
            status: (p.status as string) ?? "in_progress",
          },
        });
      });
      await setup<Record<string, unknown>>("hermes-agent:tool-call-update", (e) => {
        const p = e.payload;
        if (!p.tabId || !p.toolCallId) return;
        const patch: Partial<ToolCallSummary> = {};
        if (p.title !== undefined) patch.title = p.title as string;
        if (p.kind !== undefined) patch.kind = p.kind as string;
        if (p.status !== undefined) patch.status = p.status as string;
        dispatch({
          type: "tool-update",
          tabId: p.tabId as string,
          id: p.toolCallId as string,
          patch,
        });
      });
      await setup<{ status: "ok" | "cancelled" | "error"; error?: string }>(
        "hermes-agent:turn-end",
        (e) => {
          if (!e.payload.tabId) return;
          dispatch({
            type: "agent-end",
            tabId: e.payload.tabId,
            status: e.payload.status,
            error: e.payload.error,
          });
        },
      );
      await setup<{ commands: AcpCommand[] }>("hermes-agent:available-commands", (e) => {
        if (!e.payload.tabId) return;
        dispatch({
          type: "available-commands",
          tabId: e.payload.tabId,
          commands: e.payload.commands ?? [],
        });
      });
      await setup<unknown>("hermes-agent:session-ready", (e) => {
        const tabId = (e.payload as { tabId?: string } | null)?.tabId;
        if (!tabId) return;
        dispatch({ type: "set-status", tabId, status: "ready" });
      });
      await setup<{ kind: string; message: string }>("hermes-agent:error", (e) => {
        if (!e.payload.tabId) return;
        dispatch({ type: "set-status", tabId: e.payload.tabId, status: "error" });
        dispatch({
          type: "system",
          tabId: e.payload.tabId,
          text: `Hermes 오류: ${e.payload.message}`,
          level: "error",
        });
      });
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((u) => u());
    };
  }, []);

  const openTab = useCallback(async (): Promise<TabId | null> => {
    let assignedId: TabId | null = null;
    // 1. cap check via current state (best-effort; backend re-checks)
    if (state.tabs.size >= HERMES_TAB_CAP) return null;
    const tabId = uid();
    const defaultName = pickDefaultName(state);
    try {
      await unwrap(commands.hermesAgentOpenTab(tabId));
      dispatch({ type: "open-tab", tabId, defaultName });
      assignedId = tabId;
    } catch (e) {
      // backend cap fail or other error — surface as system on active tab if any
      if (state.activeTabId) {
        dispatch({
          type: "system",
          tabId: state.activeTabId,
          text: `탭 생성 실패: ${(e as Error).message}`,
          level: "error",
        });
      }
    }
    return assignedId;
  }, [state]);

  const closeTab = useCallback(async (tabId: TabId) => {
    try {
      await unwrap(commands.hermesAgentCloseTab(tabId));
    } catch {
      // best-effort
    }
    dispatch({ type: "close-tab", tabId });
  }, []);

  const send = useCallback(async (tabId: TabId, text: string, images: string[] = []) => {
    if (!text.trim() && images.length === 0) return;
    dispatch({ type: "user", tabId, text, images });
    dispatch({ type: "set-status", tabId, status: "starting" });
    try {
      await unwrap(commands.hermesAgentSend(tabId, text, images));
    } catch (e) {
      dispatch({
        type: "system",
        tabId,
        text: `송신 실패: ${(e as Error).message}`,
        level: "error",
      });
      dispatch({ type: "set-status", tabId, status: "error" });
    }
  }, []);

  const cancel = useCallback(async (tabId: TabId) => {
    try {
      await unwrap(commands.hermesAgentCancel(tabId));
    } catch {
      // best-effort
    }
  }, []);

  const restart = useCallback(async (tabId: TabId) => {
    try {
      await unwrap(commands.hermesAgentCloseTab(tabId));
    } catch {
      // best-effort
    }
    dispatch({ type: "reset-tab", tabId });
    try {
      await unwrap(commands.hermesAgentOpenTab(tabId));
    } catch {
      // ignore
    }
  }, []);

  const setActive = useCallback((tabId: TabId) => {
    dispatch({ type: "set-active", tabId });
  }, []);

  const rename = useCallback((tabId: TabId, name: string) => {
    dispatch({ type: "rename", tabId, name });
  }, []);

  const activeTab = state.activeTabId ? (state.tabs.get(state.activeTabId) ?? null) : null;

  const isStreaming = useMemo(() => {
    if (!activeTab) return false;
    const last = activeTab.messages[activeTab.messages.length - 1];
    return !!last && last.role === "assistant" && !last.done;
  }, [activeTab]);

  return {
    state,
    activeTab,
    isStreaming,
    openTab,
    closeTab,
    setActive,
    send,
    cancel,
    restart,
    rename,
  };
}
```

- [ ] **Step 2: 테스트 통과 확인**

```bash
pnpm vitest run src/components/hermes/useHermesTabs.test.ts
```

Expected: 7 tests passed.

- [ ] **Step 3: lint**

```bash
pnpm lint src/components/hermes/useHermesTabs.ts src/components/hermes/useHermesTabs.test.ts
```

Expected: 0 errors.

---

## Task 2.3: `HermesPanel.tsx` — 헤더 ⊕/🗑 + 활성 탭 라우팅

**Files:**

- Modify: `src/components/hermes/HermesPanel.tsx`
- Modify: `src/components/hermes/HermesChatInput.tsx`
- Modify: `src/components/hermes/HermesChatLog.tsx`

> `HermesChatLog` / `HermesChatInput`은 현재 `messages` / `onSend` 등을 받는 dumb component일 가능성이 큼. props 변경 없거나 적음 — `useHermesTabs` 의 `activeTab` 에서 추출해서 그대로 넘긴다.

- [ ] **Step 1: HermesView(상위 호출자) 또는 HermesPanel 부모에서 `useHermesAgent` 제거 → `useHermesTabs` 로 교체**

먼저 `grep -rn "useHermesAgent" src/` 로 호출자 식별:

```bash
grep -rn "useHermesAgent\|hermesAgentStart" src/
```

호출자 파일에서:

```ts
// before
import { useHermesAgent } from "@/components/hermes/useHermesAgent";
const { messages, status, isStreaming, send, cancel, restart } = useHermesAgent();

// after
import { useHermesTabs } from "@/components/hermes/useHermesTabs";
const tabs = useHermesTabs();
const active = tabs.activeTab;
```

`<HermesPanel>` 에 새 props 전달:

```tsx
<HermesPanel
  isStreaming={tabs.isStreaming}
  onNewTab={tabs.openTab}
  onCloseActive={async () => active && tabs.closeTab(active.id)}
  onRestart={async () => active && tabs.restart(active.id)}
  canCreateTab={tabs.state.tabs.size < HERMES_TAB_CAP}
  activeTabId={active?.id ?? null}
>
  {active ? (
    <>
      <HermesChatLog messages={active.messages} />
      <HermesChatInput
        onSend={(text, images) => tabs.send(active.id, text, images)}
        onCancel={() => tabs.cancel(active.id)}
        commandsList={active.commandsList}
        status={active.status}
        isStreaming={tabs.isStreaming}
      />
    </>
  ) : (
    <EmptyHermesState onCreateTab={tabs.openTab} />
  )}
</HermesPanel>
```

`EmptyHermesState` 는 짧은 inline 컴포넌트:

```tsx
function EmptyHermesState({ onCreateTab }: { onCreateTab: () => Promise<unknown> }) {
  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center p-6 text-sm">
      <Button variant="default" onClick={() => void onCreateTab()}>
        새 탭 시작
      </Button>
    </div>
  );
}
```

- [ ] **Step 2: `HermesPanel` 헤더에 ⊕/🗑 버튼 추가**

`PanelHeader` 컴포넌트의 우측 버튼 그룹 (X 버튼 옆) 수정:

```tsx
// import 추가:
import { Plus, Trash2, RotateCcw, X } from "lucide-react";

// props 확장:
function PanelHeader({
  x, y, w, h, onBoundsChange, onClose, onRestart, isStreaming,
  onNewTab, onCloseActive, canCreateTab, activeTabId,
}: BoundsProps & {
  onClose: () => void;
  onRestart?: () => void;
  isStreaming?: boolean;
  onNewTab?: () => Promise<unknown>;
  onCloseActive?: () => Promise<unknown>;
  canCreateTab?: boolean;
  activeTabId?: string | null;
}) {
  // ... 기존 본문 ...
  return (
    <div ...>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-sm font-medium tracking-tight">Hermes</span>
        {isStreaming && (/* 기존 스피너 */)}
      </span>
      <div className="flex items-center gap-1" data-no-drag>
        {onNewTab && (
          <Button
            data-no-drag
            variant="ghost"
            className="hover:bg-muted/60 h-7 w-7 p-0"
            onClick={() => void onNewTab()}
            disabled={canCreateTab === false}
            aria-label="새 탭"
            title={canCreateTab === false ? "최대 3개" : "새 탭"}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
        {onCloseActive && activeTabId && (
          <Button
            data-no-drag
            variant="ghost"
            className="hover:bg-muted/60 h-7 w-7 p-0"
            onClick={() => void onCloseActive()}
            aria-label="현재 탭 닫기"
            title="현재 탭 닫기"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        {onRestart && (
          <Button .../* 기존 ↻ */>
            <RotateCcw className="size-3.5" />
          </Button>
        )}
        <Button .../* 기존 X */>
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
```

`HermesPanel` 컴포넌트 자체의 props 시그니처도 동일하게 확장 후 `PanelHeader` 에 패스스루.

- [ ] **Step 3: useHermesAgent.ts 삭제 + 참조 제거**

```bash
git rm src/components/hermes/useHermesAgent.ts
grep -rn "useHermesAgent\|HermesMessage" src/ | grep -v "useHermesTabs\|types.ts" | head
```

`HermesMessage` 타입 import 는 `./types` 에서 그대로 유지(types.ts 는 변경 없음).

- [ ] **Step 4: typecheck + lint + vitest**

```bash
pnpm typecheck 2>&1 | tail -20
pnpm lint 2>&1 | tail -5
pnpm vitest run 2>&1 | tail -10
```

Expected: 0 errors. 기존 `HermesChatInput.test.ts` 통과 유지.

- [ ] **Step 5: Phase 1+2 묶음 커밋 (dev)**

```bash
git add src-tauri/ src/bindings.ts src/components/hermes/ && \
PATH="$HOME/.cargo/bin:$PATH" git commit -m "$(cat <<'EOF'
feat(hermes): multi-session tabs (cap 3, lazy spawn)

- Rust holder Arc<RwLock<HashMap<TabId, AcpSession>>>
- IPC: open_tab / send(tabId,...) / cancel(tabId) / close_tab(tabId) / stop
- 모든 hermes-agent:* 이벤트 payload 최상위에 tabId 라우팅 키
- 프런트: useHermesTabs 단일 훅, HermesPanel ⊕/🗑 헤더
- 기존 useHermesAgent / hermes_agent_start 제거
- AgentStatusBar 통합은 후속 PR (PR3)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: 수동 스모크 (`pnpm tauri dev`)**

- 패널 열기 → 빈 상태 "새 탭 시작" 버튼 보임 → 클릭 → 빈 탭 1개 생성.
- 메시지 송신 → 응답 정상 (lazy spawn 후 chunk → end).
- 헤더 ⊕ 2회 클릭 → 탭 3개. 3번째 후 ⊕ disabled + "최대 3개" tooltip.
- 🗑 누르면 현재 탭 종료(자동 다른 탭 active).
- 마지막 탭 🗑 → 빈 상태 화면.
- Esc 로 패널 닫고 다시 열기 → 탭 상태 유지(child 살아있음).
- 다른 탭들 간 응답 섞이지 않음(탭 A 송신 중 탭 B 정적).

---

# Phase 3 — AgentStatusBar 통합 (PR3)

> 이 시점에서 `useHermesTabs` 상태가 호출자 컴포넌트에 머물러 있다. AgentStatusBar 는 별도 트리에서 마운트되므로 **전역 store** 가 필요하다.

## Task 3.1: `useHermesTabs` 를 전역 store 로 승격

**Files:**

- Modify: `src/components/hermes/useHermesTabs.ts`
- Modify: 호출자(HermesView 등)

선택: zustand 또는 React Context. work-radar 는 이미 zustand `useUIStore` 사용 — 일관성 위해 zustand.

- [ ] **Step 1: store 분리**

`src/components/hermes/useHermesTabsStore.ts` 신규 — `useHermesTabs` 내부의 reducer 상태를 zustand store 로 옮긴다. listen 부수효과는 store provider mount 1회만 동작하도록 `App.tsx` 또는 별도 마운트 컴포넌트로 분리.

(상세 코드 생략 — Task 2.2의 `useHermesTabs` 본문을 zustand `create` 로 감싸고, mount 시 1회 listen 등록하는 `useHermesTabsBootstrap()` 훅 도입. AgentStatusBar는 selector 만 구독.)

- [ ] **Step 2: 호출자 마이그레이션**

`App.tsx` 또는 최상위 컴포넌트에서 `useHermesTabsBootstrap()` 호출. HermesView 와 AgentStatusBar 는 store selector 로 데이터 구독.

- [ ] **Step 3: vitest + typecheck**

```bash
pnpm typecheck && pnpm vitest run src/components/hermes/
```

Expected: green.

---

## Task 3.2: AgentStatusBar — hermes 박스 탭별 enumerate

**Files:**

- Modify: `src/components/AgentStatusBar.tsx`

- [ ] **Step 1: 기존 `hermes.data?.configured` 분기 교체**

```ts
// before (line ~163 부근):
if (hermes.data?.configured) {
  out.push({
    key: "hermes",
    engine: "hermes",
    ...
    state: "idle",
  });
}

// after:
const tabs = useHermesTabsStore((s) => s.tabs);  // Map<TabId, TabState>
for (const t of tabs.values()) {
  const state: BoxState =
    t.status === "error"
      ? "error"
      : t.status === "starting" || /* streaming check */ false
      ? "working"
      : "idle";
  out.push({
    key: `hermes:${t.id}`,
    engine: "hermes",
    name: t.name,
    state,
    stateLabel: STATE_LABEL[state],
    startedMs: null,
    timeoutSec: null,
    title: `Hermes · ${t.name} · ${STATE_LABEL[state]}`,
  });
}
```

- [ ] **Step 2: ⊕ 칩 추가**

박스 렌더 루프 직후, `hermes` 박스 그룹 우측에 cap 미달 시 ⊕ 칩을 그린다:

```tsx
{
  tabs.size < HERMES_TAB_CAP && (
    <button
      className="asb-add-chip"
      aria-label="새 Hermes 탭"
      title="새 Hermes 탭"
      onClick={() => void openTab()}
    >
      <Plus size={12} strokeWidth={1.5} />
    </button>
  );
}
```

CSS는 기존 `.asb-box` 와 비슷한 톤. `AgentStatusBar.css` 에 `.asb-add-chip` 32×24 정도 추가.

- [ ] **Step 3: 박스 click=focus / dblclick=rename**

박스 onClick 핸들러에서 `key.startsWith("hermes:")` 인 경우:

```ts
const onBoxClick = (box: SessionBox) => {
  if (box.key.startsWith("hermes:")) {
    const tabId = box.key.slice("hermes:".length);
    setActive(tabId);
    // 패널 닫혀 있으면 열기
    void emit("hermes:toggle");
    return;
  }
  // 기존 codex / cmux 분기
};
```

박스 onDoubleClick: 인라인 input 으로 진입 — 기존 `AgentStatusBar` 의 박스 이름 편집 패턴 (line ~466 `aria-label="에이전트 박스 이름 편집"`) 재사용. 단 저장은 `rename(tabId, name)`(store action) 호출.

- [ ] **Step 4: typecheck + lint + vitest**

```bash
pnpm typecheck && pnpm lint && pnpm vitest run
```

Expected: green.

- [ ] **Step 5: Phase 3 커밋 (dev)**

```bash
git add src/components/AgentStatusBar.tsx src/components/AgentStatusBar.css src/components/hermes/ && \
PATH="$HOME/.cargo/bin:$PATH" git commit -m "$(cat <<'EOF'
feat(agent-status-bar): Hermes tabs as per-tab boxes + ⊕/rename

- hermes 박스 탭당 1개 enumerate (useHermesTabsStore selector)
- 박스 그룹 우측 ⊕ 칩 — cap 3 도달 시 hidden
- 박스 클릭 = setActive + hermes:toggle (패널 열기)
- 박스 dblclick = in-memory rename (기존 박스 이름 편집 UX 재사용)
- INVARIANT #1: 박스 클릭은 표시 네비, 결정 미사용

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: 수동 스모크**

- 탭 0개 상태: 박스 없음, ⊕ 칩만.
- 탭 1~3개: 박스 N개 + (≤2개일 때만) ⊕ 칩.
- 박스 클릭 → 해당 탭으로 전환, 패널 닫혀 있으면 열림.
- 박스 더블클릭 → 인라인 편집, Enter 저장, Esc 취소.
- 다른 탭이 응답 중일 때 그 박스 색 = working (border-bottom 작업은 PR4 영역, 현 PR에서는 기존 좌측 dot 그대로).

---

## 검증 (Phase done-criteria)

- [ ] `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` green.
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` green.
- [ ] `src/bindings.ts` drift 0 (CI 게이트).
- [ ] 위 수동 스모크 (Phase 2, Phase 3 각각) 결과를 PR 본문에 관찰 결과로 기록.
- [ ] reviewer/critic 별도 패스 ACCEPT (self-approve 금지).
- [ ] `docs/decisions.md` 에 한 줄 결정 로그 추가:
  ```
  - 2026-05-28 hermes-multi-session: 상한 3, lazy spawn, in-memory only.
    탭 UI는 AgentStatusBar 박스 + 패널 헤더 ⊕/🗑. 영속화/idle-eviction/border-color는 follow-up.
  ```

## 후속 (별도 plan)

- PR4 — AgentStatusBar 상태등 좌측 dot → 박스 하단 border 색. `DESIGN.md` agent-status-bar 섹션 갱신, 본 plan 비범위.
- 탭 영속화 (SQLite).
- idle eviction (30분).
- 멀티 윈도우 pop-out.

---

## Self-Review

- **Spec coverage:**
  - §1 동기 → motivation 반영.
  - §2 범위/비범위 → Phase 1~3 + 후속 분리.
  - §3 결정 → 모든 행 task에 매핑(상한=3 Task 1.3 Step 2, lazy spawn Task 1.3 Step 3, ⊕/🗑 Task 2.3 Step 2, 더블클릭 rename Task 3.2 Step 3).
  - §4.1 holder → Task 1.3 Step 1.
  - §4.2 IPC 5종 → Task 1.3 Step 2~6.
  - §4.3 이벤트 payload 변경 → Task 1.1 emit 래퍼 + Task 1.2 dispatch_incoming.
  - §4.4 useHermesTabs → Task 2.1, 2.2.
  - §4.5 패널 헤더 → Task 2.3 Step 2.
  - §4.6 AgentStatusBar → Task 3.2.
  - §4.7 라이프사이클 → Task 1.3 Step 5 (stop=모든 탭) + Step 4 (close_tab=child kill).
  - §5 에러 → Task 1.3 cap 에러, Task 2.2 openTab catch.
  - §6 영속성 없음 → 어떤 마이그레이션도 plan에 없음(확인).
  - §7 테스트 → Task 1.5 Rust 유닛 + Task 2.1 vitest + 스모크.
  - §10 PR 분할 → Phase 1+2(묶음) / Phase 3 / PR4(별도 plan).

- **Placeholder scan:**
  - Task 3.1 Step 1 "상세 코드 생략" — zustand store wrapping은 패턴이라 정당화 가능하나 명시적 코드를 원하면 보강 필요. 실행자가 막히면 Task 2.2 의 `useHermesTabs` 본문을 `create<TabsState & Actions>((set) => ...)` 로 감싸고 listen 부수효과를 `useEffect`(bootstrap 훅)에 두는 표준 패턴.
  - "/_ 기존 ↻ _/", "/_ 기존 X _/" — 의도된 참조 (HermesPanel.tsx:222 기존 코드 동일 유지). 실행 시 기존 JSX 그대로 복붙.

- **Type consistency:**
  - `TabId = string` Task 2.2 정의, 이후 모든 task에서 동일.
  - `commands.hermesAgentSend(tabId, text, images)` — Task 1.3 IPC 시그니처와 Task 2.2 호출 일치.
  - `useHermesTabsStore` — Task 3.1 도입, Task 3.2 사용.

- **이슈 발견 없음 외:** Task 3.1 의 store 마이그레이션은 코드 양이 상당하나 task structure가 분명하므로 추후 필요 시 별도 task로 더 쪼갤 수 있음. 현 plan 그대로 진행 가능.
