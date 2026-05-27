# agent_run_store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent_runs`+`acceptances` SQL을 단일 소유 `commands/agent_run_store.rs`로 캡슐화한다 (백로그 F, agent_runs 슬라이스). 동작·IPC 표면 무변경.

**Architecture:** signal_store와 동일 패턴 — `pub(crate)` free fn 모듈로 verbatim 이전. `jobs.rs`는 `JobManager` 런타임만 보유하고 store를 호출. `agents/*` 커맨드는 `#[tauri::command]` 셸 유지, SQL만 위임. 게이트(acceptances+agent_runs UPDATE)는 store의 named fn에 모여 INVARIANT #2 단일 감사 지점.

**Tech Stack:** Rust, sqlx 0.8 (SQLite), tauri-specta, tokio. 검증: `cargo clippy`/`cargo test` (rtk proxy), `pnpm typecheck/test/build`.

---

## 실행 규칙 (모든 Task 공통)

- **환경:** cargo 전 `export PATH="$HOME/.cargo/bin:$PATH"`. 검증은 `rtk proxy cargo ...`(rtk 래핑 cargo는 출력 부정확). 파일 확인은 Read 도구.
- **브랜치:** `refactor/agent-run-store` (이미 생성됨, 스펙 커밋 `56b0260` 위). 작업·push는 dev만(ff-merge는 마지막에).
- **순수 이전 불변식:** 함수 본문/시그니처/SQL 문자열/에러 타입을 **바꾸지 않는다**. 바뀌는 것은 (a) 위치, (b) 가시성(`pub(super)`/priv → `pub(crate)`), (c) import 경로, (d) §Task 2의 명시적 dedup 2건뿐.
- **각 Task 끝 검증:** `rtk proxy cargo build --manifest-path src-tauri/Cargo.toml` 통과 + (Task 4 전까지) **행위 보존**은 다음 Task 누적으로 확인. 최종 게이트는 Task 5.
- **bindings.ts:** 어느 Task도 IPC 표면을 바꾸지 않는다 → `cargo test` 후 `git diff --exit-code src/bindings.ts`가 비어야 한다.

---

## 파일 구조

- **Create:** `src-tauri/src/commands/agent_run_store.rs` — agent_runs+acceptances 단일 소유 store.
- **Modify:** `src-tauri/src/commands/mod.rs` — `pub mod agent_run_store;` 선언 추가.
- **Modify:** `src-tauri/src/jobs.rs` — 영속 fn 제거, `JobManager`만 잔류, store 호출.
- **Modify:** `src-tauri/src/commands/agents/mod.rs` — 영속 fn 제거/위임, dedup.
- **Modify:** `src-tauri/src/commands/agents/selfcheck.rs` — 게이트 write를 store로 위임.
- **Modify:** `src-tauri/src/commands/agents/{enrich,triage}.rs` — store 경로로 호출(`super::` → `crate::commands::agent_run_store::`).

> 참고 precedent: `src-tauri/src/commands/signal_store.rs` (동일 모듈 구조·테스트 스타일).

---

## Task 1: store 모듈 생성 + jobs.rs 영속 이전

**Files:**

- Create: `src-tauri/src/commands/agent_run_store.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/jobs.rs`

- [ ] **Step 1: 모듈 선언 추가**

`src-tauri/src/commands/mod.rs`에서 `signal_store` 선언 옆에 알파벳 순서로 추가:

```rust
pub mod agent_run_store;
```

(정확한 형식은 기존 `pub mod signal_store;` 라인과 동일하게 맞춘다.)

- [ ] **Step 2: store 파일 헤더 + jobs.rs 영속 fn 이전**

`agent_run_store.rs`를 생성하고, `jobs.rs`에서 아래 항목을 **본문 그대로** 잘라 옮긴다(verbatim):

이전 대상(jobs.rs → agent_run_store.rs):

- `struct AgentRunRecord` (sqlx::FromRow)
- `fn detail_from_result(result: &Option<String>) -> Option<String>` → store-private (`fn`, 비공개 유지)
- `impl From<AgentRunRecord> for AgentRunView`
- `fn insert_agent_run` → `pub(crate)` (이미 pub였으면 `pub(crate)`로)
- `fn fetch_agent_runs` → `pub(crate)`
- `fn fetch_log_tail` → `pub(crate)`
- `fn mark_running` → `pub(crate)` (기존 priv `async fn`)
- `fn finalize` → `pub(crate)` (기존 priv `async fn`)
- `fn mark_cancelled_in_queue` → `pub(crate)` (기존 priv `async fn`)

파일 헤더:

```rust
//! agent_runs / acceptances 테이블 데이터 접근 레이어(백로그 F). 모든 agent_runs SQL의 단일 소유자.
//! Approach A: 커맨드·런타임에서 verbatim 이전 — 동작 무변경. jobs.rs는 JobManager 런타임만 보유.

use crate::agent::{AgentError, AgentOutcome};
use crate::db::Db;
use crate::models::{AgentRunView, AgentStatus, Engine, AgentRail, Sandbox};
use crate::jobs::NewAgentRun;
use serde_json::json;
```

> import은 옮긴 함수들이 실제로 쓰는 심볼에 맞춰 조정한다(`NewAgentRun`은 jobs.rs에 잔류하므로 `use crate::jobs::NewAgentRun;`). 컴파일 에러가 가리키는 대로 정확히 맞춘다. 불필요 import는 넣지 않는다(clippy).

- [ ] **Step 3: jobs.rs를 store 호출로 배선**

`jobs.rs`에서 위 fn들의 정의를 제거하고, `JobManager`/`spawn`/`mark_running`/`finalize`/`mark_cancelled_in_queue` 호출부를 store 경로로 바꾼다. `spawn` 클로저 내부 호출 예:

```rust
// 변경 전: mark_running(&db, &run_id).await;
// 변경 후:
crate::commands::agent_run_store::mark_running(&db, &run_id).await;
```

동일하게 `finalize(...)` → `crate::commands::agent_run_store::finalize(...)`,
`mark_cancelled_in_queue(...)` → `crate::commands::agent_run_store::mark_cancelled_in_queue(...)`.

`jobs.rs` 상단 import에서 store로 떠난 심볼(`json!` 등)이 더 이상 안 쓰이면 제거(clippy). `NewAgentRun`, `Bounds`, `JobManager`가 쓰는 심볼은 잔류. `AgentStatus`는 store로 떠났으면 jobs.rs에서 제거(단, jobs.rs 테스트가 쓰면 잔류 — Step 5에서 확인).

- [ ] **Step 4: 빌드 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 성공(에러 0). import/가시성 에러가 나면 해당 심볼 경로만 조정.

- [ ] **Step 5: jobs.rs 테스트 모듈 경로 보정**

`jobs.rs`의 `#[cfg(test)] mod tests`(insert_echo/fetch 등)가 옮긴 fn을 직접 부르면 `crate::commands::agent_run_store::`로 경로를 바꾼다. Task D에서 추가한 `agent_status_sqlx_encoding_matches_as_str` 테스트는 jobs.rs에 남겨도 되지만, `AgentStatus` import 경로가 유효한지 확인. (store로 옮길 필요 없음 — 그 테스트는 enum 인코딩 검증이라 위치 무관.)

Run: `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/wr_t1.log 2>&1; echo $?`
Expected: exit 0, **241 passed**(D 기준 동일 카운트 — 이전만 했으므로 회귀 0). Read `/tmp/wr_t1.log` 확인.

- [ ] **Step 6: bindings.ts 무변경 확인 + 커밋**

Run: `rtk proxy git diff --exit-code src/bindings.ts; echo "BINDINGS_DIFF=$?"`
Expected: `BINDINGS_DIFF=0` (비어 있음).

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo fmt --manifest-path src-tauri/Cargo.toml
rtk proxy git add -A
rtk proxy git commit -m "refactor(store): jobs.rs agent_runs 영속을 agent_run_store로 이전"
```

---

## Task 2: agents/mod.rs 영속 이전 + dedup

**Files:**

- Modify: `src-tauri/src/commands/agent_run_store.rs`
- Modify: `src-tauri/src/commands/agents/mod.rs`

- [ ] **Step 1: agents/mod.rs 영속 fn 이전**

`agents/mod.rs`에서 아래를 `agent_run_store.rs`로 verbatim 이전(가시성 `pub(crate)`):

- `new_run_id`
- `run_status_trigger` (D 결과 타입 `(AgentStatus, Option<String>)` 보존)
- `run_proposal_raw`
- `record_acceptance`

- [ ] **Step 2: dedup #1 — detail_from_result 통합**

`agents/mod.rs`의 `detail_from_result_json(result: Option<&str>) -> Option<String>`을 제거한다. store의 `detail_from_result`를 두 호출 시그니처가 다 쓰도록 통일: store에 `Option<&str>`을 받는 형태로 두고, jobs.rs From impl 호출부는 `detail_from_result(r.result.as_deref())`로 맞춘다.

store 내 단일 정의(둘 중 본문 동일 — `Option<&str>` 채택):

```rust
/// result JSON({detail|error})에서 사람이 읽을 상세를 뽑는다(jobs.rs/agents 공통).
fn detail_from_result(result: Option<&str>) -> Option<String> {
    let raw = result?;
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("detail")
        .or_else(|| v.get("error"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}
```

`From<AgentRunRecord> for AgentRunView` 내부 호출을 `detail_from_result(r.result.as_deref())`로 보정.

- [ ] **Step 3: dedup #2 — agent_run_status SQL을 store로**

store에 추가:

```rust
/// 단일 잡 폴링용 (status, result, proposal) 읽기. 커맨드(agent_run_status)가 호출.
pub(crate) async fn fetch_run_status(
    db: &Db,
    run_id: &str,
) -> Result<Option<(AgentStatus, Option<String>, Option<String>)>, sqlx::Error> {
    sqlx::query_as("SELECT status, result, proposal FROM agent_runs WHERE id = ?1")
        .bind(run_id)
        .fetch_optional(db)
        .await
}
```

`agents/mod.rs`의 `agent_run_status` 커맨드는 셸 유지, 본문을 store 호출로:

```rust
let row = crate::commands::agent_run_store::fetch_run_status(db.inner(), &run_id).await?;
let (status, result, proposal) =
    row.ok_or_else(|| AppError::not_found("agents.run_not_found", "잡을 찾을 수 없음"))?;
let detail = crate::commands::agent_run_store::detail_from_result(result.as_deref());
Ok(AgentRunStatus { status, has_proposal: proposal.is_some(), detail })
```

> `detail_from_result`는 store-private였다 → `agent_run_status`가 호출하려면 `pub(crate)`로 승격. (다른 곳에서 안 쓰면 그대로 store-private 두고 `fetch_run_status`가 detail까지 만들어 반환하는 대안도 가능 — 더 단순한 쪽 선택: store에 `pub(crate) fn detail_from_result`.)

- [ ] **Step 4: 호출부 경로 보정**

`agents/mod.rs`·`enrich.rs`·`triage.rs`·`selfcheck.rs`에서 `super::new_run_id`/`super::run_status_trigger`/`super::run_proposal_raw`/`super::record_acceptance` 호출을 `crate::commands::agent_run_store::<fn>`으로 바꾼다. (또는 `agents/mod.rs` 상단에 `use crate::commands::agent_run_store;` 후 `agent_run_store::<fn>`.)

- [ ] **Step 5: 빌드 + 테스트 + bindings**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo build --manifest-path src-tauri/Cargo.toml`
Expected: 성공.

Run: `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/wr_t2.log 2>&1; echo $?` → exit 0, 241 passed (회귀 0). Read 확인.

Run: `rtk proxy git diff --exit-code src/bindings.ts; echo "BINDINGS_DIFF=$?"` → 0.

- [ ] **Step 6: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo fmt --manifest-path src-tauri/Cargo.toml
rtk proxy git add -A
rtk proxy git commit -m "refactor(store): agents 영속(new_run_id/status/proposal/record_acceptance) + detail dedup 이전"
```

---

## Task 3: selfcheck.rs 게이트 write 위임

**Files:**

- Modify: `src-tauri/src/commands/agent_run_store.rs`
- Modify: `src-tauri/src/commands/agents/selfcheck.rs`

- [ ] **Step 1: reject_run을 store에 추가**

`selfcheck.rs::reject_proposal`의 UPDATE를 store fn으로 이전:

```rust
/// awaiting_approval 잡을 cancelled로 마감(폐기). 영향 행수 반환(0이면 가드 실패).
pub(crate) async fn reject_run(db: &Db, run_id: &str) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE agent_runs SET status = ?1, \
            result = json_object('error', '사용자가 제안을 폐기(reject)함'), \
            finished_at = COALESCE(finished_at, datetime('now')) \
         WHERE id = ?2 AND status = ?3",
    )
    .bind(AgentStatus::Cancelled)
    .bind(run_id)
    .bind(AgentStatus::AwaitingApproval)
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}
```

`reject_proposal` 커맨드는 셸 유지:

```rust
let affected = crate::commands::agent_run_store::reject_run(db.inner(), &run_id).await?;
if affected == 0 {
    return Err(AppError::validation(
        "agents.reject_wrong_status",
        "reject 가능한 상태가 아닙니다(awaiting_approval 아님).",
    ));
}
Ok(())
```

- [ ] **Step 2: execute_accept의 게이트 부분을 record_acceptance로**

`execute_accept`의 손수 acceptances INSERT + agent_runs UPDATE를 store의 `record_acceptance(db, run_id, "pr_self_check", accepted_json)` 호출로 대체한다. **`pr_self_checks` INSERT(로컬 효과)는 그대로 selfcheck에 잔류**. 즉 execute_accept는 `record_acceptance` 호출 + (trigger 있으면) pr_self_checks write로 구성된다.

> 주의: 기존 execute_accept는 acceptances INSERT를 **먼저**, pr_self_checks를 **그 다음**, agent_runs UPDATE를 **마지막**에 했다. record_acceptance는 INSERT→UPDATE 순서다. pr_self_checks를 record_acceptance **앞**에 두면 (INSERT acceptances)→(pr_self_checks)→(UPDATE)와 순서가 어긋난다. **동작 보존**을 위해 호출 순서를 `record_acceptance` → 그 다음 트랜잭션 경계가 없으므로 순서 무관하지만, 안전하게: pr_self_checks write를 먼저 하고 record_acceptance를 마지막에 호출(기존 UPDATE-last 보존). 단일 트랜잭션이 아니므로 부분 실패 시맨틱은 기존과 동일(둘 다 비-트랜잭션).

- [ ] **Step 3: accept_proposal 인라인 읽기 위임**

`accept_proposal`의 인라인 `SELECT status, trigger`(D에서 `(AgentStatus, Option<String>)`로 타입화됨)를 `crate::commands::agent_run_store::run_status_trigger`로 대체:

```rust
let (status, trigger) = crate::commands::agent_run_store::run_status_trigger(db.inner(), &run_id)
    .await
    .map_err(|e| AppError::not_found("agents.job_not_found", e))?;
super::require_awaiting(status, "agents.accept_wrong_status")?;
```

> 기존 not_found code는 `agents.job_not_found`였다 — 메시지/ code 보존. (run_status_trigger의 Err 문자열을 그대로 전달.)

- [ ] **Step 4: 빌드 + 테스트 + bindings**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo build --manifest-path src-tauri/Cargo.toml` → 성공.
Run: `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/wr_t3.log 2>&1; echo $?` → exit 0, 241 passed. Read 확인(특히 `accept_records_acceptance_and_marks_self_check`, reject 테스트 green).
Run: `rtk proxy git diff --exit-code src/bindings.ts; echo "BINDINGS_DIFF=$?"` → 0.

- [ ] **Step 5: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo fmt --manifest-path src-tauri/Cargo.toml
rtk proxy git add -A
rtk proxy git commit -m "refactor(store): selfcheck accept/reject 게이트 write를 agent_run_store로 위임"
```

---

## Task 4: store 직접 단위테스트 (genuine new — TDD)

**Files:**

- Modify: `src-tauri/src/commands/agent_run_store.rs` (`#[cfg(test)] mod tests`)

> signal_store가 직접 store 테스트 +5를 더한 선례. 게이트 fn(record_acceptance/reject_run)과 상태 전이를 store 레벨에서 직접 검증한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent_run_store.rs` 끝에 추가. `fresh_db`는 jobs.rs 테스트 패턴을 재사용(temp dir + `crate::db::init_db`).

```rust
#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_db() -> Db {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("wr-arstore-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::init_db(&dir.join("t.db")).await.unwrap()
    }

    /// awaiting_approval 한 행을 직접 삽입(픽스처).
    async fn insert_awaiting(db: &Db, id: &str) {
        sqlx::query(
            "INSERT INTO agent_runs \
                (id, engine, kind, rail, sandbox, status, timeout_sec, max_turns, cost_cap_usd) \
             VALUES (?1, 'codex', 'draft_pr_selfcheck', 'suggestion', 'read_only', \
                     'awaiting_approval', 60, 8, 1.0)",
        )
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    }

    /// record_acceptance: awaiting_approval → succeeded + acceptances 1행. 외부 호출 없음(로컬).
    #[tokio::test]
    async fn record_acceptance_marks_succeeded_and_appends_row() {
        let db = fresh_db().await;
        insert_awaiting(&db, "r1").await;
        record_acceptance(&db, "r1", "pr_self_check", r#"{"summary":"x"}"#)
            .await
            .unwrap();
        let st: (AgentStatus,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, AgentStatus::Succeeded);
        let cnt: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM acceptances WHERE agent_run_id='r1'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(cnt.0, 1);
    }

    /// record_acceptance는 awaiting_approval이 아니면 상태를 바꾸지 않는다(게이트 CAS — INVARIANT #2).
    #[tokio::test]
    async fn record_acceptance_no_op_when_not_awaiting() {
        let db = fresh_db().await;
        // proposed 상태로 삽입(기본 default).
        sqlx::query(
            "INSERT INTO agent_runs (id, engine, kind, rail, sandbox, timeout_sec, max_turns, cost_cap_usd) \
             VALUES ('r2','codex','k','suggestion','read_only',60,8,1.0)",
        )
        .execute(&db)
        .await
        .unwrap();
        record_acceptance(&db, "r2", "pr_self_check", "{}").await.unwrap();
        let st: (AgentStatus,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r2'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, AgentStatus::Proposed, "게이트: awaiting_approval만 succeeded로 전이");
    }

    /// reject_run: awaiting_approval → cancelled, 영향 행수 1. 비-awaiting이면 0(가드).
    #[tokio::test]
    async fn reject_run_cancels_only_awaiting() {
        let db = fresh_db().await;
        insert_awaiting(&db, "r3").await;
        let n = reject_run(&db, "r3").await.unwrap();
        assert_eq!(n, 1);
        let st: (AgentStatus,) = sqlx::query_as("SELECT status FROM agent_runs WHERE id='r3'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(st.0, AgentStatus::Cancelled);
        // 두 번째 reject은 0행(이미 cancelled).
        let n2 = reject_run(&db, "r3").await.unwrap();
        assert_eq!(n2, 0);
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib agent_run_store > /tmp/wr_t4.log 2>&1; echo $?`
Expected: 컴파일은 통과(fn은 이미 존재), 테스트 PASS. (이 fn들은 Task 1~3에서 이미 구현됨 → red 단계가 없다. 만약 컴파일 에러면 픽스처 SQL의 컬럼/가시성 보정.)

> 주: 순수 이전이라 대상 fn이 이미 존재 → 전통적 red→green이 아니라 "행위 잠금" 테스트다. 컬럼명/제약은 `migrations/0001_init.sql`의 agent_runs/acceptances 정의와 일치해야 한다(`acceptances`: id, agent_run_id, accepted_fields, target).

- [ ] **Step 3: green 확인 + 전체 카운트**

Run: `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/wr_t4_all.log 2>&1; echo $?`
Expected: exit 0, **244 passed**(241 + store 3). Read 확인.

- [ ] **Step 4: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo fmt --manifest-path src-tauri/Cargo.toml
rtk proxy git add -A
rtk proxy git commit -m "test(store): agent_run_store 게이트 fn 직접 단위테스트(record_acceptance/reject_run)"
```

---

## Task 5: 최종 검증 게이트 + critic + 머지

**Files:**

- Modify: `docs/decisions.md`

- [ ] **Step 1: 전체 검증 번들**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings > /tmp/wr_clippy.log 2>&1; echo "CLIPPY=$?"
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/wr_test.log 2>&1; echo "TEST=$?"
rtk proxy git diff --exit-code src/bindings.ts; echo "BINDINGS=$?"
rtk proxy pnpm typecheck > /tmp/wr_tsc.log 2>&1; echo "TSC=$?"
rtk proxy pnpm test > /tmp/wr_fe.log 2>&1; echo "FE=$?"
rtk proxy pnpm build > /tmp/wr_build.log 2>&1; echo "BUILD=$?"
```

Expected: CLIPPY=0(로그에 warning 0), TEST=0(244 passed), BINDINGS=0(빈 diff = 순수 이전 증명), TSC=0, FE=0, BUILD=0. 각 로그 Read로 교차검증.

- [ ] **Step 2: SQL 잔류 확인 (store가 진짜 단일 소유자인가)**

Run: `rtk proxy grep -rn "FROM agent_runs\|INTO agent_runs\|UPDATE agent_runs\|INTO acceptances" src/jobs.rs src/commands/agents`
Expected: **테스트 픽스처(`#[cfg(test)]`) 외에 0건**. 비-테스트 잔류가 있으면 store로 이전 누락 → 보정.

- [ ] **Step 3: critic 패스 (self-approve 금지 — 게이트 변경)**

`oh-my-claudecode:critic` 에이전트에 diff(`git diff dev...HEAD`)를 주고 INVARIANT #1/#2/#5 보존 + 순수 이전(행위 무변경) 확인 요청. ACCEPT 전엔 머지 금지. REJECT면 지적사항 반영 후 재검증.

- [ ] **Step 4: decisions.md 한 줄 + 커밋**

`docs/decisions.md` "품질 후속" 섹션 D 항목 다음에 추가:

```markdown
- **(2026-05-23, 백로그 F-2) `agent_run_store` 추출**(`commands/agent_run_store.rs` 신설): jobs.rs(영속)·agents/\*(게이트 write)에 흩어진 agent_runs+acceptances SQL을 단일 소유 store로 verbatim 이전(signal_store 패턴). jobs.rs는 JobManager 런타임만 잔류. dedup 2건(detail_from_result 중복, execute_accept의 acceptances INSERT→record_acceptance 재사용). 게이트 SQL이 store named fn(record_acceptance/reject_run/finalize)에 모여 INVARIANT #2 단일 감사 지점. 행위 보존: bindings.ts 무변경 + clippy 0 + test 244(게이트 직접테스트 +3) + typecheck/test/build green. critic ACCEPT. 트레이드오프: 게이트 SQL이 호출부에서 한 단계 멀어짐(단일 소유와 교환). pr_self_checks(pr_radar aggregate)·signals(signal_store) write는 미이전.
```

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy git add docs/decisions.md
rtk proxy git commit -m "docs(decisions): agent_run_store 추출(백로그 F-2) 기록"
```

- [ ] **Step 5: dev로 ff-merge + push + 브랜치 삭제**

```bash
rtk proxy git checkout dev
rtk proxy git merge --ff-only refactor/agent-run-store
rtk proxy git push origin dev
rtk proxy git branch -d refactor/agent-run-store
```

Expected: ff-merge 성공, push 성공.

- [ ] **Step 6: 후속 상태 갱신**

`docs/plans/2026-05-23-quality-followups-remaining.md`에서 F가 부분 진행(agent_runs 슬라이스 done)임을 한 줄 갱신, 다음 store(routine_store) 또는 G 선택지를 남긴다.

---

## Self-Review 메모 (작성자 체크 결과)

- **Spec coverage:** §3 인벤토리 전 항목 → Task 1(jobs)/2(agents mod)/3(selfcheck)로 매핑. §4 API → 각 fn이 Task에 등장. §6 done-criteria → Task 5 검증 번들. §3.4 dedup 2건 → Task 2 Step 2 + Task 3 Step 2. §7 트랜잭션 비-변경 주의 → Task 3 Step 2 노트.
- **Placeholder scan:** 없음(이전 대상은 함수명+파일로 명시, 신규 코드/테스트는 전체 수록).
- **Type consistency:** `run_status_trigger`/`fetch_run_status` 반환 `(AgentStatus, ...)` D 결과와 일치. `reject_run -> Result<u64, sqlx::Error>`로 Task 3 정의·Task 4 사용 일치. `record_acceptance(db, run_id, target, json)` 시그니처 Task 2/3/4 동일.
- **순수 이전 리스크:** 라인 번호 대신 함수명 기준 이전(D 편집으로 라인 드리프트). 컴파일러/clippy/bindings-diff가 누락·표면변경을 잡는다.
