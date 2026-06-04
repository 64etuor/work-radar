# External Action Gate — Phase 0 (Keystone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 외부 mutation 제안이 흐르는 단일 `external_actions` 게이트 큐 + append-only 감사 + 타입 레벨 `Acceptance` 토큰 + 승인/거절 IPC + 통합 승인 패널을 만든다. 외부 호출은 0 (커넥터는 mock seam).

**Architecture:** 신규 테이블 `external_actions`(제안 큐) + `external_action_audit`(append-only). MCP/codex/hermes 어떤 제안자든 `enqueue_external_action`으로 proposal을 떨군다. 승인 IPC만 `Acceptance` 토큰을 mint하고, 커넥터 `execute(payload, &Acceptance)`는 그 토큰 없이는 호출 불가(컴파일 강제). Phase 0는 mock 커넥터로 라운드트립만 검증 — 실 외부 호출은 Phase 2~5.

**Tech Stack:** Rust(sqlx 0.8 SQLite, tauri 2 + tauri-specta, specta), 기존 `with_retry`/`AppError`/`Db(=SqlitePool)` 인프라, React/TS bindings.

**Spec:** `docs/superpowers/specs/2026-06-04-external-action-gate-mcp-design.md`

**전제(이 레포 규율):**
- cargo는 `src-tauri/`에서, PATH에 `$HOME/.cargo/bin` export. bindings 재생성 = `cargo test`(GUI 불요).
- 새 PK 노출 id는 항상 `i32`(specta i64 금지). `Db`는 `SqlitePool` 별칭(Deref 없음 → `db.inner()`/`&pool`).
- FE 커밋 전 `pnpm exec prettier --write`. 스키마 변경은 마이그레이션으로만.
- 게이트는 `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` + `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` + bindings drift 0.
- **done = critic(opus 별도 패스) ACCEPT.** push는 사용자 명시 요청 시에만.

---

## File Structure

- Create: `src-tauri/migrations/0041_external_actions.sql` — 두 테이블 + 인덱스.
- Create: `src-tauri/src/external_actions/mod.rs` — `ExternalAction` enum, payload 구조체, `Acceptance` 토큰(생성자 private), `ExternalConnector` 트레잇, `ExecOutcome`.
- Create: `src-tauri/src/external_actions/store.rs` — enqueue / list_pending / approve(=mint Acceptance + dispatch) / reject / status + audit 기록. 코어 함수 + 테스트.
- Create: `src-tauri/src/external_actions/audit.rs` — `external_action_audit` writer + reader.
- Create: `src-tauri/src/commands/external_actions.rs` — IPC 래퍼(`#[tauri::command] #[specta::specta]`).
- Modify: `src-tauri/src/lib.rs` — `mod external_actions;` 선언 + `collect_commands!`에 5 커맨드 등록.
- Modify: `src/bindings.ts` — `cargo test`가 재생성(수기 금지).
- Create: `src/components/inbox/PendingActionsPanel.tsx` — 승인/거절 UI(기존 inbox tray 안에 섹션 추가).
- Modify: `src/components/inbox/InboxTray.tsx` — PendingActionsPanel 마운트.
- Create: `src/components/inbox/pendingActions.ts` — 순수 그룹/포맷 헬퍼.
- Create: `src/components/inbox/pendingActions.test.ts` — 순수 헬퍼 vitest.

---

## Task 0.1: Migration — external_actions + external_action_audit

**Files:**
- Create: `src-tauri/migrations/0041_external_actions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Work Radar — schema v41 (External Action Gate Phase 0)
-- 스키마 변경은 새 마이그레이션으로만(임의 ALTER 금지 — INVARIANT).
--
-- 왜: 외부 서비스 쓰기(Notion/GitHub/Gmail/Calendar)를 AI가 '제안'하되 실행은 사용자 승인 후
-- Rust 커넥터만 — 그 단일 초크포인트 큐. external_actions = 제안/승인 상태머신.
-- external_action_audit = append-only 감사(PII/시크릿 금지: service/bytes 등 메타만).
PRAGMA foreign_keys = ON;

CREATE TABLE external_actions (
  id          TEXT PRIMARY KEY,                  -- lower(hex(randomblob(16))) — acceptances 관례
  kind        TEXT NOT NULL,                     -- "github.comment" | "gmail.send" | "notion.update" | ...
  project_ref TEXT,                              -- credential_ref(토큰 격리) — nullable
  payload     TEXT NOT NULL,                     -- 검증된 JSON. PII 가능 → 로컬 SQLite만, 로그 금지
  preview     TEXT,                              -- 사람-친화 요약(승인 패널 표시용) — nullable
  origin      TEXT NOT NULL,                     -- "mcp:<agent>" | "codex:<run_id>" | "hermes:<tab>"
  status      TEXT NOT NULL,                     -- awaiting_approval | executing | succeeded | failed | rejected
  result      TEXT,                              -- 외부 응답 메타(id/크기, 본문 금지) — nullable
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at  TEXT                               -- 승인/거절 시각 — nullable
);

-- 대기 큐 조회 핫패스(오래된 것 먼저 = FIFO 승인).
CREATE INDEX idx_external_actions_status ON external_actions (status, created_at);

CREATE TABLE external_action_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id   TEXT NOT NULL,                     -- external_actions.id (append-only, FK 미강제: 감사 보존)
  event       TEXT NOT NULL,                     -- "enqueued" | "approved" | "executed" | "rejected" | "failed"
  detail      TEXT,                              -- "service=github,bytes=412" — 시크릿/본문 금지
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_external_action_audit_created ON external_action_audit (created_at DESC);
```

- [ ] **Step 2: Verify migration applies**

Run (from `src-tauri/`): `cargo test --lib external_actions 2>&1 | tail -20`
Expected: 컴파일은 아직 실패(모듈 없음) — 다음 태스크에서. 이 스텝은 SQL 문법 sanity만; 0.4에서 `fresh_db()`가 실제 적용 검증.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/migrations/0041_external_actions.sql
git commit -m "feat(external-actions): add gate queue + audit migration (v41)"
```

---

## Task 0.2: Core types — ExternalAction, Acceptance token, ExternalConnector trait

**Files:**
- Create: `src-tauri/src/external_actions/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod external_actions;`)

- [ ] **Step 1: Write the module with types and a unit test for the token boundary**

```rust
//! External Action Gate (Phase 0). 모든 외부 mutation 제안의 단일 초크포인트.
//!
//! INVARIANT #1/#2 기계화: 제안자(MCP/codex/hermes)는 `store::enqueue`로 proposal만 만들고,
//! 실행은 사용자 승인 경로(`store::approve`)가 mint하는 `Acceptance` 토큰을 요구하는
//! `ExternalConnector::execute`에서만 일어난다. 토큰 생성자는 private → 승인 없이 실행 불가.

pub mod audit;
pub mod store;

use serde::{Deserialize, Serialize};
use specta::Type;

/// 외부 액션 종류 + 검증된 payload. 변형 추가 = 새 커넥터 비용 전부.
/// Phase 0는 enum 골격만 — payload 필드는 커넥터 PR(2~5)에서 채운다.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum ExternalAction {
    /// Phase 0 라운드트립/테스트용 no-op. 커넥터 PR에서 실 변형으로 대체/확장.
    Noop { note: String },
}

impl ExternalAction {
    /// DB `kind` 컬럼 문자열(예: "noop", 후속 "github.comment").
    pub fn kind_str(&self) -> &'static str {
        match self {
            ExternalAction::Noop { .. } => "noop",
        }
    }
}

/// 승인 증거 토큰. **생성자 private** — `store::approve`만 mint한다.
/// 커넥터 `execute`가 이 참조를 요구 → 승인 없이 실행 호출이 타입상 불가능.
#[derive(Debug)]
pub struct Acceptance {
    action_id: String,
}

impl Acceptance {
    /// crate-internal mint. 승인 경로(store)에서만 호출. 외부 모듈은 생성 불가.
    pub(crate) fn mint(action_id: String) -> Self {
        Acceptance { action_id }
    }
    pub fn action_id(&self) -> &str {
        &self.action_id
    }
}

/// 외부 응답 메타(본문/시크릿 금지). 커넥터가 반환, store가 result 컬럼/audit에 기록.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutcome {
    /// 외부 리소스 식별자(예: PR 번호, 페이지 id) — 식별자만, 본문 금지.
    pub external_ref: Option<String>,
    /// 감사 detail용 크기 힌트(bytes). PII 아님.
    pub bytes: Option<i64>,
}

/// 커넥터 실행 seam. `_gate: &Acceptance` 인자가 승인 강제(INVARIANT #2).
/// Phase 0는 구현체 없이 트레잇만 — `MockConnector`(test)와 Phase 2~5 실 커넥터가 impl.
#[allow(async_fn_in_trait)]
pub trait ExternalConnector {
    async fn execute(
        &self,
        action: &ExternalAction,
        _gate: &crate::external_actions::Acceptance,
    ) -> Result<ExecOutcome, crate::error::AppError>;
}

#[cfg(test)]
mod token_tests {
    use super::*;

    #[test]
    fn acceptance_carries_action_id() {
        let a = Acceptance::mint("abc".into());
        assert_eq!(a.action_id(), "abc");
    }

    #[test]
    fn external_action_kind_str_is_stable() {
        let a = ExternalAction::Noop { note: "x".into() };
        assert_eq!(a.kind_str(), "noop");
    }
}
```

- [ ] **Step 2: Declare the module in lib.rs**

`src-tauri/src/lib.rs`에서 다른 `mod` 선언들 근처에 추가:

```rust
mod external_actions;
```

- [ ] **Step 3: Run the token tests**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --lib external_actions::token_tests 2>&1 | tail -15`
Expected: 2 passed. (store/audit는 아직 stub이라 `pub mod`가 빈 파일이면 컴파일 에러 — Step 4에서 stub 생성 후 재실행.)

- [ ] **Step 4: Create empty stub files so the module compiles**

`src-tauri/src/external_actions/audit.rs`와 `store.rs`를 빈 파일로 생성(다음 태스크에서 채움). 재실행 → 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/external_actions/ src-tauri/src/lib.rs
git commit -m "feat(external-actions): core types + Acceptance token boundary"
```

---

## Task 0.3: Audit writer — external_action_audit

**Files:**
- Modify: `src-tauri/src/external_actions/audit.rs`

- [ ] **Step 1: Write the failing test**

```rust
//! external_action_audit: append-only 감사. detail은 비밀-free(service/bytes만).

use crate::db::Db;
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ActionAuditEntry {
    pub id: i32, // specta i64 금지 — i32 매핑(레포 관례)
    pub action_id: String,
    pub event: String,
    pub detail: Option<String>,
    pub created_at: String,
}

pub(crate) async fn audit(
    pool: &Db,
    action_id: &str,
    event: &str,
    detail: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO external_action_audit (action_id, event, detail) VALUES (?, ?, ?)",
    )
    .bind(action_id)
    .bind(event)
    .bind(detail)
    .execute(pool)
    .await?;
    Ok(())
}

pub(crate) async fn list_audit_core(pool: &Db) -> Result<Vec<ActionAuditEntry>, AppError> {
    let rows = sqlx::query_as::<_, ActionAuditEntry>(
        "SELECT id, action_id, event, detail, created_at \
         FROM external_action_audit ORDER BY created_at DESC, id DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn audit_appends_and_lists_newest_first() {
        let pool = fresh_db().await;
        audit(&pool, "act1", "enqueued", Some("service=github")).await.unwrap();
        audit(&pool, "act1", "approved", None).await.unwrap();
        let rows = list_audit_core(&pool).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].event, "approved"); // newest first
        assert_eq!(rows[1].event, "enqueued");
    }
}
```

- [ ] **Step 2: Run test to verify it fails then passes**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --lib external_actions::audit 2>&1 | tail -15`
Expected: 처음엔 빈 stub이라 컴파일 후 1 passed. (`fresh_db()`가 0041 마이그레이션 적용을 실증.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/external_actions/audit.rs
git commit -m "feat(external-actions): append-only audit writer + reader"
```

---

## Task 0.4: Store — enqueue + list_pending

**Files:**
- Modify: `src-tauri/src/external_actions/store.rs`

- [ ] **Step 1: Write enqueue + list_pending with a failing test**

```rust
//! external_actions 상태머신. 제안자→enqueue(awaiting_approval), 사용자→approve/reject.
//! approve만 Acceptance를 mint하고 커넥터에 dispatch한다(INVARIANT #2).

use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::{audit, Acceptance, ExternalAction};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub id: String,
    pub kind: String,
    pub project_ref: Option<String>,
    pub preview: Option<String>,
    pub origin: String,
    pub status: String,
    pub created_at: String,
}

/// 제안 1건을 awaiting_approval로 enqueue. payload는 검증된 JSON 문자열(호출자 책임).
/// 반환=새 action id. enqueued 감사 기록.
pub(crate) async fn enqueue(
    pool: &Db,
    action: &ExternalAction,
    project_ref: Option<&str>,
    preview: Option<&str>,
    origin: &str,
) -> Result<String, AppError> {
    let payload = serde_json::to_string(action).map_err(AppError::from)?;
    let id: String = sqlx::query_scalar(
        "INSERT INTO external_actions (id, kind, project_ref, payload, preview, origin, status) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, 'awaiting_approval') \
         RETURNING id",
    )
    .bind(action.kind_str())
    .bind(project_ref)
    .bind(payload)
    .bind(preview)
    .bind(origin)
    .fetch_one(pool)
    .await?;
    audit::audit(pool, &id, "enqueued", Some(action.kind_str())).await?;
    Ok(id)
}

/// 승인 대기 큐(오래된 것 먼저 = FIFO). payload/result는 노출 안 함(메타만).
pub(crate) async fn list_pending(pool: &Db) -> Result<Vec<PendingAction>, AppError> {
    let rows = sqlx::query_as::<_, PendingAction>(
        "SELECT id, kind, project_ref, preview, origin, status, created_at \
         FROM external_actions WHERE status = 'awaiting_approval' ORDER BY created_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;

    #[tokio::test]
    async fn enqueue_then_list_pending() {
        let pool = fresh_db().await;
        let action = ExternalAction::Noop { note: "hello".into() };
        let id = enqueue(&pool, &action, Some("proj1"), Some("noop hello"), "mcp:test")
            .await
            .unwrap();
        let pending = list_pending(&pool).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, id);
        assert_eq!(pending[0].kind, "noop");
        assert_eq!(pending[0].origin, "mcp:test");
        // 감사에 enqueued 1건
        let aud = audit::list_audit_core(&pool).await.unwrap();
        assert_eq!(aud.len(), 1);
        assert_eq!(aud[0].event, "enqueued");
    }
}
```

- [ ] **Step 2: Run the test**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --lib external_actions::store 2>&1 | tail -15`
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/external_actions/store.rs
git commit -m "feat(external-actions): enqueue proposal + list pending queue"
```

---

## Task 0.5: Store — approve (mint Acceptance + dispatch) + reject

**Files:**
- Modify: `src-tauri/src/external_actions/store.rs`

- [ ] **Step 1: Add approve/reject + a MockConnector test**

`store.rs`에 추가(기존 `use` 아래, tests 위):

```rust
use crate::external_actions::{ExecOutcome, ExternalConnector};

/// 승인: awaiting_approval → executing(CAS 가드) → 커넥터 dispatch → succeeded|failed.
/// **Acceptance는 여기서만 mint** — 커넥터 execute에 전달. 모든 전이를 감사.
/// 반환=실행 결과 status 문자열("succeeded"|"failed"). CAS 실패(이미 결정됨) 시 검증 에러.
pub(crate) async fn approve<C: ExternalConnector>(
    pool: &Db,
    action_id: &str,
    connector: &C,
) -> Result<String, AppError> {
    // CAS: awaiting_approval에서만 executing으로. 0행이면 이미 결정된 액션 → 가드.
    let moved = sqlx::query(
        "UPDATE external_actions SET status = 'executing', decided_at = datetime('now') \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(action_id)
    .execute(pool)
    .await?
    .rows_affected();
    if moved == 0 {
        return Err(AppError::validation("승인 대기 상태가 아닌 액션입니다"));
    }
    audit::audit(pool, action_id, "approved", None).await?;

    // payload 역직렬화 → 커넥터 실행(여기서 Acceptance mint).
    let payload: String =
        sqlx::query_scalar("SELECT payload FROM external_actions WHERE id = ?1")
            .bind(action_id)
            .fetch_one(pool)
            .await?;
    let action: ExternalAction = serde_json::from_str(&payload).map_err(AppError::from)?;
    let gate = Acceptance::mint(action_id.to_string());

    match connector.execute(&action, &gate).await {
        Ok(outcome) => {
            let result = serde_json::to_string(&outcome).ok();
            sqlx::query(
                "UPDATE external_actions SET status = 'succeeded', result = ?2 WHERE id = ?1",
            )
            .bind(action_id)
            .bind(result)
            .execute(pool)
            .await?;
            let detail = outcome
                .bytes
                .map(|b| format!("bytes={b}"))
                .unwrap_or_default();
            audit::audit(pool, action_id, "executed", Some(&detail)).await?;
            Ok("succeeded".into())
        }
        Err(e) => {
            sqlx::query("UPDATE external_actions SET status = 'failed' WHERE id = ?1")
                .bind(action_id)
                .execute(pool)
                .await?;
            audit::audit(pool, action_id, "failed", None).await?;
            // 실패는 액션 상태로 surface하되 호출 자체는 Ok(상태머신 진행). 에러는 audit로.
            let _ = e;
            Ok("failed".into())
        }
    }
}

/// 거절: awaiting_approval → rejected(CAS). 외부 무변경. 0행이면 가드 에러.
pub(crate) async fn reject(pool: &Db, action_id: &str) -> Result<(), AppError> {
    let moved = sqlx::query(
        "UPDATE external_actions SET status = 'rejected', decided_at = datetime('now') \
         WHERE id = ?1 AND status = 'awaiting_approval'",
    )
    .bind(action_id)
    .execute(pool)
    .await?
    .rows_affected();
    if moved == 0 {
        return Err(AppError::validation("승인 대기 상태가 아닌 액션입니다"));
    }
    audit::audit(pool, action_id, "rejected", None).await?;
    Ok(())
}

/// 단건 상태 폴링(MCP wr_action_status용). 없으면 None.
pub(crate) async fn status(pool: &Db, action_id: &str) -> Result<Option<String>, AppError> {
    let s: Option<String> =
        sqlx::query_scalar("SELECT status FROM external_actions WHERE id = ?1")
            .bind(action_id)
            .fetch_optional(pool)
            .await?;
    Ok(s)
}
```

테스트 모듈에 MockConnector + 케이스 추가:

```rust
    struct MockConnector {
        outcome: ExecOutcome,
    }
    impl ExternalConnector for MockConnector {
        async fn execute(
            &self,
            _action: &ExternalAction,
            _gate: &Acceptance,
        ) -> Result<ExecOutcome, AppError> {
            Ok(self.outcome.clone())
        }
    }

    #[tokio::test]
    async fn approve_dispatches_and_records_audit() {
        let pool = fresh_db().await;
        let id = enqueue(&pool, &ExternalAction::Noop { note: "x".into() }, None, None, "mcp:t")
            .await
            .unwrap();
        let conn = MockConnector { outcome: ExecOutcome { external_ref: Some("pr/1".into()), bytes: Some(12) } };
        let res = approve(&pool, &id, &conn).await.unwrap();
        assert_eq!(res, "succeeded");
        assert_eq!(status(&pool, &id).await.unwrap().as_deref(), Some("succeeded"));
        // 더 이상 대기 큐에 없음
        assert!(list_pending(&pool).await.unwrap().is_empty());
        // 감사: enqueued, approved, executed
        let events: Vec<String> =
            audit::list_audit_core(&pool).await.unwrap().into_iter().map(|a| a.event).collect();
        assert!(events.contains(&"executed".to_string()));
        assert!(events.contains(&"approved".to_string()));
    }

    #[tokio::test]
    async fn double_approve_is_guarded() {
        let pool = fresh_db().await;
        let id = enqueue(&pool, &ExternalAction::Noop { note: "x".into() }, None, None, "mcp:t")
            .await
            .unwrap();
        let conn = MockConnector { outcome: ExecOutcome::default() };
        approve(&pool, &id, &conn).await.unwrap();
        // 두 번째 승인은 CAS 가드로 거부
        assert!(approve(&pool, &id, &conn).await.is_err());
    }

    #[tokio::test]
    async fn reject_marks_rejected_no_dispatch() {
        let pool = fresh_db().await;
        let id = enqueue(&pool, &ExternalAction::Noop { note: "x".into() }, None, None, "mcp:t")
            .await
            .unwrap();
        reject(&pool, &id).await.unwrap();
        assert_eq!(status(&pool, &id).await.unwrap().as_deref(), Some("rejected"));
        assert!(approve(&pool, &id, &MockConnector { outcome: ExecOutcome::default() }).await.is_err());
    }
```

> 참고: `AppError::validation(...)`이 없으면 기존 envelope의 검증-에러 생성자명을 확인해 맞춘다(예: `AppError::Validation` 또는 `bad_request`). `git grep "AppError::" src-tauri/src/error.rs`로 정확한 생성자 확인 후 사용.

- [ ] **Step 2: Run the store tests**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --lib external_actions::store 2>&1 | tail -20`
Expected: 4 passed (enqueue_then_list_pending, approve_dispatches_and_records_audit, double_approve_is_guarded, reject_marks_rejected_no_dispatch).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/external_actions/store.rs
git commit -m "feat(external-actions): approve(mint Acceptance+dispatch)/reject/status + CAS guards"
```

---

## Task 0.6: IPC commands + register

**Files:**
- Create: `src-tauri/src/commands/external_actions.rs`
- Modify: `src-tauri/src/lib.rs` (commands 모듈 등록 + `collect_commands!`)

> Phase 0의 `approve_external_action` IPC는 아직 실 커넥터가 없으므로 **mock no-op 커넥터**로 dispatch한다(외부 호출 0). Phase 2~5에서 kind→실 커넥터 라우팅으로 교체.

- [ ] **Step 1: Write the IPC wrappers**

```rust
//! External Action Gate IPC. 승인/거절/조회. Phase 0는 NoopConnector로 dispatch(외부 호출 0).

use crate::db::Db;
use crate::error::AppError;
use crate::external_actions::store::{self, PendingAction};
use crate::external_actions::{Acceptance, ExecOutcome, ExternalAction, ExternalConnector};
use tauri::State;

/// Phase 0 placeholder 커넥터 — 아무것도 안 함. Phase 2~5에서 kind별 실 커넥터로 교체.
struct NoopConnector;
impl ExternalConnector for NoopConnector {
    async fn execute(
        &self,
        _action: &ExternalAction,
        _gate: &Acceptance,
    ) -> Result<ExecOutcome, AppError> {
        Ok(ExecOutcome::default())
    }
}

#[tauri::command]
#[specta::specta]
pub async fn list_pending_actions(db: State<'_, Db>) -> Result<Vec<PendingAction>, AppError> {
    store::list_pending(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn approve_external_action(
    db: State<'_, Db>,
    action_id: String,
) -> Result<String, AppError> {
    store::approve(db.inner(), &action_id, &NoopConnector).await
}

#[tauri::command]
#[specta::specta]
pub async fn reject_external_action(
    db: State<'_, Db>,
    action_id: String,
) -> Result<(), AppError> {
    store::reject(db.inner(), &action_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn external_action_status(
    db: State<'_, Db>,
    action_id: String,
) -> Result<Option<String>, AppError> {
    store::status(db.inner(), &action_id).await
}
```

> `enqueue_external_action`은 Phase 0에선 **IPC로 노출하지 않는다**(제안자는 Phase 1 MCP 서버). 대신 store::enqueue를 pub(crate)로 유지 → Phase 1이 직접 호출. (YAGNI: FE에서 수기 enqueue 불요.)

- [ ] **Step 2: Register module + commands in lib.rs**

`src-tauri/src/commands/mod.rs`(또는 commands 선언 위치)에 `pub mod external_actions;` 추가. `lib.rs`의 `collect_commands![...]`에 4개 추가:

```rust
        commands::external_actions::list_pending_actions,
        commands::external_actions::approve_external_action,
        commands::external_actions::reject_external_action,
        commands::external_actions::external_action_status,
```

- [ ] **Step 3: Regenerate bindings + verify**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test 2>&1 | tail -25`
Expected: 전체 통과 + `src/bindings.ts`에 4 커맨드 추가됨.
Run: `git diff --stat src/bindings.ts` → external_actions 커맨드/타입만 가산(drift=신규만).

- [ ] **Step 4: Clippy + fmt**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo clippy --all-targets -- -D warnings 2>&1 | tail -10 && cargo fmt --check`
Expected: 0 warnings, fmt clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/external_actions.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/bindings.ts
git commit -m "feat(external-actions): IPC commands (list/approve/reject/status) + bindings"
```

---

## Task 0.7: FE — pure helpers (TDD first)

**Files:**
- Create: `src/components/inbox/pendingActions.ts`
- Create: `src/components/inbox/pendingActions.test.ts`

- [ ] **Step 1: Write the failing vitest**

```ts
import { describe, expect, it } from "vitest";
import { groupPendingByOrigin, formatActionKind } from "./pendingActions";
import type { PendingAction } from "../../bindings";

const mk = (over: Partial<PendingAction>): PendingAction => ({
  id: "1", kind: "noop", projectRef: null, preview: null,
  origin: "mcp:claude", status: "awaiting_approval", createdAt: "2026-06-04", ...over,
});

describe("pendingActions", () => {
  it("groups by origin agent", () => {
    const groups = groupPendingByOrigin([
      mk({ id: "a", origin: "mcp:claude" }),
      mk({ id: "b", origin: "mcp:codex" }),
      mk({ id: "c", origin: "mcp:claude" }),
    ]);
    expect(groups.get("mcp:claude")?.length).toBe(2);
    expect(groups.get("mcp:codex")?.length).toBe(1);
  });

  it("formats action kind for display", () => {
    expect(formatActionKind("github.comment")).toBe("GitHub · comment");
    expect(formatActionKind("noop")).toBe("noop");
  });
});
```

- [ ] **Step 2: Implement the helpers**

```ts
import type { PendingAction } from "../../bindings";

/** origin(에이전트)별로 대기 액션을 그룹핑. 표시 순서 보존(Map). */
export function groupPendingByOrigin(
  actions: PendingAction[],
): Map<string, PendingAction[]> {
  const out = new Map<string, PendingAction[]>();
  for (const a of actions) {
    const list = out.get(a.origin) ?? [];
    list.push(a);
    out.set(a.origin, list);
  }
  return out;
}

/** "github.comment" → "GitHub · comment". 점 없는 kind는 그대로. */
export function formatActionKind(kind: string): string {
  const [service, ...rest] = kind.split(".");
  if (rest.length === 0) return kind;
  const label: Record<string, string> = {
    github: "GitHub", notion: "Notion", gmail: "Gmail", calendar: "Calendar",
  };
  return `${label[service] ?? service} · ${rest.join(".")}`;
}
```

- [ ] **Step 3: Run vitest**

Run: `pnpm vitest run src/components/inbox/pendingActions.test.ts 2>&1 | tail -15`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/components/inbox/pendingActions.ts src/components/inbox/pendingActions.test.ts
git add src/components/inbox/pendingActions.ts src/components/inbox/pendingActions.test.ts
git commit -m "feat(inbox): pure helpers for pending external actions"
```

---

## Task 0.8: FE — PendingActionsPanel + inbox mount

**Files:**
- Create: `src/components/inbox/PendingActionsPanel.tsx`
- Modify: `src/components/inbox/InboxTray.tsx`

- [ ] **Step 1: Write the panel**

기존 inbox tray 패턴(shadcn, lucide, bindings commands)을 따른다. `commands.listPendingActions()`로 로드, 승인/거절 버튼이 `commands.approveExternalAction(id)`/`commands.rejectExternalAction(id)` 호출 후 무효화(재조회). `formatActionKind`/`groupPendingByOrigin` 사용. preview를 본문으로 표시. 새 surface를 만들지 말고 InboxTray 안 섹션으로.

```tsx
import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { commands, type PendingAction } from "../../bindings";
import { Button } from "../ui/button";
import { formatActionKind, groupPendingByOrigin } from "./pendingActions";

export function PendingActionsPanel() {
  const [actions, setActions] = useState<PendingAction[]>([]);
  const load = useCallback(async () => {
    const res = await commands.listPendingActions();
    if (res.status === "ok") setActions(res.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (id: string, approve: boolean) => {
      const res = approve
        ? await commands.approveExternalAction(id)
        : await commands.rejectExternalAction(id);
      if (res.status === "ok") await load();
    },
    [load],
  );

  if (actions.length === 0) return null;
  const groups = [...groupPendingByOrigin(actions).entries()];

  return (
    <section aria-label="승인 대기 외부 액션" className="flex flex-col gap-3">
      {groups.map(([origin, items]) => (
        <div key={origin} className="flex flex-col gap-2">
          <p className="text-muted-foreground typo-label-sm">{origin}</p>
          {items.map((a) => (
            <div
              key={a.id}
              className="flex items-start justify-between gap-2 rounded-md border border-border p-2"
            >
              <div className="min-w-0">
                <p className="typo-title-sm">{formatActionKind(a.kind)}</p>
                {a.preview ? (
                  <p className="text-muted-foreground typo-body-sm truncate">{a.preview}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="icon" variant="ghost" aria-label="승인" onClick={() => void decide(a.id, true)}>
                  <Check className="size-4" />
                </Button>
                <Button size="icon" variant="ghost" aria-label="거절" onClick={() => void decide(a.id, false)}>
                  <X className="size-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
```

> 주의: 실제 `commands.*` 반환 형태(`{status:"ok"|"error", data}`)·`Button`/typo 유틸 클래스명은 기존 컴포넌트에서 확인해 맞춘다(`git grep "commands\." src/components/inbox`). typo-* 유틸은 [[typo tokens]] 관례.

- [ ] **Step 2: Mount in InboxTray**

`InboxTray.tsx`에서 기존 섹션들과 함께 `<PendingActionsPanel />`를 렌더(맨 위, 승인 대기가 가장 시급하므로). import 추가.

- [ ] **Step 3: typecheck + lint + build**

Run: `pnpm typecheck 2>&1 | tail -10 && pnpm lint 2>&1 | tail -10`
Expected: typecheck 0 error, lint 0 error(기존 baseline 경고만).

- [ ] **Step 4: Commit**

```bash
pnpm exec prettier --write src/components/inbox/PendingActionsPanel.tsx src/components/inbox/InboxTray.tsx
git add src/components/inbox/PendingActionsPanel.tsx src/components/inbox/InboxTray.tsx
git commit -m "feat(inbox): pending external actions approval panel"
```

---

## Task 0.9: Gate sweep + critic

- [ ] **Step 1: Full gate run**

Run (from `src-tauri/`): `export PATH="$HOME/.cargo/bin:$PATH"; cargo test 2>&1 | tail -5 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -5 && cargo fmt --check`
Run (repo root): `pnpm typecheck && pnpm lint 2>&1 | tail -5 && pnpm vitest run 2>&1 | tail -5`
Run: `git diff --stat origin/dev -- src/bindings.ts` → 신규 커맨드/타입만(가산 drift).
Expected: 전부 green.

- [ ] **Step 2: critic pass (opus, 별도 컨텍스트)**

`oh-my-claudecode:critic` 에이전트에 Phase 0 전체 diff + spec을 주고 INVARIANT #1/#2 침범 여부, Acceptance 토큰 경계 우회 가능성, audit PII 누출, CAS 레이스를 검토받는다. **ACCEPT 전엔 done 아님.** MAJOR 있으면 수정 후 재패스.

- [ ] **Step 3: (사용자 명시 요청 시에만) push**

```bash
git push origin feat/external-action-gate-mcp
git ls-remote origin refs/heads/feat/external-action-gate-mcp  # 와이어 검증
```

---

## Self-Review (이 플랜 ↔ spec)

- **§1 아키텍처(초크포인트/타입 토큰)** → Task 0.2(Acceptance private mint) + 0.5(approve만 mint+dispatch). ✅
- **§2 데이터 모델(2 테이블, enum, 트레잇, Acceptance)** → Task 0.1 + 0.2. ✅
- **§3 MCP surface** → Phase 1(별도 플랜). Phase 0는 store::enqueue를 pub(crate)로 남겨 Phase 1 진입점 확보. ✅
- **§4 페이징** → 이 플랜=Phase 0; 1~5는 아래 후속. ✅
- **§5 INVARIANT/테스트** → 0.5(가드/디스패치 테스트) + 0.3(audit) + 0.9(critic). 토큰=keychain·외부호출=Rust는 Phase 0에 외부호출이 없어 N/A, Phase 2~5에서 검증. ✅
- 타입 일관성: `ExternalAction`/`Acceptance`/`ExecOutcome`/`PendingAction`/`approve/reject/status/enqueue` 명칭이 태스크 간 일치. ✅
- 미정 의존(`AppError::validation` 생성자명, `commands.*` 반환 형태, `Button`/typo 클래스)은 해당 스텝에 "기존서 확인" 가드 명시. ✅

---

## Subsequent Plans (Phase 0 land 후 작성)

각 Phase = 별도 플랜 + 별도 PR. **2~5는 0/1 위에서 서로 독립 → codex:1 + claude:1 병렬 디스패치(워크트리 격리).**

- **Phase 1 — MCP 서버(proposal-only).** 앱 내장 stdio MCP, read 툴 + write 툴(`store::enqueue` 호출만), `wr_action_status`. NoopConnector 라우팅을 kind별 디스패치 테이블로 교체할 준비(아직 mock). 헤드리스 MCP 라운드트립 테스트.
- **Phase 2 — GitHub WRITE.** `github.rs`에 create_comment/issue/pr(bounded retry, keychain) + `GithubConnector` impl + `ExternalAction::Github*` 변형 + MCP 툴 3 + preview 렌더.
- **Phase 3 — Notion WRITE 확장.** 속성/코멘트/페이지 생성 + `NotionConnector` + 변형 + 툴 + preview.
- **Phase 4 — Calendar WRITE(AI 제안).** AI-origin=external_actions / human-form=기존 `pending_calendar_writes`(이중 게이트 금지). `CalendarConnector` + 변형 + 툴.
- **Phase 5 — Gmail 신규.** `TokenKind::Gmail` + OAuth(calendar/oauth.rs 재사용) + read/send 커넥터(send=gated) + 변형 + 툴. 최소 scope opt-in.
