# Today×Timeline PR 2 — Sync Worker & IPC

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pending_calendar_writes` 큐를 굴리는 tokio 워커 + 4개 IPC 커맨드 + 2개 이벤트. UI 호출 없음. Rust 단위 테스트만으로 동작 검증.

**Architecture:** `calendar/sync.rs`에 워커 모듈. `lib.rs` 부팅에서 spawn. 큐는 SQLite UPSERT (UNIQUE 머지). 800ms 디바운스는 `next_attempt_at = now + 800ms` + 200ms 폴링 + notify 깨우기. 실패는 backoff [1s, 3s, 9s] 3회 후 `last_error` 보존 + emit `CalendarSyncFailed`.

**Tech Stack:** tokio, sqlx, serde_json, tauri-specta, mockall (또는 자작 trait).

**Spec:** §5, §6. **Depends on:** PR 1.

---

### Task 1: PendingWrite 모델 + 쿼리 함수

**Files:**
- Create: `src-tauri/src/models/pending_write.rs`
- Modify: `src-tauri/src/models/mod.rs`

- [ ] **Step 1: 모델 작성**

```rust
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::FromRow;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow, Type)]
pub struct PendingWrite {
    pub id: i64,
    pub kind: String,           // create|patch|delete
    pub target_kind: String,    // signal|routine_check
    pub target_id: String,
    pub calendar_id: String,
    pub event_id: Option<String>,
    pub payload_json: String,
    pub attempts: i32,
    pub next_attempt_at: String,
    pub last_error: Option<String>,
    pub created_at: String,
}
```

- [ ] **Step 2: `mod.rs`에 export 추가**

```rust
pub mod pending_write;
pub use pending_write::PendingWrite;
```

- [ ] **Step 3: 빌드**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/models/
git commit -m "feat(model): PendingWrite struct (PR 2/7)"
```

---

### Task 2: 큐 store — UPSERT 머지 함수 (TDD)

**Files:**
- Create: `src-tauri/src/calendar/pending_store.rs`
- Modify: `src-tauri/src/calendar/mod.rs` (`pub mod pending_store;`)

- [ ] **Step 1: 실패하는 테스트 작성**

```rust
// src-tauri/src/calendar/pending_store.rs 하단 #[cfg(test)] 모듈
#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> sqlx::SqlitePool {
        let p = SqlitePoolOptions::new().connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn upsert_merges_same_target_kind() {
        let p = pool().await;
        upsert_write(&p, "patch", "signal", "s1", "cal1", None,
                     r#"{"start":"T1"}"#, 800).await.unwrap();
        upsert_write(&p, "patch", "signal", "s1", "cal1", None,
                     r#"{"start":"T2"}"#, 800).await.unwrap();
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, payload_json FROM pending_calendar_writes WHERE target_id='s1'"
        ).fetch_all(&p).await.unwrap();
        assert_eq!(rows.len(), 1, "same target+kind must merge");
        assert!(rows[0].1.contains("T2"), "latest payload must win");
    }
}
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test --lib pending_store -- --nocapture`
Expected: FAIL (`upsert_write` 미정의).

- [ ] **Step 3: 최소 구현**

```rust
use sqlx::SqlitePool;
use chrono::{Duration, Utc};

pub async fn upsert_write(
    pool: &SqlitePool,
    kind: &str,
    target_kind: &str,
    target_id: &str,
    calendar_id: &str,
    event_id: Option<&str>,
    payload_json: &str,
    debounce_ms: i64,
) -> sqlx::Result<i64> {
    let next = (Utc::now() + Duration::milliseconds(debounce_ms)).to_rfc3339();
    let row: (i64,) = sqlx::query_as(
        r#"INSERT INTO pending_calendar_writes
             (kind, target_kind, target_id, calendar_id, event_id, payload_json, next_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_kind, target_id, kind) DO UPDATE SET
             calendar_id     = excluded.calendar_id,
             event_id        = excluded.event_id,
             payload_json    = excluded.payload_json,
             next_attempt_at = excluded.next_attempt_at,
             attempts        = 0,
             last_error      = NULL
           RETURNING id"#,
    )
    .bind(kind).bind(target_kind).bind(target_id)
    .bind(calendar_id).bind(event_id).bind(payload_json).bind(next)
    .fetch_one(pool).await?;
    Ok(row.0)
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `cd src-tauri && cargo test --lib pending_store`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/calendar/pending_store.rs src-tauri/src/calendar/mod.rs
git commit -m "feat(sync): pending_store upsert with UNIQUE merge (PR 2/7)"
```

---

### Task 3: backoff 스케줄 (TDD)

**Files:**
- Modify: `src-tauri/src/calendar/pending_store.rs`

- [ ] **Step 1: 실패 테스트 추가**

```rust
#[test]
fn backoff_delay_progression() {
    assert_eq!(backoff_ms_for_attempt(0), 1_000);
    assert_eq!(backoff_ms_for_attempt(1), 3_000);
    assert_eq!(backoff_ms_for_attempt(2), 9_000);
}

#[test]
fn backoff_terminal_after_three() {
    assert!(is_terminal_attempt(3));
    assert!(!is_terminal_attempt(2));
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd src-tauri && cargo test --lib backoff`
Expected: FAIL (미정의).

- [ ] **Step 3: 최소 구현**

```rust
pub fn backoff_ms_for_attempt(attempt: i32) -> i64 {
    match attempt {
        0 => 1_000,
        1 => 3_000,
        _ => 9_000,
    }
}

pub fn is_terminal_attempt(attempt: i32) -> bool {
    attempt >= 3
}
```

- [ ] **Step 4: 테스트 통과**

Run: `cd src-tauri && cargo test --lib backoff`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/calendar/pending_store.rs
git commit -m "feat(sync): backoff schedule (PR 2/7)"
```

---

### Task 4: staged skip + due 행 fetch (TDD)

**Files:**
- Modify: `src-tauri/src/calendar/pending_store.rs`

- [ ] **Step 1: 테스트**

```rust
#[tokio::test]
async fn fetch_due_skips_staged() {
    let p = pool().await;
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO pending_calendar_writes
        (kind, target_kind, target_id, calendar_id, payload_json, next_attempt_at)
        VALUES ('patch','signal','s1','cal',?,?)")
        .bind(r#"{"staged":true}"#).bind(&now).execute(&p).await.unwrap();
    sqlx::query("INSERT INTO pending_calendar_writes
        (kind, target_kind, target_id, calendar_id, payload_json, next_attempt_at)
        VALUES ('patch','signal','s2','cal',?,?)")
        .bind(r#"{}"#).bind(&now).execute(&p).await.unwrap();
    let due = fetch_due_writes(&p).await.unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].target_id, "s2");
}
```

- [ ] **Step 2: 실패 확인 → 구현**

```rust
pub async fn fetch_due_writes(pool: &SqlitePool) -> sqlx::Result<Vec<PendingWrite>> {
    sqlx::query_as::<_, PendingWrite>(
        r#"SELECT * FROM pending_calendar_writes
           WHERE next_attempt_at <= datetime('now')
             AND json_extract(payload_json, '$.staged') IS NOT 1
           ORDER BY next_attempt_at ASC LIMIT 32"#,
    ).fetch_all(pool).await
}
```

- [ ] **Step 3: PASS 확인 + 커밋**

```bash
cd src-tauri && cargo test --lib pending_store
git add src-tauri/src/calendar/pending_store.rs
git commit -m "feat(sync): fetch_due_writes skips staged (PR 2/7)"
```

---

### Task 5: 실패 처리 — record_failure (TDD)

**Files:**
- Modify: `src-tauri/src/calendar/pending_store.rs`

- [ ] **Step 1: 테스트**

```rust
#[tokio::test]
async fn record_failure_updates_attempts_and_next() {
    let p = pool().await;
    let id = upsert_write(&p, "patch", "signal", "s1", "cal", None, "{}", 0).await.unwrap();
    record_failure(&p, id, "boom").await.unwrap();
    let row: (i32, Option<String>) = sqlx::query_as(
        "SELECT attempts, last_error FROM pending_calendar_writes WHERE id=?"
    ).bind(id).fetch_one(&p).await.unwrap();
    assert_eq!(row.0, 1);
    assert_eq!(row.1.as_deref(), Some("boom"));
}
```

- [ ] **Step 2: 구현**

```rust
pub async fn record_failure(pool: &SqlitePool, id: i64, err: &str) -> sqlx::Result<()> {
    let row: (i32,) = sqlx::query_as(
        "SELECT attempts FROM pending_calendar_writes WHERE id=?"
    ).bind(id).fetch_one(pool).await?;
    let next_attempts = row.0 + 1;
    let backoff = backoff_ms_for_attempt(row.0);
    let next_at = (Utc::now() + Duration::milliseconds(backoff)).to_rfc3339();
    sqlx::query(
        "UPDATE pending_calendar_writes
         SET attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?"
    ).bind(next_attempts).bind(next_at).bind(err).bind(id).execute(pool).await?;
    Ok(())
}

pub async fn delete_write(pool: &SqlitePool, id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM pending_calendar_writes WHERE id=?")
        .bind(id).execute(pool).await?;
    Ok(())
}
```

- [ ] **Step 3: PASS + 커밋**

```bash
cd src-tauri && cargo test --lib pending_store
git add src-tauri/src/calendar/
git commit -m "feat(sync): record_failure + delete_write (PR 2/7)"
```

---

### Task 6: sync 워커 모듈 구조

**Files:**
- Create: `src-tauri/src/calendar/sync.rs`
- Modify: `src-tauri/src/calendar/mod.rs`

- [ ] **Step 1: 모듈 스켈레톤**

```rust
use std::sync::Arc;
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{interval, Duration};

use crate::calendar::{
    pending_store::{delete_write, fetch_due_writes, record_failure, is_terminal_attempt},
    oauth::access_token_for_calendar,
    http::{CalendarHttpProvider, CalendarWrite, EventInput},
};
use crate::models::pending_write::PendingWrite;

pub struct SyncEngine {
    pool: SqlitePool,
    app: AppHandle,
    notify: Arc<Notify>,
}

impl SyncEngine {
    pub fn new(pool: SqlitePool, app: AppHandle) -> (Self, Arc<Notify>) {
        let notify = Arc::new(Notify::new());
        (Self { pool, app, notify: notify.clone() }, notify)
    }

    pub fn spawn(self) {
        tokio::spawn(async move { self.run().await });
    }

    async fn run(self) {
        let mut tick = interval(Duration::from_millis(200));
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = self.notify.notified() => {}
            }
            if let Err(e) = self.flush_once().await {
                tracing::warn!(error = ?e, "sync flush_once failed");
            }
        }
    }

    async fn flush_once(&self) -> anyhow::Result<()> {
        let due = fetch_due_writes(&self.pool).await?;
        for w in due {
            self.process(w).await;
        }
        Ok(())
    }

    async fn process(&self, w: PendingWrite) {
        let result = self.execute(&w).await;
        match result {
            Ok(()) => {
                let _ = delete_write(&self.pool, w.id).await;
                let _ = self.app.emit("CalendarSyncFlushed", w.id);
            }
            Err(err) => {
                let _ = record_failure(&self.pool, w.id, &err.to_string()).await;
                if is_terminal_attempt(w.attempts + 1) {
                    let _ = self.app.emit("CalendarSyncFailed",
                        serde_json::json!({"pending_id": w.id, "error": err.to_string()}));
                }
            }
        }
    }

    async fn execute(&self, w: &PendingWrite) -> anyhow::Result<()> {
        let access = access_token_for_calendar(&self.pool, &w.calendar_id).await?;
        let provider = CalendarHttpProvider::default();
        let input: EventInput = serde_json::from_str(&w.payload_json)?;
        match w.kind.as_str() {
            "create" => {
                let (event_id, _url) = provider.create_event(&access, &w.calendar_id, &input).await?;
                self.link_back(w, &event_id).await?;
            }
            "patch"  => {
                let event_id = w.event_id.as_deref().ok_or_else(|| anyhow::anyhow!("patch without event_id"))?;
                provider.patch_event(&access, &w.calendar_id, event_id, &input).await?;
            }
            "delete" => {
                let event_id = w.event_id.as_deref().ok_or_else(|| anyhow::anyhow!("delete without event_id"))?;
                provider.delete_event(&access, &w.calendar_id, event_id).await?;
                self.unlink(w).await?;
            }
            _ => anyhow::bail!("unknown kind {}", w.kind),
        }
        Ok(())
    }

    async fn link_back(&self, w: &PendingWrite, event_id: &str) -> anyhow::Result<()> {
        match w.target_kind.as_str() {
            "signal" => {
                sqlx::query("UPDATE signals SET linked_event_id=?, linked_calendar_id=? WHERE id=?")
                    .bind(event_id).bind(&w.calendar_id).bind(&w.target_id)
                    .execute(&self.pool).await?;
            }
            "routine_check" => {
                let parts: Vec<&str> = w.target_id.split('|').collect();
                if parts.len() == 2 {
                    sqlx::query("UPDATE routine_check SET linked_event_id=?, linked_calendar_id=? WHERE routine_id=? AND date=?")
                        .bind(event_id).bind(&w.calendar_id).bind(parts[0]).bind(parts[1])
                        .execute(&self.pool).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    async fn unlink(&self, w: &PendingWrite) -> anyhow::Result<()> {
        match w.target_kind.as_str() {
            "signal" => {
                sqlx::query("UPDATE signals SET linked_event_id=NULL, linked_calendar_id=NULL, scheduled_at=NULL, scheduled_duration=NULL WHERE id=?")
                    .bind(&w.target_id).execute(&self.pool).await?;
            }
            "routine_check" => {
                let parts: Vec<&str> = w.target_id.split('|').collect();
                if parts.len() == 2 {
                    sqlx::query("UPDATE routine_check SET linked_event_id=NULL, linked_calendar_id=NULL, time_override=NULL WHERE routine_id=? AND date=?")
                        .bind(parts[0]).bind(parts[1]).execute(&self.pool).await?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}
```

- [ ] **Step 2: `mod.rs`에 `pub mod sync;` 추가, `lib.rs`에서 부팅 시 spawn**

`lib.rs` setup 훅에 (pool과 app 핸들 확보 후):

```rust
let (engine, notify) = crate::calendar::sync::SyncEngine::new(pool.clone(), app.handle().clone());
app.manage(notify);  // IPC 커맨드가 nudge할 때 사용
engine.spawn();
```

- [ ] **Step 3: 빌드**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo build
```
Expected: 컴파일 성공.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/calendar/sync.rs src-tauri/src/calendar/mod.rs src-tauri/src/lib.rs
git commit -m "feat(sync): SyncEngine worker scaffold (PR 2/7)"
```

---

### Task 7: IPC — stage_calendar_write 커맨드

**Files:**
- Create: `src-tauri/src/commands/calendar_sync.rs`
- Modify: `src-tauri/src/lib.rs` (invoke_handler 등록)

- [ ] **Step 1: 커맨드 작성**

```rust
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tokio::sync::Notify;
use sqlx::SqlitePool;

use crate::calendar::pending_store::upsert_write;
use crate::error::AppError;
use crate::models::pending_write::PendingWrite;

#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WriteTarget {
    Signal { id: String },
    RoutineCheck { routine_id: String, date: String },
}

#[derive(Debug, Deserialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WriteOp {
    Schedule    { at: String, duration_min: i32, calendar_id: String, title: String },
    Reschedule  { at: String, duration_min: i32 },
    Resize      { duration_min: i32 },
    Unschedule,
    MoveCalendar { calendar_id: String, at: String, duration_min: i32, title: String },
    CreateBlank { title: String, at: String, duration_min: i32, calendar_id: String },
}

#[derive(Debug, Deserialize, Type)]
pub struct StageWriteRequest {
    pub target: WriteTarget,
    pub op: WriteOp,
    pub idempotency_key: String,
}

#[tauri::command]
#[specta::specta]
pub async fn stage_calendar_write(
    req: StageWriteRequest,
    pool: State<'_, SqlitePool>,
    notify: State<'_, Arc<Notify>>,
) -> Result<(), AppError> {
    let (target_kind, target_id) = match &req.target {
        WriteTarget::Signal { id } => ("signal", id.clone()),
        WriteTarget::RoutineCheck { routine_id, date } => ("routine_check", format!("{routine_id}|{date}")),
    };

    let (kind, calendar_id, event_id_opt, payload, debounce_ms) = build_queue_row(&req, &pool, target_kind, &target_id).await?;

    upsert_write(&pool, kind, target_kind, &target_id, &calendar_id,
                 event_id_opt.as_deref(), &payload, debounce_ms).await?;
    notify.notify_one();
    Ok(())
}

async fn build_queue_row(
    req: &StageWriteRequest,
    pool: &SqlitePool,
    target_kind: &str,
    target_id: &str,
) -> Result<(&'static str, String, Option<String>, String, i64), AppError> {
    let existing_event = fetch_linked_event(pool, target_kind, target_id).await?;
    match &req.op {
        WriteOp::Schedule { at, duration_min, calendar_id, title } => {
            let payload = serde_json::json!({"title": title, "start": at, "duration_min": duration_min}).to_string();
            Ok(("create", calendar_id.clone(), None, payload, 800))
        }
        WriteOp::Reschedule { at, duration_min } => {
            let (cal, ev) = existing_event.ok_or_else(|| AppError::bad_request("no linked event"))?;
            let payload = serde_json::json!({"start": at, "duration_min": duration_min}).to_string();
            Ok(("patch", cal, Some(ev), payload, 800))
        }
        WriteOp::Resize { duration_min } => {
            let (cal, ev) = existing_event.ok_or_else(|| AppError::bad_request("no linked event"))?;
            let payload = serde_json::json!({"duration_min": duration_min}).to_string();
            Ok(("patch", cal, Some(ev), payload, 800))
        }
        WriteOp::Unschedule => {
            let (cal, ev) = existing_event.ok_or_else(|| AppError::bad_request("no linked event"))?;
            Ok(("delete", cal, Some(ev), "{}".into(), 800))
        }
        WriteOp::MoveCalendar { calendar_id, at, duration_min, title } => {
            let payload = serde_json::json!({"title": title, "start": at, "duration_min": duration_min, "staged": true}).to_string();
            Ok(("create", calendar_id.clone(), None, payload, 0))
        }
        WriteOp::CreateBlank { title, at, duration_min, calendar_id } => {
            let payload = serde_json::json!({"title": title, "start": at, "duration_min": duration_min}).to_string();
            Ok(("create", calendar_id.clone(), None, payload, 800))
        }
    }
}

async fn fetch_linked_event(pool: &SqlitePool, target_kind: &str, target_id: &str)
    -> Result<Option<(String, String)>, AppError>
{
    match target_kind {
        "signal" => {
            let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT linked_calendar_id, linked_event_id FROM signals WHERE id=?"
            ).bind(target_id).fetch_optional(pool).await?;
            Ok(row.and_then(|(c, e)| match (c, e) { (Some(c), Some(e)) => Some((c, e)), _ => None }))
        }
        "routine_check" => {
            let parts: Vec<&str> = target_id.split('|').collect();
            if parts.len() != 2 { return Ok(None); }
            let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT linked_calendar_id, linked_event_id FROM routine_check WHERE routine_id=? AND date=?"
            ).bind(parts[0]).bind(parts[1]).fetch_optional(pool).await?;
            Ok(row.and_then(|(c, e)| match (c, e) { (Some(c), Some(e)) => Some((c, e)), _ => None }))
        }
        _ => Ok(None),
    }
}
```

- [ ] **Step 2: `lib.rs` invoke_handler 등록**

```rust
.invoke_handler(tauri::generate_handler![
    // ... 기존 ...
    commands::calendar_sync::stage_calendar_write,
    commands::calendar_sync::commit_staged_writes,
    commands::calendar_sync::cancel_pending_write,
    commands::calendar_sync::list_pending_writes,
])
```

- [ ] **Step 3: 빌드**

```bash
cd src-tauri && cargo build
```
Expected: 성공.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/commands/calendar_sync.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): stage_calendar_write command (PR 2/7)"
```

---

### Task 8: 나머지 3개 IPC 커맨드

**Files:**
- Modify: `src-tauri/src/commands/calendar_sync.rs`

- [ ] **Step 1: 추가 작성**

```rust
#[tauri::command]
#[specta::specta]
pub async fn commit_staged_writes(
    ids: Vec<i64>,
    pool: State<'_, SqlitePool>,
    notify: State<'_, Arc<Notify>>,
) -> Result<(), AppError> {
    use chrono::Utc;
    let now = Utc::now().to_rfc3339();
    for id in ids {
        sqlx::query(
            "UPDATE pending_calendar_writes
             SET payload_json = json_remove(payload_json, '$.staged'),
                 next_attempt_at = ?
             WHERE id = ?"
        ).bind(&now).bind(id).execute(pool.inner()).await?;
    }
    notify.notify_one();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_pending_write(id: i64, pool: State<'_, SqlitePool>) -> Result<(), AppError> {
    crate::calendar::pending_store::delete_write(&pool, id).await?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_pending_writes(pool: State<'_, SqlitePool>) -> Result<Vec<PendingWrite>, AppError> {
    let rows = sqlx::query_as::<_, PendingWrite>(
        "SELECT * FROM pending_calendar_writes ORDER BY created_at DESC"
    ).fetch_all(pool.inner()).await?;
    Ok(rows)
}
```

- [ ] **Step 2: 빌드 + 클리피**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo clippy --all-targets -- -D warnings
```
Expected: 통과.

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/src/commands/calendar_sync.rs
git commit -m "feat(ipc): commit/cancel/list pending writes (PR 2/7)"
```

---

### Task 9: bindings 재생성 + 통합 검증 + push

- [ ] **Step 1: bindings**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib export_bindings 2>/dev/null || cargo build
```

- [ ] **Step 2: 통합 검증**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && pnpm lint
```
Expected: 모두 통과.

- [ ] **Step 3: push**

```bash
git push origin dev
```

## 자체 검증

- ✅ Spec §6.1 UPSERT 머지 + 디바운스 800ms
- ✅ Spec §6.1 backoff [1s,3s,9s] + 3회 terminal
- ✅ Spec §6.2 staged skip
- ✅ Spec §5.1 4개 IPC 커맨드
- ✅ Spec §6.4 이벤트 emit (CalendarSyncFailed, CalendarSyncFlushed)
- ✅ INVARIANT: 외부 호출 Rust only, bounded retry, AppError envelope
