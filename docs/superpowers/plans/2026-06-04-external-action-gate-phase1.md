# External Action Gate — Phase 1 (MCP server, proposal-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 외부 AI 에이전트가 spawn하는 `work-radar --mcp-stdio` stdio MCP 서버를 만들어, read 툴(조회)과 write 툴(Phase 0 `store::enqueue`만 호출 = proposal-only)을 노출한다. 실 외부 호출은 0(커넥터는 Phase 2~5). 먼저 Phase 0 critic Minor #1(토큰 경화)을 처리해 MCP 모듈이 같은 crate에 들어와도 `Acceptance`를 위조할 수 없게 한다.

**Architecture:** 기존 바이너리에 `--mcp-stdio` 플래그 모드 추가 → 앱과 **동일한 SQLite DB**(같은 경로 resolver 재사용)를 열고 rmcp 기반 stdio MCP 서버를 `serve_server` + `stdio()`로 구동. 툴은 `#[tool_router(server_handler)]`/`#[tool]` 매크로. write 툴은 `store::enqueue`만 호출(커넥터 `execute` 경로 없음 — 모듈 경계 + 토큰 visibility로 강제). 승인은 GUI(같은 DB의 PendingActionsPanel)가 처리.

**Tech Stack:** Rust, `rmcp`(features `server,transport-io,macros`), `schemars`(JsonSchema), `serde`, sqlx 0.8 SQLite, tokio, 기존 `external_actions::store`/`AppError`/`Db` 인프라.

**Spec:** `docs/superpowers/specs/2026-06-04-external-action-gate-mcp-design.md` §3
**선행:** `docs/superpowers/plans/2026-06-04-external-action-gate-phase0.md` (Phase 0 = DONE, 이 브랜치 `feat/external-action-gate-mcp`).

**전제(이 레포 규율 — Phase 0 플랜과 동일):**
- cargo는 `src-tauri/`에서, PATH에 `$HOME/.cargo/bin` export. bindings 재생성 = `cargo test`.
- 새 PK 노출 id는 `i32`. `Db`=`SqlitePool` 별칭(`db.inner()`/`&pool`).
- 게이트: cargo test + clippy `-D warnings` + fmt + typecheck + lint + vitest + bindings drift(이 Phase는 IPC 무추가 → drift 0 기대).
- **done = critic(opus 별도) ACCEPT.** push는 사용자 명시 요청 시에만.

**⚠️ 검증 가드(추측 금지 — 실제 코드에서 확인):**
- **DB 경로 resolver:** 앱이 SQLite 경로를 어떻게 정하는지(app-data dir + `WORK_RADAR_DEV_DB` override 가능) `git grep -n "WORK_RADAR_DEV_DB\|connect\|SqlitePool\|migrate" src-tauri/src/db.rs` 로 찾아 **그 함수를 재사용**(하드코딩 금지). 마이그레이션 적용 경로도 동일하게.
- **rmcp 버전/API:** `cargo add rmcp --features server,transport-io,macros` 후 `cargo doc`/docs.rs로 매크로 시그니처 확인. 이 플랜의 rmcp 코드는 docs.rs(`#[tool_router(server_handler)]`, `#[tool]`, `Parameters<T>`, `Json<Out>`, `serve_server`, `stdio()`) 기준 — 버전차로 시그니처가 다르면 docs에 맞춘다.
- **앱 부팅 회귀 금지:** `--mcp-stdio` 분기는 GUI 부팅 경로를 **건드리지 않는다**(플래그 없으면 기존 `run()` 그대로).

---

## File Structure

- Modify: `src-tauri/src/external_actions/mod.rs` — `Acceptance`/`ExternalConnector`를 private 서브모듈 `gate`로 이동, `mint` visibility를 `pub(crate)`→`pub(in crate::external_actions)`로 좁힘.
- Create: `src-tauri/src/external_actions/gate.rs` — `Acceptance`(private 필드, module-scoped mint) + `ExternalConnector` 트레잇 + `ExecOutcome`.
- Create: `src-tauri/tests/external_actions_gate_compile_fail.rs` + `src-tauri/tests/compile_fail/*.rs` — `trybuild` compile-fail 테스트(out-of-module mint/execute 금지 증명).
- Create: `src-tauri/src/mcp/mod.rs` — MCP 서버 핸들러(`#[tool_router(server_handler)]`), 툴 정의, DB 풀 보유.
- Create: `src-tauri/src/mcp/run.rs` — `run_mcp_stdio()`: DB 열기(resolver 재사용) → `serve_server(handler, stdio()).await`.
- Modify: `src-tauri/src/lib.rs` — `run()`이 `--mcp-stdio` arg 감지 시 `mcp::run::run_mcp_stdio()`로 분기(아니면 기존 GUI). `mod mcp;` 선언.
- Modify: `src-tauri/Cargo.toml` — `rmcp`(server,transport-io,macros) + `schemars` 추가. `[dev-dependencies]`에 `trybuild`.
- Create: `docs/areas/...` 또는 README 스니펫 — 외부 에이전트 MCP 등록법(`work-radar --mcp-stdio`) 문서화(Task 1.6).

> 참고: `store::enqueue`는 Phase 0에서 이미 `pub(crate)` — MCP 모듈이 같은 crate라 직접 호출 가능. 새 IPC/bindings 추가 없음(이 Phase는 specta 무관) → bindings drift 0.

---

## Task 1.0: Token hardening — Acceptance into private submodule + trybuild (Phase 0 critic Minor #1)

**Files:**
- Modify: `src-tauri/src/external_actions/mod.rs`
- Create: `src-tauri/src/external_actions/gate.rs`
- Create: `src-tauri/tests/compile_fail.rs`, `src-tauri/tests/compile_fail/mint_outside.rs`

**왜 먼저:** Phase 1이 같은 crate에 `mcp` 모듈을 들인다. 현재 `mint`이 `pub(crate)`라 crate 내 누구나 토큰 위조 가능(grep-attested일 뿐). MCP 모듈이 실수로 `Acceptance::mint(...)` + `execute`를 직접 호출하면 INVARIANT #1 위반. visibility를 `pub(in crate::external_actions)`로 좁혀 **external_actions 모듈 트리만** mint 가능하게 하고, 그 밖(예: `mcp`, `commands`)에서의 호출이 **컴파일 실패**함을 trybuild로 잠근다.

- [ ] **Step 1: Move Acceptance/ExternalConnector/ExecOutcome into `gate.rs`**

`src-tauri/src/external_actions/gate.rs` 생성. `mod.rs`의 `Acceptance`/`ExecOutcome`/`ExternalConnector` 정의를 그대로 옮기되 `mint` visibility만 변경:

```rust
//! 승인 토큰 경계. `mint`은 external_actions 모듈 트리 안에서만 호출 가능(`store::approve`).
//! 밖(mcp/commands 등)에서의 mint/직접 execute는 컴파일 불가 — INVARIANT #1/#2 type-wall.

use serde::{Deserialize, Serialize};
use specta::Type;

/// 승인 증거 토큰. 필드 private + mint은 `pub(in crate::external_actions)`.
#[derive(Debug)]
pub struct Acceptance {
    action_id: String,
}

impl Acceptance {
    /// external_actions 모듈 트리 전용 mint. 외부 모듈에서 호출 시 컴파일 에러.
    pub(in crate::external_actions) fn mint(action_id: String) -> Self {
        Acceptance { action_id }
    }
    pub fn action_id(&self) -> &str {
        &self.action_id
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    pub external_ref: Option<String>,
    pub bytes: Option<i64>,
}

#[allow(async_fn_in_trait)]
pub trait ExternalConnector {
    async fn execute(
        &self,
        action: &crate::external_actions::ExternalAction,
        _gate: &Acceptance,
    ) -> Result<ExecOutcome, crate::error::AppError>;
}
```

`mod.rs`에서 정의를 삭제하고 re-export로 대체(다른 모듈의 import 경로 유지):

```rust
mod gate;
pub use gate::{Acceptance, ExecOutcome, ExternalConnector};
```

> `store.rs`의 `Acceptance::mint(...)` 호출은 `store`가 `crate::external_actions::store`라 `pub(in crate::external_actions)` 범위 안 → 그대로 컴파일된다. `mod.rs`의 기존 `token_tests`에서 `Acceptance::mint`를 호출하던 단위 테스트는 `external_actions` 안이라 OK(유지). 단 `mod.rs` 안에서 호출하므로 범위 OK.

- [ ] **Step 2: Run existing tests to confirm no behavior change**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --lib external_actions 2>&1 | tail -8`
Expected: 9 passed (Phase 0 테스트 전부 그대로 통과 — 이동만 했으므로).

- [ ] **Step 3: Add trybuild dev-dependency + compile-fail test**

`Cargo.toml [dev-dependencies]`에 `trybuild = "1"` 추가. `src-tauri/tests/compile_fail.rs`:

```rust
//! `Acceptance::mint`이 external_actions 밖에서 호출 불가함을 컴파일 레벨로 잠금.
#[test]
fn mint_is_unreachable_outside_module() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/mint_outside.rs");
}
```

`src-tauri/tests/compile_fail/mint_outside.rs`:

```rust
// external_actions 밖(integration test crate)에서 mint 호출 → 컴파일 실패해야 함.
fn main() {
    let _ = work_radar_lib::external_actions::Acceptance::mint("x".into());
}
```

> ⚠️ 확인: `external_actions` 모듈과 `Acceptance`가 `work_radar_lib`에서 `pub`으로 보이는지(`mod external_actions;`가 `pub mod`인지). 현재 `lib.rs`는 `mod external_actions;`(non-pub)일 수 있음 → integration test에서 안 보임. 그 경우 compile-fail 이유가 "private module"이 돼버려 mint-visibility를 테스트하지 못한다. **해결:** `lib.rs`를 `pub mod external_actions;`로 바꾸고(타입은 이미 pub), compile-fail 대상을 `mint`의 visibility로 한정. trybuild 기대 메시지에 "function `mint` is private" 류가 포함되는지 `.stderr` 파일로 고정하거나, `t.compile_fail`만으로 충분(컴파일 실패 자체 검증).

- [ ] **Step 4: Run trybuild + full gates**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --test compile_fail 2>&1 | tail -15`
Expected: PASS(= mint_outside.rs가 의도대로 컴파일 실패). 이어 `cargo test 2>&1 | tail -5`, `cargo clippy --all-targets -- -D warnings`, `cargo fmt --check` 전부 clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/external_actions/ src-tauri/tests/compile_fail.rs src-tauri/tests/compile_fail/ src-tauri/Cargo.toml
git commit -m "refactor(external-actions): module-private Acceptance::mint + trybuild compile-fail (token type-wall)"
```

---

## Task 1.1: rmcp dependency + MCP handler skeleton with one read tool

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod mcp;`)

- [ ] **Step 1: Add deps**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo add rmcp --features server,transport-io,macros && cargo add schemars`
Verify the resolved `rmcp` version in `Cargo.toml`; read its docs.rs for the exact macro/transport API before writing Step 2 (versions can differ).

- [ ] **Step 2: Write the MCP handler with a `WrServer` holding a DB pool + one read tool**

`src-tauri/src/mcp/mod.rs`:

```rust
//! work-radar MCP 서버(Phase 1, proposal-only). 외부 에이전트가 `work-radar --mcp-stdio`로 spawn.
//! read 툴 = DB 조회. write 툴 = `store::enqueue`만(커넥터 execute 경로 없음 — gate visibility로 강제).

pub mod run;

use crate::db::Db;
use crate::external_actions::store;
use rmcp::handler::server::wrapper::Json;
use rmcp::handler::server::router::tool::Parameters;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct WrServer {
    pub db: Db,
}

#[derive(Serialize, JsonSchema)]
pub struct PendingActionDto {
    pub id: String,
    pub kind: String,
    pub origin: String,
    pub status: String,
}

#[derive(Serialize, JsonSchema)]
pub struct PendingList {
    pub actions: Vec<PendingActionDto>,
}

#[rmcp::tool_router(server_handler)]
impl WrServer {
    /// 승인 대기 외부 액션 목록(메타만). 토큰/payload 본문 미노출.
    #[rmcp::tool(name = "wr_list_pending_actions", description = "List external actions awaiting user approval (metadata only).")]
    async fn list_pending_actions(&self) -> Json<PendingList> {
        let rows = store::list_pending(&self.db).await.unwrap_or_default();
        Json(PendingList {
            actions: rows
                .into_iter()
                .map(|a| PendingActionDto { id: a.id, kind: a.kind, origin: a.origin, status: a.status })
                .collect(),
        })
    }
}
```

`lib.rs`에 `mod mcp;` 추가.

> ⚠️ rmcp 매크로가 `#[tool_router(server_handler)]`로 `ServerHandler` impl을 자동 emit하지 않는 버전이면 별도 `#[tool_handler] impl ServerHandler for WrServer {}`를 추가. docs.rs에 맞춘다. 툴 메서드가 `Result`/`Json`/`String` 중 무엇을 반환해야 하는지도 버전별 확인. `unwrap_or_default()`는 read 경로의 DB 에러를 빈 목록으로 degrade(MCP 툴은 패닉 금지) — clippy `unwrap_used`는 `unwrap_or_default`엔 미적용이나, 프로덕션 `#![deny(clippy::unwrap_used)]` 범위면 `.unwrap()` 금지 유지.

- [ ] **Step 3: Compile check**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo build 2>&1 | tail -15`
Expected: 컴파일 성공(툴 라우터 매크로 전개 포함). 실패 시 rmcp 시그니처 docs 대조.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/mcp/ src-tauri/src/lib.rs
git commit -m "feat(mcp): rmcp stdio server skeleton + wr_list_pending_actions read tool"
```

---

## Task 1.2: Flag-mode entry — `work-radar --mcp-stdio`

**Files:**
- Create: `src-tauri/src/mcp/run.rs`
- Modify: `src-tauri/src/lib.rs` (`run()` arg 분기)

- [ ] **Step 1: Write `run_mcp_stdio` reusing the app's DB resolver**

`src-tauri/src/mcp/run.rs`:

```rust
//! `--mcp-stdio` 진입점: 앱과 동일 DB를 열고 stdio MCP 서버 구동(블로킹).

use crate::mcp::WrServer;
use rmcp::transport::io::stdio;
use rmcp::service::serve_server;

pub async fn run_mcp_stdio() -> Result<(), Box<dyn std::error::Error>> {
    // ⚠️ 앱과 동일한 DB 경로/풀 생성 함수를 재사용한다(하드코딩 금지).
    // 예: crate::db::connect_pool() 또는 동등 함수 — 실제 이름은 db.rs에서 확인.
    let db = crate::db::open_pool_same_as_app().await?; // <- 실제 resolver로 교체
    let server = WrServer { db };
    let running = serve_server(server, stdio()).await?;
    running.waiting().await?;
    Ok(())
}
```

> ⚠️ `crate::db::open_pool_same_as_app`는 placeholder — `db.rs`에서 앱이 쓰는 pool-생성/마이그레이션 함수를 찾아 그것을 호출(또는 얇게 래핑). 마이그레이션은 앱이 이미 적용하므로 MCP 측은 connect만 해도 되지만, 단독 실행 대비 `sqlx::migrate!` 재적용은 idempotent라 안전(앱 db.rs 패턴 따름).

- [ ] **Step 2: Branch in `run()`**

`lib.rs`의 `pub fn run()` 최상단에서 arg 감지:

```rust
pub fn run() {
    if std::env::args().any(|a| a == "--mcp-stdio") {
        // GUI 부팅 경로를 타지 않는다.
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        if let Err(e) = rt.block_on(crate::mcp::run::run_mcp_stdio()) {
            eprintln!("mcp-stdio error: {e}");
            std::process::exit(1);
        }
        return;
    }
    // ... 기존 GUI 부팅 그대로 ...
}
```

> ⚠️ 기존 `run()`이 이미 tokio runtime/`tauri::Builder`를 세우는 방식 확인 후 분기를 **그 앞**에 둔다(중복 runtime 주의 — 이미 `#[tokio::main]`이면 `block_on` 대신 그 컨텍스트 사용). stdout은 MCP 프레이밍 전용이므로 `--mcp-stdio` 모드에서 로깅을 stderr로(혹은 끔) — tracing이 stdout으로 가면 MCP 프로토콜 오염.

- [ ] **Step 3: Manual smoke (the agent may not be able to run GUI; this is a headless process)**

Run (from repo root): `export PATH="$HOME/.cargo/bin:$PATH"; (cd src-tauri && cargo build) && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' | ./src-tauri/target/debug/work-radar --mcp-stdio 2>/tmp/mcp.err | head -1`
Expected: a JSON-RPC `initialize` result line on stdout (server speaks MCP). If binary name differs, use the actual one from `Cargo.toml [package] name`/`[[bin]]`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mcp/run.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): --mcp-stdio flag-mode entry (shared DB, stdio transport)"
```

---

## Task 1.3: Write tool (enqueue-only) + wr_action_status

**Files:**
- Modify: `src-tauri/src/mcp/mod.rs`

> Phase 1엔 실 `ExternalAction` 변형이 `Noop`뿐(커넥터는 Phase 2~5). 따라서 write 툴은 **proposal 경로를 증명하는** `wr_propose_noop`(origin=`mcp:<client>` 기록, `store::enqueue` 호출, action_id 반환). 실 write 툴(wr_github_comment 등)은 커넥터와 함께 Phase 2~5에서 추가.

- [ ] **Step 1: Add enqueue-only write tool + status tool**

`mcp/mod.rs`의 `impl WrServer`에 추가:

```rust
#[derive(Deserialize, JsonSchema)]
pub struct ProposeNoopParams {
    /// 사람-친화 미리보기(승인 패널 표시용).
    pub preview: String,
    /// 임의 메모(Noop payload).
    pub note: String,
}

#[derive(Serialize, JsonSchema)]
pub struct ProposeResult {
    pub action_id: String,
    pub status: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct ActionIdParams {
    pub action_id: String,
}

#[derive(Serialize, JsonSchema)]
pub struct ActionStatus {
    pub status: Option<String>,
}

// (impl WrServer 안)
/// 제안만 생성한다 — 실행 안 함. 사용자 승인 후 Rust가 실행(Phase 0 게이트).
#[rmcp::tool(name = "wr_propose_noop", description = "Propose a no-op external action (Phase 1 proposal-path demo). Returns an action_id awaiting user approval; does NOT execute.")]
async fn propose_noop(&self, Parameters(p): Parameters<ProposeNoopParams>) -> Json<ProposeResult> {
    use crate::external_actions::ExternalAction;
    let action = ExternalAction::Noop { note: p.note };
    match store::enqueue(&self.db, &action, None, Some(&p.preview), "mcp:client").await {
        Ok(id) => Json(ProposeResult { action_id: id, status: "awaiting_approval".into() }),
        Err(_) => Json(ProposeResult { action_id: String::new(), status: "error".into() }),
    }
}

/// 액션 승인/실행 상태 폴링(bounded — terminal 도달 시 종료는 클라이언트 책임).
#[rmcp::tool(name = "wr_action_status", description = "Poll the status of a proposed action by id (awaiting_approval | succeeded | failed | rejected).")]
async fn action_status(&self, Parameters(p): Parameters<ActionIdParams>) -> Json<ActionStatus> {
    let status = store::status(&self.db, &p.action_id).await.unwrap_or(None);
    Json(ActionStatus { status })
}
```

> 계약 재확인: 이 모듈은 `store::{enqueue,list_pending,status}`만 호출 — `approve`/`execute`/`Acceptance::mint`로의 경로 없음(Task 1.0 visibility로 컴파일 보장). origin 문자열은 향후 MCP 클라이언트명으로 채움(Phase 1은 고정 `mcp:client`).

- [ ] **Step 2: Compile + clippy**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo build 2>&1 | tail -8 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -8`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): wr_propose_noop (enqueue-only) + wr_action_status tools"
```

---

## Task 1.4: Headless MCP roundtrip integration test

**Files:**
- Create: `src-tauri/tests/mcp_roundtrip.rs`

**목표:** in-process로 `WrServer`의 툴을 호출 → `store::enqueue`가 DB에 행을 만들고 `list_pending`/`status`가 반영함을 검증(실 외부호출 0). rmcp의 in-memory/duplex transport로 client↔server 라운드트립을 돌리거나(권장), 어려우면 핸들러 메서드를 직접 호출하는 단위 테스트로 대체.

- [ ] **Step 1: Write the roundtrip test**

```rust
//! MCP 툴 라운드트립: propose_noop → enqueue → list_pending/status 반영(외부호출 0).
use work_radar_lib::external_actions::store;
use work_radar_lib::mcp::WrServer;

// fresh_db는 test-only — 통합 테스트에서 접근 가능하도록 노출돼 있어야 한다.
// 접근 불가하면 sqlx로 tempdir DB + migrate를 이 테스트에서 직접 구성(앱 db.rs 패턴 복제 최소화).

#[tokio::test]
async fn propose_then_list_and_status() {
    let db = /* tempdir pool + migrate (앱 resolver 또는 test 헬퍼) */;
    let server = WrServer { db: db.clone() };

    // 툴 메서드 직접 호출(핸들러 단위) — rmcp client 왕복이 가능하면 그걸로 대체.
    let res = server
        .propose_noop(rmcp::handler::server::router::tool::Parameters(
            work_radar_lib::mcp::ProposeNoopParams { preview: "demo".into(), note: "n".into() },
        ))
        .await;
    let action_id = res.0.action_id;
    assert!(!action_id.is_empty());

    // DB 반영
    let pending = store::list_pending(&db).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].kind, "noop");
    assert_eq!(pending[0].origin, "mcp:client");

    // status
    let st = server
        .action_status(rmcp::handler::server::router::tool::Parameters(
            work_radar_lib::mcp::ActionIdParams { action_id },
        ))
        .await;
    assert_eq!(st.0.status.as_deref(), Some("awaiting_approval"));
}
```

> ⚠️ 가시성: 이 통합 테스트가 `WrServer`/툴 메서드/param 타입/`store`를 보려면 `pub`이어야 한다. 툴 메서드를 `pub async fn`으로(매크로가 허용하면), param/result 타입 `pub`, `pub mod mcp`/`pub use`. `fresh_db`가 test-only(`#[cfg(test)]`)라 통합 테스트에서 안 보이면, 이 테스트에서 tempdir + `sqlx::migrate!` 로 DB를 직접 만들되 앱 `db.rs`의 마이그레이션 매크로 경로를 재사용. rmcp client 왕복 테스트가 깔끔하면 그쪽을 우선.

- [ ] **Step 2: Run**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --test mcp_roundtrip 2>&1 | tail -10`
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/mcp_roundtrip.rs
git commit -m "test(mcp): headless propose->enqueue->list/status roundtrip (no external calls)"
```

---

## Task 1.5: Registration docs

**Files:**
- Create/Modify: `docs/areas/ipc-conventions.md` 말미 또는 새 `docs/reference/mcp-server.md` 한 섹션.

- [ ] **Step 1: Document how an external agent registers the server**

내용(간결): `work-radar --mcp-stdio`를 외부 에이전트(Claude Code/Codex/Hermes) MCP 설정의 stdio 서버로 등록 → 툴 `wr_list_pending_actions`/`wr_propose_noop`/`wr_action_status` 노출. write 툴은 **제안만** 생성하고 사용자는 work-radar GUI의 승인 패널에서 승인/거절. Hermes ACP의 `governance_mcp_servers_from_env()`(`acp_client.rs`) 패턴처럼 향후 자동 등록 빌더를 추가할 수 있으나 Phase 1은 **수동 등록**으로 시작(YAGNI). 실 write 툴(GitHub/Notion/Gmail/Calendar)은 Phase 2~5에서 커넥터와 함께.

- [ ] **Step 2: Commit**

```bash
git add docs/
git commit -m "docs(mcp): external-agent registration for work-radar --mcp-stdio"
```

---

## Task 1.6: Gate sweep + critic

- [ ] **Step 1: Full gate run**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test 2>&1 | tail -6 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -6 && cargo fmt --check`
Run (repo root): `pnpm typecheck && pnpm lint 2>&1 | tail -3 && pnpm vitest run 2>&1 | tail -3`
Run: `git diff --stat origin/dev -- src/bindings.ts` → **drift 0**(이 Phase는 IPC 무추가).
Expected: 전부 green. cargo test = Phase0(559) + 신규 mcp/trybuild 테스트.

- [ ] **Step 2: critic (opus 별도 컨텍스트)**

`oh-my-claudecode:critic`에 Phase 1 전체 diff + spec §3을 주고 검토: ① write 툴이 정말 `enqueue`만 호출하고 `execute`/`mint` 경로가 없는지(Task 1.0 visibility가 실제로 mcp 모듈의 mint를 컴파일-차단하는지 — trybuild가 그걸 증명하는지), ② `--mcp-stdio`가 stdout을 MCP 전용으로 쓰고 로깅 오염이 없는지, ③ DB 경로가 앱과 동일 resolver인지, ④ MCP read 툴이 토큰/payload 본문을 노출하지 않는지(메타만), ⑤ GUI 부팅 회귀 없는지. **ACCEPT 전엔 done 아님.**

- [ ] **Step 3: (사용자 명시 요청 시에만) push**

---

## Self-Review (이 플랜 ↔ spec §3 + Phase 0 critic)

- **§3 MCP surface(read 툴 + write=enqueue만 + wr_action_status)** → Task 1.1(read) + 1.3(write/status). ✅
- **앱 내장 stdio(별 바이너리 YAGNI)** → Task 1.2 `--mcp-stdio` 플래그 모드. ✅
- **write 툴 = proposal 생성기, execute 경로 없음** → Task 1.0 visibility(`pub(in crate::external_actions)`) + trybuild가 컴파일-차단 증명; mcp 모듈은 `store::enqueue`만. ✅
- **Phase 0 critic Minor #1(토큰 경화)** → Task 1.0. ✅
- **bounded 폴링** → `wr_action_status`는 단건 조회(terminal 도달 시 종료는 클라이언트), 무한 폴링 로직 없음. ✅
- **타입 일관성:** `WrServer`/`store::{enqueue,list_pending,status}`/`ExternalAction::Noop`/`Acceptance::mint` 명칭이 Phase 0과 일치. ✅
- **미정 의존(db resolver 함수명, rmcp 정확한 매크로 시그니처/버전, 바이너리명, fresh_db 가시성)** → 각 스텝에 "실제 코드/docs에서 확인" 가드 명시. ✅

---

## 다음 (Phase 1 land 후)

- **Phase 2~5(GitHub/Notion/Calendar/Gmail 쓰기)**: 각 커넥터 + `ExternalAction` 실 변형 + 실 write 툴(mcp/mod.rs에 추가) + 승인 패널 preview. **2~5는 0/1 위에서 서로 독립 → codex:1 + claude:1 병렬 디스패치 가능.** Phase 2 선결: `executing` crash-orphan reaper + 실패 사유 audit detail + FE `"failed"` 노출(Phase 0 critic/quality follow-up, Phase 0 플랜 §Phase 2에 기록).
- Hermes ACP 자동 등록 빌더(`governance_mcp_servers` 패턴) — 선택적 follow-up.

**Phase 1 quality 리뷰 follow-up(추적):**
- **(Minor) `store::list_pending` LIMIT** — 현재 무제한 `SELECT`. Phase 1엔 사람-게이트 큐라 작아 무해하나, Phase 2~5에서 자동 proposer가 늘면 MCP 단일 응답이 unbounded가 될 수 있음 → `LIMIT`(예: 200) 추가. store.rs(Phase 0 코드) + FE list_pending 동시 영향이라 Phase 2 착수 시 함께.
- **(Minor) trybuild `.stderr` regen** — `tests/compile_fail/mint_outside.stderr`의 E0624 메시지 prose는 rustc 버전에 따라 문구가 바뀔 수 있음(에러 *코드*는 안정). 툴체인 bump 시 빨강은 회귀가 아니라 `TRYBUILD=overwrite`로 재생성 대상 — 그 사실을 테스트 주석/decisions에 남김.
