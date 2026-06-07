# Hermes 다중 세션 + 영구 기억 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hermes 세션을 영구 저장(SQLite)하고, "1/2/3" 순번 명명·3개 하드캡을 없애고, 좌측 세션 사이드바 + 재시작 후 복원/재개를 갖춘 현대 에이전트 관리 UX로 만든다.

**Architecture:** Rust에 `hermes_session`/`hermes_message` 테이블 + sqlx 스토어 + tauri-specta IPC 커맨드를 추가한다(외부/DB I/O는 전부 Rust). 프런트는 기존 floating `HermesPanel`을 `[Sidebar | ChatPane]` 2-컬럼으로 바꾸고, 기존 zustand reducer를 재사용하되 세션 목록·메시지를 DB와 동기화한다. 재개는 "히스토리 즉시 복원 + 다음 전송 시 최근 N개 메시지 replay"로 구현(에이전트 내부 메모리 복원에 의존하지 않음).

**Tech Stack:** Rust(Tauri 2, sqlx 0.8, specta/tauri-specta, tokio), TypeScript/React(zustand, @tanstack/react-query, shadcn/ui, lucide), SQLite.

**Spec:** `docs/superpowers/specs/2026-06-08-hermes-multi-session-persistence-design.md`

---

## Conventions for every task

- **cargo PATH:** Rust/commit 전 항상 `export PATH="$HOME/.cargo/bin:$PATH"` (husky pre-commit이 cargo fmt 실행).
- **cargo cwd:** cargo 명령은 `src-tauri/`에서 실행.
- **bindings 재생성:** Rust 커맨드/타입을 바꾸면 `cd src-tauri && cargo test` 가 `src/bindings.ts`를 재생성한다. 이후 `git diff --exit-code src/bindings.ts`로 drift 0 확인(drift = CI 게이트).
- **DB 테스트 격리:** 새 Rust DB 테스트는 timeline_notes.rs의 `fresh_db()` 패턴(AtomicU64 + nanos temp dir + `crate::db::init_db`)을 복사한다.
- **FE 커밋 전:** `pnpm exec prettier --write <touched files>` (husky가 `--no-verify` 시 우회되므로 손으로 먼저).
- **푸시 금지:** 커밋만. push는 사용자가 명시 요청할 때만(메모리 규율).
- **검증 정본:** `docs/reference/commands.md`. 표준 게이트 = Rust `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`; FE `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`.

---

## File Structure

**Create:**

- `src-tauri/migrations/0043_hermes_sessions.sql` — 세션/메시지 테이블 (additive).
- `src-tauri/src/hermes_agent/session_store.rs` — sqlx CRUD `*_inner(&Db,...)` 헬퍼 + IPC 커맨드 + 단위 테스트.
- `src/components/hermes/HermesSidebar.tsx` — 세션 목록·검색·상태·rename·삭제/보관·+새 세션.
- `src/components/hermes/sessionList.ts` — 순수 헬퍼(검색 필터·자동 제목·미리보기·정렬) + 단위 테스트 대상.
- `src/components/hermes/sessionList.test.ts` — sessionList 순수 로직 테스트.

**Modify:**

- `src-tauri/src/hermes_agent/mod.rs` — `pub mod session_store;`.
- `src-tauri/src/commands/hermes_agent.rs` — `HERMES_TAB_CAP`/`hermes_agent_cap` 제거, `hermes_agent_send`에 replay preamble.
- `src-tauri/src/lib.rs:55` `collect_commands![...]` — 새 커맨드 등록, `hermes_agent_cap` 제거.
- `src/components/hermes/types.ts` / `useHermesTabs.ts` — `cap` 제거, 자동 제목 헬퍼.
- `src/components/hermes/useHermesTabsStore.ts` — 세션 목록 DB 동기화 + 메시지 영속/복원.
- `src/components/hermes/HermesPanel.tsx` — 2-컬럼 레이아웃, 기본 폭 확대.
- `src/components/HermesView.tsx` — 사이드바 배선.
- `src/bindings.ts` — 자동 재생성(수기 금지).

---

## Task 1: 데이터 계층 — 마이그레이션 + 스토어 + CRUD 커맨드 (UI 미연결)

**Files:**

- Create: `src-tauri/migrations/0043_hermes_sessions.sql`
- Create: `src-tauri/src/hermes_agent/session_store.rs`
- Modify: `src-tauri/src/hermes_agent/mod.rs`
- Modify: `src-tauri/src/lib.rs` (collect_commands)

- [ ] **Step 1: 마이그레이션 파일 작성**

Create `src-tauri/migrations/0043_hermes_sessions.sql`:

```sql
-- Hermes 세션 + 메시지 영속화 (additive; 기존 테이블 무변경).
CREATE TABLE hermes_session (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'idle',
  cwd            TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE hermes_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES hermes_session(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  tool_json   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_hermes_message_session ON hermes_message(session_id, seq);
```

- [ ] **Step 2: `mod.rs`에 모듈 등록**

In `src-tauri/src/hermes_agent/mod.rs`, add (alongside existing `pub mod acp_client;` etc.):

```rust
pub mod session_store;
```

- [ ] **Step 3: 스토어 스켈레톤 + 행 타입 작성**

Create `src-tauri/src/hermes_agent/session_store.rs`. 행 타입은 specta `Type` + sqlx `FromRow`. IPC로 넘기는 정수는 i32(specta i64 금지).

```rust
//! hermes_session / hermes_message 데이터 접근 + IPC 커맨드.
//! 패턴: `*_inner(&Db, ...)` 헬퍼에 SQL을 모으고 `#[tauri::command]`는 State<Db>만 풀어 위임
//! (timeline_notes.rs 선례). 외부 mutate 없음 → Acceptance 게이트 불요(로컬 액션).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::db::Db;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
pub struct HermesSessionRow {
    pub id: String,
    pub name: String,
    pub status: String,
    pub cwd: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_active_at: String,
    pub archived: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
pub struct HermesMessageRow {
    /// i64 → i32로 좁혀 IPC 노출(specta i64 금지). 실사용에서 메시지 id가 2^31을 넘지 않음.
    #[sqlx(try_from = "i64")]
    pub id: i32,
    pub session_id: String,
    #[sqlx(try_from = "i64")]
    pub seq: i32,
    pub role: String,
    pub content: String,
    pub tool_json: Option<String>,
    pub created_at: String,
}
```

- [ ] **Step 4: list/create inner 테스트 작성 (failing)**

Append to `session_store.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock before unix epoch")
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("wr-hermes-{nanos}-{seq}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        crate::db::init_db(&dir.join("t.db")).await.expect("init db")
    }

    #[tokio::test]
    async fn create_then_list_roundtrip() {
        let db = fresh_db().await;
        let row = create_inner(&db, "sess-1", "첫 세션").await.expect("create");
        assert_eq!(row.id, "sess-1");
        assert_eq!(row.name, "첫 세션");
        assert_eq!(row.archived, 0);

        let list = list_inner(&db).await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "sess-1");
    }
}
```

- [ ] **Step 5: 테스트 실패 확인**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar session_store 2>&1 | tail -20`
Expected: FAIL — `create_inner`/`list_inner` not found.

- [ ] **Step 6: create/list inner 구현**

Add to `session_store.rs` (before `#[cfg(test)]`):

```rust
pub(crate) async fn create_inner(
    db: &Db,
    id: &str,
    name: &str,
) -> Result<HermesSessionRow, sqlx::Error> {
    sqlx::query("INSERT INTO hermes_session (id, name) VALUES (?1, ?2)")
        .bind(id)
        .bind(name)
        .execute(db)
        .await?;
    get_inner(db, id).await.map(|o| o.expect("just inserted"))
}

pub(crate) async fn get_inner(
    db: &Db,
    id: &str,
) -> Result<Option<HermesSessionRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, name, status, cwd, created_at, updated_at, last_active_at, archived \
         FROM hermes_session WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(db)
    .await
}

pub(crate) async fn list_inner(db: &Db) -> Result<Vec<HermesSessionRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, name, status, cwd, created_at, updated_at, last_active_at, archived \
         FROM hermes_session WHERE archived = 0 ORDER BY last_active_at DESC",
    )
    .fetch_all(db)
    .await
}
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar session_store 2>&1 | tail -20`
Expected: PASS (`create_then_list_roundtrip`).

- [ ] **Step 8: rename/archive/delete + 메시지 append/list 테스트 작성 (failing)**

Add tests to the `mod tests` block:

```rust
    #[tokio::test]
    async fn rename_archive_hide_from_list() {
        let db = fresh_db().await;
        create_inner(&db, "s1", "a").await.expect("create");
        rename_inner(&db, "s1", "b").await.expect("rename");
        assert_eq!(get_inner(&db, "s1").await.expect("get").expect("row").name, "b");

        archive_inner(&db, "s1").await.expect("archive");
        assert_eq!(list_inner(&db).await.expect("list").len(), 0);
    }

    #[tokio::test]
    async fn append_messages_increment_seq_and_cascade_delete() {
        let db = fresh_db().await;
        create_inner(&db, "s1", "a").await.expect("create");
        let seq0 = append_inner(&db, "s1", "user", "hi", None).await.expect("a0");
        let seq1 = append_inner(&db, "s1", "assistant", "yo", None).await.expect("a1");
        assert_eq!(seq0, 0);
        assert_eq!(seq1, 1);

        let msgs = messages_inner(&db, "s1").await.expect("messages");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[1].seq, 1);

        delete_inner(&db, "s1").await.expect("delete");
        assert!(get_inner(&db, "s1").await.expect("get").is_none());
        assert_eq!(messages_inner(&db, "s1").await.expect("messages").len(), 0);
    }
```

- [ ] **Step 9: 테스트 실패 확인**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar session_store 2>&1 | tail -20`
Expected: FAIL — `rename_inner`/`archive_inner`/`delete_inner`/`append_inner`/`messages_inner` not found.

- [ ] **Step 10: rename/archive/delete + append/messages inner 구현**

Add to `session_store.rs`. `append_inner`는 단일 트랜잭션에서 seq를 계산해 동시 append race를 피한다(CASCADE는 FK; SQLite는 `PRAGMA foreign_keys=ON`이 init_db에 설정되어 있어야 한다 — Step 11에서 확인).

```rust
pub(crate) async fn rename_inner(db: &Db, id: &str, name: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE hermes_session SET name = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .bind(name)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn archive_inner(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE hermes_session SET archived = 1, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub(crate) async fn delete_inner(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM hermes_session WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// 메시지 1개 append. seq = 해당 세션 현재 max(seq)+1 (없으면 0). last_active_at/updated_at 갱신.
/// 반환 = 부여된 seq (i32).
pub(crate) async fn append_inner(
    db: &Db,
    session_id: &str,
    role: &str,
    content: &str,
    tool_json: Option<&str>,
) -> Result<i32, sqlx::Error> {
    let mut tx = db.begin().await?;
    let next_seq: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq) + 1, 0) FROM hermes_message WHERE session_id = ?1",
    )
    .bind(session_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO hermes_message (session_id, seq, role, content, tool_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(session_id)
    .bind(next_seq)
    .bind(role)
    .bind(content)
    .bind(tool_json)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE hermes_session SET updated_at = datetime('now'), \
         last_active_at = datetime('now') WHERE id = ?1",
    )
    .bind(session_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(next_seq as i32)
}

pub(crate) async fn messages_inner(
    db: &Db,
    session_id: &str,
) -> Result<Vec<HermesMessageRow>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, session_id, seq, role, content, tool_json, created_at \
         FROM hermes_message WHERE session_id = ?1 ORDER BY seq ASC",
    )
    .bind(session_id)
    .fetch_all(db)
    .await
}
```

- [ ] **Step 11: `foreign_keys` PRAGMA 확인**

Run: `grep -rn "foreign_keys\|PRAGMA" src-tauri/src/db.rs`

- 결과에 `foreign_keys` ON 설정이 있으면 그대로 진행.
- 없으면 `delete_inner`의 CASCADE가 동작하지 않는다 → `delete_inner`에서 메시지를 먼저 명시 삭제하도록 보강:

```rust
pub(crate) async fn delete_inner(db: &Db, id: &str) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM hermes_message WHERE session_id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM hermes_session WHERE id = ?1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
```

> 이 보강은 PRAGMA 유무와 무관하게 안전하므로, 불확실하면 보강 버전을 채택한다.

- [ ] **Step 12: 테스트 통과 확인**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar session_store 2>&1 | tail -20`
Expected: PASS (4 tests).

- [ ] **Step 13: IPC 커맨드(얇은 위임) 작성**

Add to `session_store.rs` (before tests):

```rust
// ─ IPC 커맨드(얇은 위임) ───────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn hermes_sessions_list(db: State<'_, Db>) -> Result<Vec<HermesSessionRow>, AppError> {
    Ok(list_inner(db.inner()).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_create(
    db: State<'_, Db>,
    id: String,
    name: String,
) -> Result<HermesSessionRow, AppError> {
    Ok(create_inner(db.inner(), &id, &name).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_rename(
    db: State<'_, Db>,
    id: String,
    name: String,
) -> Result<(), AppError> {
    rename_inner(db.inner(), &id, &name).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_archive(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    archive_inner(db.inner(), &id).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_delete(db: State<'_, Db>, id: String) -> Result<(), AppError> {
    delete_inner(db.inner(), &id).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_session_messages(
    db: State<'_, Db>,
    id: String,
) -> Result<Vec<HermesMessageRow>, AppError> {
    Ok(messages_inner(db.inner(), &id).await?)
}

#[tauri::command]
#[specta::specta]
pub async fn hermes_message_append(
    db: State<'_, Db>,
    session_id: String,
    role: String,
    content: String,
    tool_json: Option<String>,
) -> Result<i32, AppError> {
    Ok(append_inner(db.inner(), &session_id, &role, &content, tool_json.as_deref()).await?)
}
```

- [ ] **Step 14: 커맨드 등록**

In `src-tauri/src/lib.rs`, inside `collect_commands![ ... ]` (near the existing `commands::hermes_agent::hermes_agent_send,` line ~239), add:

```rust
        crate::hermes_agent::session_store::hermes_sessions_list,
        crate::hermes_agent::session_store::hermes_session_create,
        crate::hermes_agent::session_store::hermes_session_rename,
        crate::hermes_agent::session_store::hermes_session_archive,
        crate::hermes_agent::session_store::hermes_session_delete,
        crate::hermes_agent::session_store::hermes_session_messages,
        crate::hermes_agent::session_store::hermes_message_append,
```

> 확인: `src-tauri/src/hermes_agent/` 가 `lib.rs`에서 `mod hermes_agent;` 또는 `pub mod hermes_agent;`로 선언돼 있는지 grep. 없으면 경로를 실제 모듈 선언에 맞게 조정(`commands::...` vs `crate::hermes_agent::...`).

- [ ] **Step 15: 게이트 + bindings 재생성 + drift 확인**

Run:

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && \
cargo test 2>&1 | tail -15 && \
cargo clippy --all-targets -- -D warnings 2>&1 | tail -15 && \
cargo fmt --check && cd .. && \
git diff --stat src/bindings.ts
```

Expected: 테스트 PASS, clippy 0 warning, fmt clean, `src/bindings.ts`에 새 `hermesSessionsList` 등 7개 커맨드 추가됨.

- [ ] **Step 16: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/migrations/0043_hermes_sessions.sql \
        src-tauri/src/hermes_agent/session_store.rs \
        src-tauri/src/hermes_agent/mod.rs \
        src-tauri/src/lib.rs src/bindings.ts
git commit -m "feat(hermes): 세션/메시지 SQLite 영속 계층 + CRUD IPC (Slice 1)"
```

---

## Task 2: 영속 배선 — append on send/turn-end + 복원 로드 (기존 탭 UI 유지, 캡 유지)

이 슬라이스는 UI를 바꾸지 않는다. 기존 탭 store가 세션 행을 만들고 메시지를 DB에 적재하며, 부팅 시 세션 목록 + 활성 세션 메시지를 복원한다.

**Files:**

- Modify: `src/components/hermes/useHermesTabsStore.ts`
- Create: `src/components/hermes/sessionList.ts`
- Create: `src/components/hermes/sessionList.test.ts`
- Modify: `src/components/hermes/useHermesTabs.ts` (복원용 액션)

- [ ] **Step 1: DB 메시지 → reducer 메시지 변환 헬퍼 테스트 작성 (failing)**

Create `src/components/hermes/sessionList.ts` will host pure helpers. First the test — Create `src/components/hermes/sessionList.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { autoTitleFrom, rowsToMessages } from "./sessionList";
import type { HermesMessageRow } from "@/bindings";

describe("autoTitleFrom", () => {
  it("trims and truncates first user message", () => {
    expect(autoTitleFrom("   크롤러 고쳐줘  ")).toBe("크롤러 고쳐줘");
    const long = "a".repeat(80);
    expect(autoTitleFrom(long).length).toBeLessThanOrEqual(40);
  });
  it("falls back for empty", () => {
    expect(autoTitleFrom("   ")).toBe("새 세션");
  });
});

describe("rowsToMessages", () => {
  it("maps user/assistant rows to reducer message shapes", () => {
    const rows: HermesMessageRow[] = [
      { id: 1, sessionId: "s", seq: 0, role: "user", content: "hi", toolJson: null, createdAt: "" },
      {
        id: 2,
        sessionId: "s",
        seq: 1,
        role: "assistant",
        content: "yo",
        toolJson: null,
        createdAt: "",
      },
    ];
    const msgs = rowsToMessages(rows);
    expect(msgs[0]).toMatchObject({ role: "user", text: "hi" });
    expect(msgs[1]).toMatchObject({ role: "assistant", done: true });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/components/hermes/sessionList.test.ts 2>&1 | tail -20`
Expected: FAIL — module/exports missing.

- [ ] **Step 3: sessionList.ts 헬퍼 구현**

Create `src/components/hermes/sessionList.ts`:

```ts
import type { HermesMessageRow, HermesSessionRow } from "@/bindings";

import type { HermesMessage } from "./types";
import { uid } from "./useHermesTabs";

export const DEFAULT_SESSION_NAME = "새 세션";
const TITLE_MAX = 40;

/** 첫 user 메시지로 세션 제목 생성. 비면 기본 이름. */
export function autoTitleFrom(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return DEFAULT_SESSION_NAME;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

/** 세션 이름이 비었거나 기본값이면 자동 제목 대상. */
export function shouldAutoTitle(name: string): boolean {
  return !name.trim() || name === DEFAULT_SESSION_NAME;
}

/** DB 메시지 행 → reducer가 렌더하는 HermesMessage[]. assistant는 done=true(과거 turn). */
export function rowsToMessages(rows: HermesMessageRow[]): HermesMessage[] {
  return rows.map((r) => {
    if (r.role === "assistant") {
      let toolCalls: HermesMessage extends { role: "assistant" } ? never : never;
      const tools = r.toolJson ? safeParseTools(r.toolJson) : [];
      return {
        id: uid(),
        role: "assistant" as const,
        chunks: r.content ? [r.content] : [],
        toolCalls: tools,
        ts: Date.parse(r.createdAt) || Date.now(),
        done: true,
      };
    }
    if (r.role === "system") {
      return {
        id: uid(),
        role: "system" as const,
        text: r.content,
        level: "info" as const,
        ts: Date.parse(r.createdAt) || Date.now(),
      };
    }
    return {
      id: uid(),
      role: "user" as const,
      text: r.content,
      images: [],
      ts: Date.parse(r.createdAt) || Date.now(),
    };
  });
}

function safeParseTools(json: string) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 검색 필터 — 이름 부분일치(대소문자 무시). */
export function filterSessions(rows: HermesSessionRow[], query: string): HermesSessionRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}
```

> 주의: 위 `let toolCalls` 줄은 의사코드 잔재 — 제거하고 `const tools = ...`만 사용한다. (자기검토에서 잡음.)

수정된 assistant 분기:

```ts
if (r.role === "assistant") {
  const tools = r.toolJson ? safeParseTools(r.toolJson) : [];
  return {
    id: uid(),
    role: "assistant" as const,
    chunks: r.content ? [r.content] : [],
    toolCalls: tools,
    ts: Date.parse(r.createdAt) || Date.now(),
    done: true,
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/components/hermes/sessionList.test.ts 2>&1 | tail -20`
Expected: PASS (4 tests).

- [ ] **Step 5: reducer에 "load-messages" 액션 추가**

In `src/components/hermes/useHermesTabs.ts`, add to the `Action` union:

```ts
  | { type: "load-messages"; tabId: TabId; messages: HermesMessage[] }
```

And add the case in `tabsReducer` (near `reset-tab`):

```ts
    case "load-messages":
      return updateTab(state, a.tabId, (t) => ({ ...t, messages: a.messages }));
```

(Import `HermesMessage` is already available via `./types` at top of the file.)

- [ ] **Step 6: store에 영속/복원 배선**

In `src/components/hermes/useHermesTabsStore.ts`:

(a) Import helpers at top:

```ts
import { autoTitleFrom, rowsToMessages, shouldAutoTitle } from "./sessionList";
```

(b) `send()`: user dispatch 직후 DB append + 자동 제목. turn 완료(append assistant)는 `agent-end` 핸들러(Step 6c)에서. Replace the body of `send` so that after `dispatch({ type: "user", ... })`:

```ts
    send: async (tabId, text, images = []) => {
      if (!text.trim() && images.length === 0) return;
      dispatch({ type: "user", tabId, text, images });
      dispatch({ type: "set-status", tabId, status: "starting" });
      // 영속: user 메시지 + 자동 제목(첫 메시지일 때)
      void unwrap(commands.hermesMessageAppend(tabId, "user", text, null)).catch(() => {});
      const tab = get().tabs.get(tabId);
      if (tab && shouldAutoTitle(tab.name) && text.trim()) {
        const title = autoTitleFrom(text);
        dispatch({ type: "rename", tabId, name: title });
        void unwrap(commands.hermesSessionRename(tabId, title)).catch(() => {});
      }
      try {
        await unwrap(commands.hermesAgentSend(tabId, text, images));
      } catch (e) {
        dispatch({ type: "system", tabId, text: `송신 실패: ${(e as Error).message}`, level: "error" });
        dispatch({ type: "set-status", tabId, status: "error" });
      }
    },
```

(c) `agent-end` 영속: bootstrap의 `hermes-agent:turn-end` 리스너에서 dispatch 후, 방금 닫힌 assistant turn의 누적 텍스트+툴을 DB에 append. 리스너 핸들러를 다음으로 교체:

```ts
await setup<{ status: "ok" | "cancelled" | "error"; error?: string }>(
  "hermes-agent:turn-end",
  (e) => {
    const tabId = e.payload.tabId;
    if (!tabId) return;
    dispatch({ type: "agent-end", tabId, status: e.payload.status, error: e.payload.error });
    // 영속: 방금 닫힌 assistant 메시지 1개를 DB에 append.
    const tab = useHermesTabsStore.getState().tabs.get(tabId);
    const last = tab?.messages.findLast?.((m) => m.role === "assistant");
    if (last && last.role === "assistant") {
      const content = last.chunks.join("");
      const toolJson = last.toolCalls.length ? JSON.stringify(last.toolCalls) : null;
      if (content || toolJson) {
        void unwrap(commands.hermesMessageAppend(tabId, "assistant", content, toolJson)).catch(
          () => {},
        );
      }
    }
  },
);
```

> `Array.prototype.findLast`가 타겟 런타임(WKWebView)에서 가용한지 확인. 불확실하면 역순 루프로 대체:
>
> ```ts
> let last: (typeof tab.messages)[number] | undefined;
> for (let i = (tab?.messages.length ?? 0) - 1; i >= 0; i--) {
>   const m = tab!.messages[i];
>   if (m.role === "assistant") {
>     last = m;
>     break;
>   }
> }
> ```

(d) `openTab()`: 슬롯 생성 시 DB 세션도 생성(이름은 기본). Replace `openTab`:

```ts
    openTab: async () => {
      const s = get();
      if (s.tabs.size >= s.cap) return null;
      const tabId = uid();
      try {
        await unwrap(commands.hermesAgentOpenTab(tabId));
        await unwrap(commands.hermesSessionCreate(tabId, "새 세션"));
        dispatch({ type: "open-tab", tabId, defaultName: "새 세션" });
        return tabId;
      } catch (e) {
        const active = get().activeTabId;
        if (active) {
          dispatch({ type: "system", tabId: active, text: `세션 생성 실패: ${(e as Error).message}`, level: "error" });
        }
        return null;
      }
    },
```

(이 단계에서는 `pickDefaultName` import를 제거해도 되고 Task 4에서 정리해도 된다. lint 에러를 피하려면 지금 제거.)

- [ ] **Step 7: 부팅 시 세션 목록 복원**

In `useHermesTabsBootstrap`, replace the cap-fetch + `ensureDefaultTab` block so that on launch we hydrate from DB instead of auto-opening a fresh tab:

```ts
// 부팅: DB에서 세션 목록 복원. 없으면 빈 세션 1개 생성.
void (async () => {
  const res = await commands.hermesSessionsList();
  if (cancelled) return;
  if (res.status === "ok" && res.data.length > 0) {
    for (const row of res.data) {
      dispatch({ type: "open-tab", tabId: row.id, defaultName: row.name });
    }
    const firstId = res.data[0].id;
    dispatch({ type: "set-active", tabId: firstId });
    // 활성 세션 메시지 lazy-load
    const msgs = await commands.hermesSessionMessages(firstId);
    if (!cancelled && msgs.status === "ok") {
      dispatch({ type: "load-messages", tabId: firstId, messages: rowsToMessages(msgs.data) });
    }
  } else {
    await ensureDefaultTab();
  }
})();
```

Remove the old `void commands.hermesAgentCap().then(...)` block (cap is removed in Task 3; until then, leave `cap` at fallback — do NOT call `hermesAgentCap` here anymore since we no longer gate on it for bootstrap). `ensureDefaultTab` stays as the empty-state fallback.

> 주의: `open-tab` reducer는 `tabId` 중복이면 no-op이므로 StrictMode 이중 마운트에서 안전. `didOpenDefaultTab` 가드는 `ensureDefaultTab` 경로에만 적용된다.

- [ ] **Step 8: setActive에 메시지 lazy-load 추가**

In the store, replace `setActive` so switching a session hydrates its messages once if empty:

```ts
    setActive: (tabId) => {
      dispatch({ type: "set-active", tabId });
      const tab = get().tabs.get(tabId);
      if (tab && tab.messages.length === 0) {
        void commands.hermesSessionMessages(tabId).then((res) => {
          if (res.status === "ok" && res.data.length > 0) {
            dispatch({ type: "load-messages", tabId, messages: rowsToMessages(res.data) });
          }
        });
      }
    },
```

- [ ] **Step 9: closeTab → archive(삭제 아님)로 변경**

세션을 닫으면 프로세스만 죽이고 히스토리는 보존(영구 기억 목표). Replace `closeTab`:

```ts
    closeTab: async (tabId) => {
      try {
        await unwrap(commands.hermesAgentCloseTab(tabId));
      } catch {
        /* best-effort */
      }
      try {
        await unwrap(commands.hermesSessionArchive(tabId));
      } catch {
        /* best-effort */
      }
      dispatch({ type: "close-tab", tabId });
      if (get().tabs.size === 0) {
        await get().openTab();
      }
    },
```

> 영구 삭제(메시지 포함)는 Task 4 사이드바의 명시적 "삭제" 액션에서 `hermesSessionDelete`로 제공한다. 닫기=보관, 삭제=완전 제거의 구분.

- [ ] **Step 10: prettier + 게이트**

Run:

```bash
pnpm exec prettier --write src/components/hermes/sessionList.ts src/components/hermes/sessionList.test.ts src/components/hermes/useHermesTabs.ts src/components/hermes/useHermesTabsStore.ts
pnpm typecheck 2>&1 | tail -15
pnpm lint 2>&1 | tail -15
pnpm vitest run src/components/hermes 2>&1 | tail -20
```

Expected: typecheck 0 error, lint 0 error(기존 baseline 경고 허용), vitest PASS.

- [ ] **Step 11: 커밋**

```bash
git add src/components/hermes/sessionList.ts src/components/hermes/sessionList.test.ts \
        src/components/hermes/useHermesTabs.ts src/components/hermes/useHermesTabsStore.ts
git commit -m "feat(hermes): 대화 영속화(append on send/turn-end) + 부팅 복원 (Slice 2)"
```

---

## Task 3: 3개 캡 제거 + 부드러운 경고

**Files:**

- Modify: `src-tauri/src/commands/hermes_agent.rs`
- Modify: `src-tauri/src/lib.rs` (collect_commands — `hermes_agent_cap` 제거)
- Modify: `src/components/hermes/types.ts` / `useHermesTabs.ts` (`cap` 제거)
- Modify: `src/components/hermes/useHermesTabsStore.ts` (cap 분기 제거 + live-count selector)
- Modify: `src/components/hermes/HermesPanel.tsx` (툴팁 "최대 3개" 제거)

- [ ] **Step 1: Rust 캡 제거**

In `src-tauri/src/commands/hermes_agent.rs`:

- Delete `pub const HERMES_TAB_CAP: usize = 3;` (line ~15).
- Delete the `hermes_agent_cap` command (lines ~33–39).
- In `hermes_agent_send`, remove both cap pre-checks: the read-lock `if !map.contains_key(&tab_id) && map.len() >= HERMES_TAB_CAP` block (~69–77) and the post-spawn `else if map.len() >= HERMES_TAB_CAP { ... }` branch (~94–101). Keep the racing-spawn re-check (`if let Some(existing)`) and the final `else` insert branch.

After edit, the `None =>` arm becomes:

```rust
        None => {
            // Spawn WITHOUT holding any lock so concurrent tabs don't serialise here.
            let session = AcpSession::spawn(app.clone(), tab_id.clone()).await?;
            let mut map = holder.write().await;
            if let Some(existing) = map.get(&tab_id) {
                let tup = (
                    existing.session_id.clone(),
                    existing.image_transport,
                    existing.stdin_tx.clone(),
                    existing.pending.clone(),
                    existing.next_id.clone(),
                );
                drop(map);
                session.kill().await;
                tup
            } else {
                let tup = (
                    session.session_id.clone(),
                    session.image_transport,
                    session.stdin_tx.clone(),
                    session.pending.clone(),
                    session.next_id.clone(),
                );
                map.insert(tab_id.clone(), session);
                tup
            }
        }
```

- [ ] **Step 2: lib.rs에서 `hermes_agent_cap` 등록 제거**

In `src-tauri/src/lib.rs`, delete the line `commands::hermes_agent::hermes_agent_cap,` (~238).

- [ ] **Step 3: Rust 게이트 + bindings 재생성**

Run:

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && \
cargo test 2>&1 | tail -15 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -10 && cargo fmt --check && \
cd .. && git diff --stat src/bindings.ts
```

Expected: PASS; `hermesAgentCap`가 `src/bindings.ts`에서 제거됨.

- [ ] **Step 4: FE cap 제거**

- `src/components/hermes/types.ts`: remove `cap` from `TabsState`, remove `HERMES_TAB_CAP_FALLBACK`, remove `cap` from `EMPTY_TABS_STATE`, remove the `set-cap` action from the `Action` union.
- `src/components/hermes/useHermesTabs.ts`: remove the `set-cap` case and `cap` references in `open-tab`/`close-tab`/`set-active` reducer returns (return objects no longer include `cap`).
- `src/components/hermes/useHermesTabsStore.ts`:
  - `openTab`: remove `if (s.tabs.size >= s.cap) return null;`.
  - Remove the `set-cap` dispatch and any `HERMES_TAB_CAP_FALLBACK` re-export.
  - Add a live-session-count selector for the warning banner:
    ```ts
    /** 동시 실행(슬롯 점유) 세션 수가 임계 이상인지. 백엔드 holder 크기와 1:1은 아니지만
     *  FE가 추적하는 활성 탭 수의 근사로 충분(경고 전용, 차단 아님). */
    export const LIVE_SESSION_WARN_THRESHOLD = 8;
    export function selectShowResourceWarning(s: TabsState): boolean {
      return s.tabs.size >= LIVE_SESSION_WARN_THRESHOLD;
    }
    ```

- [ ] **Step 5: HermesPanel 툴팁/disabled 정리**

In `src/components/hermes/HermesPanel.tsx`:

- The `+새 탭` Button: remove `disabled={canCreateTab === false}` and change `title={canCreateTab === false ? "최대 3개" : "새 탭"}` → `title="새 세션"`, `aria-label="새 세션"`.
- Remove the now-unused `canCreateTab` prop from `HermesPanel`/`PanelHeader` signatures and their call sites.

> `canCreateTab`를 넘기던 `HermesView.tsx`도 해당 prop 제거(다음 grep로 사용처 확인): `grep -rn "canCreateTab" src/`.

- [ ] **Step 6: prettier + FE 게이트**

Run:

```bash
pnpm exec prettier --write src/components/hermes/*.ts src/components/hermes/*.tsx
pnpm typecheck 2>&1 | tail -15 && pnpm lint 2>&1 | tail -10 && pnpm vitest run src/components/hermes 2>&1 | tail -15
```

Expected: 0 error. (캡 관련 죽은 참조가 남아 있으면 typecheck가 잡아준다 — 전부 정리.)

- [ ] **Step 7: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/commands/hermes_agent.rs src-tauri/src/lib.rs src/bindings.ts \
        src/components/hermes/types.ts src/components/hermes/useHermesTabs.ts \
        src/components/hermes/useHermesTabsStore.ts src/components/hermes/HermesPanel.tsx \
        src/components/HermesView.tsx
git commit -m "feat(hermes): 3개 세션 하드캡 제거 + 리소스 경고 임계 (Slice 3)"
```

---

## Task 4: 좌측 세션 사이드바 UX

기존 탭 헤더를 좌측 사이드바로 교체. 검색·상태점·미리보기·인라인 rename·삭제/보관·키보드.

**Files:**

- Create: `src/components/hermes/HermesSidebar.tsx`
- Modify: `src/components/hermes/HermesPanel.tsx` (2-컬럼 레이아웃, 기본 폭 ↑)
- Modify: `src/components/HermesView.tsx` (사이드바 배선)
- Modify: `src/components/hermes/sessionList.ts` (미리보기/상대시각 헬퍼 + 테스트)
- Modify: `src/components/hermes/sessionList.test.ts`

- [ ] **Step 1: 미리보기/상대시각 순수 헬퍼 테스트 (failing)**

Add to `src/components/hermes/sessionList.test.ts`:

```ts
import { messagePreview, relativeTime } from "./sessionList";
import type { TabState } from "./useHermesTabs";

describe("messagePreview", () => {
  it("returns last user/assistant text trimmed", () => {
    const tab = {
      messages: [
        { id: "1", role: "user", text: "안녕", images: [], ts: 1 },
        {
          id: "2",
          role: "assistant",
          chunks: ["반갑", "습니다"],
          toolCalls: [],
          ts: 2,
          done: true,
        },
      ],
    } as unknown as TabState;
    expect(messagePreview(tab)).toBe("반갑습니다");
  });
  it("empty for no messages", () => {
    expect(messagePreview({ messages: [] } as unknown as TabState)).toBe("");
  });
});

describe("relativeTime", () => {
  it("formats seconds/minutes/hours", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 30_000, now)).toMatch(/방금|초/);
    expect(relativeTime(now - 5 * 60_000, now)).toMatch(/분/);
    expect(relativeTime(now - 3 * 3600_000, now)).toMatch(/시간/);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm vitest run src/components/hermes/sessionList.test.ts 2>&1 | tail -20`
Expected: FAIL — `messagePreview`/`relativeTime` not exported.

- [ ] **Step 3: 헬퍼 구현**

Add to `src/components/hermes/sessionList.ts`:

```ts
import type { TabState } from "./useHermesTabs";

const PREVIEW_MAX = 48;

/** 마지막 user/assistant 메시지의 본문 미리보기. */
export function messagePreview(tab: Pick<TabState, "messages">): string {
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const m = tab.messages[i];
    if (m.role === "user") return clip(m.text);
    if (m.role === "assistant") return clip(m.chunks.join(""));
  }
  return "";
}

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

/** 상대 시각(한국어). now 주입 가능(테스트). */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 45) return "방금";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  return `${day}일 전`;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm vitest run src/components/hermes/sessionList.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: HermesSidebar 컴포넌트 작성**

Create `src/components/hermes/HermesSidebar.tsx`. shadcn `Button` + `Input` + lucide. `DESIGN.md` 토큰 클래스(`bg-background`, `border-border`, `text-muted-foreground` 등)만 사용 — raw hex 금지(check:design-tokens 게이트).

```tsx
import { MessageSquarePlus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { filterSessions, messagePreview, relativeTime } from "./sessionList";
import type { TabId, TabState } from "./useHermesTabs";

const STATUS_DOT: Record<string, string> = {
  idle: "bg-muted-foreground/40",
  starting: "bg-amber-500",
  ready: "bg-emerald-500",
  error: "bg-destructive",
};

export function HermesSidebar({
  tabs,
  activeTabId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  showResourceWarning,
}: {
  tabs: TabState[];
  activeTabId: TabId | null;
  onSelect: (id: TabId) => void;
  onNew: () => void;
  onDelete: (id: TabId) => void;
  onRename: (id: TabId, name: string) => void;
  showResourceWarning: boolean;
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<TabId | null>(null);
  const [draft, setDraft] = useState("");

  // 이름만 검색(세션 행이 아니라 탭 상태 기준 — 동일 필드명).
  const filtered = useMemo(
    () =>
      filterSessions(
        tabs.map((t) => ({ ...t, name: t.name })) as never,
        query,
      ) as unknown as TabState[],
    [tabs, query],
  );

  const commitRename = (id: TabId) => {
    const name = draft.trim();
    if (name) onRename(id, name);
    setEditingId(null);
  };

  return (
    <div className="bg-background/60 border-border flex w-56 shrink-0 flex-col border-r">
      <div className="flex items-center gap-1.5 p-2">
        <Button
          variant="ghost"
          className="hover:bg-muted/60 h-8 flex-1 justify-start gap-2 px-2"
          onClick={onNew}
        >
          <MessageSquarePlus className="size-4" />
          <span className="text-sm">새 세션</span>
        </Button>
      </div>
      <div className="relative px-2 pb-2">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="세션 검색…"
          className="h-8 pl-7 text-sm"
        />
      </div>
      {showResourceWarning && (
        <p className="text-muted-foreground border-border/60 mx-2 mb-2 rounded border px-2 py-1 text-[11px]">
          실행 중 세션이 많습니다 — 리소스 사용량이 늘 수 있어요.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {filtered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-6 text-center text-xs">세션이 없습니다.</p>
        ) : (
          filtered.map((t) => {
            const active = t.id === activeTabId;
            return (
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(t.id);
                }}
                className={`group mb-0.5 flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left ${
                  active ? "bg-muted" : "hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[t.status] ?? STATUS_DOT.idle}`}
                  />
                  {editingId === t.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(t.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(t.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="bg-background border-border min-w-0 flex-1 rounded border px-1 text-sm"
                    />
                  ) : (
                    <span
                      className="min-w-0 flex-1 truncate text-sm font-medium"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingId(t.id);
                        setDraft(t.name);
                      }}
                    >
                      {t.name}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    className="hover:bg-destructive/10 hover:text-destructive size-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
                    aria-label="세션 삭제"
                    title="세션 삭제(대화 기록 제거)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(t.id);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div className="text-muted-foreground flex items-center justify-between gap-2 pl-3">
                  <span className="min-w-0 truncate text-[11px]">{messagePreview(t)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

> `filterSessions`는 `HermesSessionRow[]`용이지만 이름 필드만 쓰므로 위처럼 캐스팅해 재사용한다. 깔끔하지 않으면 `sessionList.ts`에 `filterByName<T extends { name: string }>(rows: T[], q: string): T[]` 제네릭으로 일반화하고 `filterSessions`를 그 위에 정의(자기검토 권장 — 채택 시 `sessionList.test.ts`의 import도 갱신).

- [ ] **Step 6: HermesPanel 2-컬럼 + 기본 폭**

In `src/components/hermes/HermesPanel.tsx`:

- The content wrapper `<div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>` → keep, but `HermesView`가 children으로 `[Sidebar | ChatPane]`를 가로 배치하도록 위임(Step 7). Panel은 레이아웃 컨테이너만 제공하므로 여기서는 헤더의 탭 제어 버튼(`onNewTab`/`onCloseActive`)을 제거하고(사이드바로 이동), 기본 폭만 키운다.
- Default width: change `const w = state.w ?? 460;` → `?? 720;`. (height 그대로.)
- Remove `onNewTab`, `onCloseActive`, `canCreateTab`, `activeTabId` props from `HermesPanel`/`PanelHeader`(사이드바가 담당). `onRestart`/`isStreaming`/`showHeaderTitle`는 유지.

> `clampToViewport`/`defaultBounds`는 그대로. 기존 사용자에게 저장된 460 폭이 있으면 그대로 뜨므로(상태 영속), Step에서 별도 마이그레이션은 안 한다 — 사용자가 리사이즈하면 새 폭 저장. (선택: 첫 로드시 저장 폭이 600 미만이면 720으로 끌어올리는 일회 보정. YAGNI — 생략.)

- [ ] **Step 7: HermesView에서 사이드바 + 채팅 배치**

In `src/components/HermesView.tsx`, wire the sidebar to the store. 기존 채팅 본문을 우측에 두고 좌측에 `HermesSidebar`:

```tsx
// (발췌) store에서 필요한 것 선택
const tabs = useHermesTabsStore((s) => Array.from(s.tabs.values()));
const activeTabId = useHermesTabsStore((s) => s.activeTabId);
const setActive = useHermesTabsStore((s) => s.setActive);
const openTab = useHermesTabsStore((s) => s.openTab);
const closeTab = useHermesTabsStore((s) => s.closeTab); // = archive
const removeSession = async (id: string) => {
  try {
    await unwrap(commands.hermesAgentCloseTab(id));
  } catch {
    /* best-effort */
  }
  try {
    await unwrap(commands.hermesSessionDelete(id));
  } catch {
    /* best-effort */
  }
  useHermesTabsStore.getState()._dispatch({ type: "close-tab", tabId: id });
  if (useHermesTabsStore.getState().tabs.size === 0) await openTab();
};
const rename = useHermesTabsStore((s) => s.rename);
const onRename = (id: string, name: string) => {
  rename(id, name);
  void unwrap(commands.hermesSessionRename(id, name)).catch(() => {});
};
const showWarn = useHermesTabsStore(selectShowResourceWarning);
```

Layout (inside the `<HermesPanel>` children):

```tsx
<div className="flex min-h-0 flex-1">
  <HermesSidebar
    tabs={tabs}
    activeTabId={activeTabId}
    onSelect={setActive}
    onNew={() => void openTab()}
    onDelete={(id) => void removeSession(id)}
    onRename={onRename}
    showResourceWarning={showWarn}
  />
  <div className="flex min-h-0 flex-1 flex-col">{/* 기존 채팅 뷰(메시지 목록 + 입력창) */}</div>
</div>
```

> `HermesView.tsx`의 실제 기존 구조에 맞춰 채팅 본문을 우측 컬럼으로 옮긴다. 기존에 `HermesPanel`에 넘기던 `onNewTab`/`onCloseActive`/`canCreateTab` props 전달은 제거(Task 3에서 일부 제거됨 — 남은 것 정리).

- [ ] **Step 8: 키보드 단축키 (⌘N / ⌘W / ⌘1–9)**

In `src/components/HermesView.tsx`, add an effect (only when panel open — reuse existing open state or gate inside handler). 입력창 포커스 중 ⌘1–9는 통과시키되 ⌘N/⌘W는 항상 처리:

```tsx
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      void openTab();
    } else if (e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (activeTabId) void closeTab(activeTabId);
    } else if (/^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1;
      const list = Array.from(useHermesTabsStore.getState().tabs.values());
      if (list[idx]) {
        e.preventDefault();
        setActive(list[idx].id);
      }
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [activeTabId, openTab, closeTab, setActive]);
```

> 기존 글로벌 단축키(cmd-knob/overlay-stack)와 충돌하는지 확인: `grep -rn "metaKey" src/ | head`. 충돌 시 패널 포커스 시에만 활성화하도록 가드.

- [ ] **Step 9: prettier + 게이트(디자인 토큰 포함)**

Run:

```bash
pnpm exec prettier --write src/components/hermes/HermesSidebar.tsx src/components/hermes/sessionList.ts src/components/hermes/sessionList.test.ts src/components/hermes/HermesPanel.tsx src/components/HermesView.tsx
pnpm typecheck 2>&1 | tail -15
pnpm lint 2>&1 | tail -10
pnpm vitest run src/components/hermes 2>&1 | tail -15
pnpm run check:design-tokens 2>&1 | tail -5
```

Expected: 모두 통과. design-tokens "ok"(raw hex/임의 색 없음 — 위 컴포넌트는 토큰 클래스만 사용. amber/emerald는 Tailwind 팔레트 유틸리티라 허용되는지 check 스크립트로 확인; 막히면 상태점 색도 토큰 기반으로 교체).

- [ ] **Step 10: 커밋**

```bash
git add src/components/hermes/HermesSidebar.tsx src/components/hermes/sessionList.ts \
        src/components/hermes/sessionList.test.ts src/components/hermes/HermesPanel.tsx \
        src/components/HermesView.tsx
git commit -m "feat(hermes): 좌측 세션 사이드바 UX(검색·상태·rename·삭제·키보드) (Slice 4)"
```

---

## Task 5: 재개 — replay preamble

재시작 후 죽은 세션에 첫 전송 시, Rust가 fresh `session/new` 후 최근 N개 메시지를 컨텍스트 preamble로 prepend.

**Files:**

- Modify: `src-tauri/src/hermes_agent/session_store.rs` (recent-messages 조회 + preamble 빌더 + 테스트)
- Modify: `src-tauri/src/commands/hermes_agent.rs` (`hermes_agent_send`에 첫-프롬프트 preamble 주입)

- [ ] **Step 1: preamble 빌더 + recent 조회 테스트 (failing)**

Add to `session_store.rs` tests:

```rust
    #[tokio::test]
    async fn recent_messages_bounded_and_ordered() {
        let db = fresh_db().await;
        create_inner(&db, "s1", "a").await.expect("create");
        for i in 0..25 {
            append_inner(&db, "s1", "user", &format!("m{i}"), None).await.expect("append");
        }
        let recent = recent_messages_inner(&db, "s1", 20).await.expect("recent");
        assert_eq!(recent.len(), 20);
        // 시간순(오래된 → 최신) 이어야 preamble이 자연스럽다.
        assert_eq!(recent.first().expect("first").content, "m5");
        assert_eq!(recent.last().expect("last").content, "m24");
    }

    #[test]
    fn preamble_renders_roles_and_is_empty_for_none() {
        assert_eq!(build_replay_preamble(&[]), None);
        let rows = vec![
            mk("user", "hi"),
            mk("assistant", "yo"),
        ];
        let p = build_replay_preamble(&rows).expect("some");
        assert!(p.contains("이전 대화"));
        assert!(p.contains("hi"));
        assert!(p.contains("yo"));
    }

    fn mk(role: &str, content: &str) -> HermesMessageRow {
        HermesMessageRow {
            id: 0,
            session_id: "s".into(),
            seq: 0,
            role: role.into(),
            content: content.into(),
            tool_json: None,
            created_at: String::new(),
        }
    }
```

- [ ] **Step 2: 실패 확인**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar session_store 2>&1 | tail -20`
Expected: FAIL — `recent_messages_inner`/`build_replay_preamble` not found.

- [ ] **Step 3: 구현**

Add to `session_store.rs`:

```rust
/// 최근 `limit`개 메시지를 시간순(오래된→최신)으로 반환. preamble replay용.
pub(crate) async fn recent_messages_inner(
    db: &Db,
    session_id: &str,
    limit: i64,
) -> Result<Vec<HermesMessageRow>, sqlx::Error> {
    let mut rows: Vec<HermesMessageRow> = sqlx::query_as(
        "SELECT id, session_id, seq, role, content, tool_json, created_at \
         FROM hermes_message WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2",
    )
    .bind(session_id)
    .bind(limit)
    .fetch_all(db)
    .await?;
    rows.reverse(); // DESC로 뽑아 최신 limit개 확보 후 시간순으로 뒤집음
    Ok(rows)
}

/// replay preamble 텍스트 빌더. 빈 입력이면 None(주입 안 함).
pub(crate) fn build_replay_preamble(rows: &[HermesMessageRow]) -> Option<String> {
    if rows.is_empty() {
        return None;
    }
    let mut s = String::from(
        "다음은 이 세션의 이전 대화 맥락입니다(앱 재시작으로 새 세션이 시작됨). \
         이어서 답하세요.\n\n",
    );
    for r in rows {
        let who = match r.role.as_str() {
            "user" => "사용자",
            "assistant" => "어시스턴트",
            _ => continue, // system 등은 맥락에서 제외
        };
        s.push_str(who);
        s.push_str(": ");
        s.push_str(&r.content);
        s.push_str("\n\n");
    }
    Some(s)
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test -p work-radar session_store 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: send에 첫-프롬프트 preamble 주입**

In `src-tauri/src/commands/hermes_agent.rs` `hermes_agent_send`, the `None =>` arm means no live child existed → this is the first prompt of a (possibly restored) session after spawn. After successfully obtaining the session tuple in that arm (i.e., we just spawned), build a preamble from DB and prepend to `text`.

Pass the DB pool into the command (add `db: State<'_, Db>` param) and capture whether we spawned:

```rust
pub async fn hermes_agent_send(
    app: AppHandle,
    holder: State<'_, HermesAgentHolder>,
    db: State<'_, crate::db::Db>,
    tab_id: String,
    text: String,
    image_paths: Vec<String>,
) -> Result<(), AppError> {
```

Track spawn in the match:

```rust
    let mut spawned = false;
    let (session_id, transport, stdin_tx, pending, next_id) = match snapshot {
        Some(s) => s,
        None => {
            spawned = true;
            // ... existing spawn logic (Task 3 simplified form) ...
        }
    };
```

After the match, build the effective prompt text:

```rust
    // 재개: 방금 spawn한 세션이고 DB에 이전 히스토리가 있으면 최근 N개를 preamble로 prepend.
    const REPLAY_LIMIT: i64 = 20;
    let mut effective_text = text.clone();
    if spawned {
        let recent =
            crate::hermes_agent::session_store::recent_messages_inner(db.inner(), &tab_id, REPLAY_LIMIT)
                .await
                .unwrap_or_default();
        // 방금 FE가 append한 이번 user 메시지는 preamble에서 제외(마지막 1개가 곧 이 text).
        let ctx: Vec<_> = recent
            .into_iter()
            .filter(|r| !(r.role == "user" && r.content == text))
            .collect();
        if let Some(preamble) =
            crate::hermes_agent::session_store::build_replay_preamble(&ctx)
        {
            effective_text = format!("{preamble}---\n\n{text}");
        }
    }
```

Then in the prompt-building block, use `effective_text` instead of `text`:

```rust
    if !effective_text.is_empty() {
        prompt.push(json!({ "type": "text", "text": effective_text }));
    }
```

> 순서 주의: FE `send()`가 `hermesMessageAppend(user)`를 `hermesAgentSend` **전에** 호출하므로(Task 2 Step 6b), spawn 시점에 이번 user 메시지가 이미 DB에 있다. 위 필터가 그 중복을 제거한다. 동일 텍스트의 과거 메시지까지 지워질 수 있으나(드묾) 맥락 손실은 경미 — 허용.

- [ ] **Step 6: db 인자 추가에 따른 호출부/등록 영향 확인**

`hermes_agent_send`는 tauri 커맨드라 인자는 IPC로 주입된다. `db: State<'_, Db>`는 `app.manage(pool)`로 이미 관리 중이므로 FE 시그니처(`hermesAgentSend(tabId, text, images)`)는 변하지 않는다(State는 bindings에 노출 안 됨). 확인:

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test 2>&1 | tail -10 && cd .. && git diff src/bindings.ts | grep -A3 hermesAgentSend || echo "no signature change"
```

Expected: `hermesAgentSend` 시그니처 불변(no signature change).

- [ ] **Step 7: 전체 Rust 게이트**

Run:

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && \
cargo test 2>&1 | tail -12 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -10 && cargo fmt --check
```

Expected: PASS, clippy 0, fmt clean.

- [ ] **Step 8: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/src/hermes_agent/session_store.rs src-tauri/src/commands/hermes_agent.rs
git commit -m "feat(hermes): 재시작 후 최근 N개 메시지 replay 재개 (Slice 5)"
```

---

## 최종 검증 (전 슬라이스 후)

- [ ] **전체 게이트 일괄**

```bash
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && \
cargo test 2>&1 | tail -8 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -5 && cargo fmt --check && cd ..
pnpm typecheck && pnpm lint && pnpm vitest run 2>&1 | tail -8
git diff --exit-code src/bindings.ts && echo "bindings drift 0"
```

- [ ] **라이브 스모크(사용자/cmux — 에이전트는 native WKWebView 클릭 불가)**

`pnpm tauri dev` 부팅 후:

1. 세션 4개 생성(캡 없음 확인).
2. 각 세션에서 대화 1턴 → 사이드바 미리보기·상태점 갱신 확인.
3. 앱 종료 후 재시작 → 세션 4개 + 각 히스토리 복원 확인.
4. 한 세션에 후속 전송 → 직전 맥락 이어받는지 확인(replay).
5. 세션 이름 더블클릭 rename, 삭제(기록 제거) vs 닫기(보관) 동작 확인.
6. ⌘N/⌘W/⌘1–9 단축키 확인.

- [ ] **critic 패스 (self-approve 금지)**

각 슬라이스 또는 전체에 대해 `oh-my-claudecode:critic`(opus, 별도 컨텍스트)로 INVARIANT 7개 + review-bar 확인. ACCEPT 전엔 done 아님.

- [ ] **문서/decisions 업데이트**

`docs/decisions.md`에 한 줄(Phase 트레이드오프: replay 재개 채택, `session/load` 연기) 추가.

---

## Self-Review 결과 (작성자 인라인 점검)

- **Spec 커버리지:** Goals 1–5 전부 태스크에 매핑됨(1=Task4 자동제목, 2=Task3, 3=Task1/2/5, 4=Task4, 5=Task4 디테일). Non-Goal(per-session cwd, `session/load`)은 컬럼만 두고 미구현 — 일치.
- **Placeholder 스캔:** Step 2(Task2)의 `sessionList.ts` 예시에 의사코드 잔재(`let toolCalls ... never`)가 있었음 → 같은 스텝에 "수정된 assistant 분기" 블록으로 교체 명시. 채택 시 잔재 줄 삭제.
- **타입 일관성:** Rust inner/커맨드 이름(`create_inner`/`hermes_session_create` 등) 전 태스크 일치. FE `commands.hermesSessionCreate/Rename/Archive/Delete/Messages`, `hermesMessageAppend`, `hermesSessionsList`는 Task1에서 정의한 snake_case 커맨드의 camelCase 바인딩과 일치. `load-messages` 액션은 Task2에서 정의 후 Task2/4에서 사용 — 일치.
- **알려진 미세 위험(실행자 주의):** `findLast` 런타임 가용성(Task2 Step6c 대안 제공), `filterSessions` 캐스팅(Task4 Step5 제네릭 대안 제공), 상태점 amber/emerald가 design-tokens 게이트 통과하는지(Task4 Step9에서 확인·필요시 토큰화), 글로벌 단축키 충돌(Task4 Step8 grep).
