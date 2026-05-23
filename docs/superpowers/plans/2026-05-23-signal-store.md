# signal_store (백로그 F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 정본: 설계 `docs/superpowers/specs/2026-05-23-signal-store-design.md` · 규칙 `AGENTS.md`/`PLAN.md §1` · 명령 `docs/reference/commands.md`.

**Goal:** `signals`/`signals_fts` 테이블 SQL을 단일 `commands/signal_store.rs`로 모아(verbatim relocation) 커맨드는 위임만 하게 한다 — 백로그 G(테이블 분리)의 변경 표면을 축소.

**Architecture:** Approach A(그대로 이전). 모든 signals-primary 쿼리를 `signal_store`의 `pub(crate) async fn`로 이전(동일 SQL·시그니처·반환타입). 교차 집계의 비-signals 부분·로직 결합 루프(auto_resolve)는 커맨드에 잔류하고 store fn 호출. **동작 변경/스키마 변경 없음.**

**Tech Stack:** Rust, sqlx 0.8 (SQLite), tauri-specta(bindings). 테스트는 in-memory SQLite(`fresh_db()`).

**원자성:** 단일 브랜치 `refactor/signal-store`, 모듈별 커밋(bisectable), 최종 1회 `--ff-only` dev 머지. (사용자 결정: signal_store "한 번에 전부".)

---

## 세션 시작 (다음 세션이 이 파일만 보고 시작)

- 자동 로드: `CLAUDE.md`→`AGENTS.md`→메모리(`MEMORY.md`). 추가로 읽을 정본: 이 플랜 + spec(`docs/superpowers/specs/2026-05-23-signal-store-design.md`) + `PLAN.md §1`(INVARIANTS).
- 베이스라인: 시작 전 `git fetch && git checkout dev` 후 **clean `origin/dev` 기준**에서 `refactor/signal-store` 분기(stale 로컬에서 분기 금지). 이 플랜 작성 시점 dev = `2744fbe`.

## 실행 프로토콜 (모든 태스크 공통 — 반드시)

- **순차 실행 · 단일 writer (이 레포 필수).** `isolation:worktree` / 병렬 백그라운드 에이전트 **금지** — 이 레포에서 두 번 메인 트리·`dev`를 오염시킨 전례(공유 허브파일 `lib.rs`/`models.rs`/`bindings.ts` + 단일 dev). 위임은 **단일·순차 executor가 미커밋 구현 → 오케스트레이터만 검증·critic·커밋**. (배경: `decisions.md` "운영 결정", 메모리 `work-radar-parallel-worktree-contaminates`.)
- cargo/커밋 전: `export PATH="$HOME/.cargo/bin:$PATH"` (husky pre-commit = `cargo fmt --check`+`tsc`).
- clippy/test는 rtk 출력이 부정확하므로 `rtk proxy cargo ... > /tmp/x.log 2>&1` 후 **Read 도구**로 확인.
- **행위 보존 증명(매 모듈 태스크 필수):** `cargo test`가 `src/bindings.ts`를 재생성 → `git diff --exit-code src/bindings.ts`가 **빈값**이어야 함(IPC 표면 동일). 비면 커맨드 시그니처가 바뀐 것 → 되돌린다.
- 위임 후 늦은 쓰기 주의: 커밋/다음 태스크 전 `git status --short`.
- **결정 레일/Acceptance 무관**하지만 INVARIANT #1/#3/#7 보존이 핵심 → 최종 critic 패스(self-approve 금지).

### Relocation 규칙 (각 store fn 작성 시)
1. 원본 `sqlx::query*(...)` 블록의 **SQL 문자열을 한 글자도 바꾸지 않고** signal_store fn 본문으로 옮긴다.
2. 반환타입 보존: 원본이 `Result<_, sqlx::Error>`면 store fn도 그대로. 원본이 `AppError`를 반환하던 커맨드면, **store fn은 `sqlx::Error`를 반환**하고 커맨드가 기존처럼 `?`/`map_err(AppError::from)`로 변환(커맨드 시그니처 무변경).
3. `WorkSignal` 매핑 쿼리는 `SIGNAL_COLS` + `query_as::<_, WorkSignal>`를 그대로 사용(이제 `signal_store::SIGNAL_COLS`).
4. 커맨드 본문은 `signal_store::fn(db, ...)` 호출로 대체. `#[tauri::command]`/`#[specta::specta]`/시그니처는 **무변경**.

---

## File Structure

- **Create:** `src-tauri/src/commands/signal_store.rs` — `pub(crate)` free fn + `pub(crate) const SIGNAL_COLS`. signals/signals_fts 접근 단일 소유자.
- **Modify:** `commands/mod.rs`(`mod signal_store;` 등록), `commands/shared.rs`(SIGNAL_COLS 제거), 그리고 소비자 10개: `signals.rs`, `today/rail.rs`, `today/overview.rs`, `today/weekly.rs`, `pr_radar.rs`, `notion.rs`, `projects.rs`, `agents/enrich.rs`, `agents/triage.rs`, `retro.rs`.
- **Tests:** signal_store 직접 단위테스트는 `signal_store.rs` 내 `#[cfg(test)] mod tests`. 기존 모듈 테스트 픽스처(테스트 내 인라인 signals SQL)는 **그대로 둔다**(테스트 헬퍼는 store 경유 불요 — 행위 검증만).

---

## Task 0: 브랜치 + signal_store 스켈레톤 + SIGNAL_COLS 이전

**Files:** Create `src-tauri/src/commands/signal_store.rs`; Modify `commands/mod.rs`, `commands/shared.rs` + (SIGNAL_COLS 소비 6파일).

- [ ] **Step 1:** `export PATH="$HOME/.cargo/bin:$PATH"; git checkout -b refactor/signal-store`
- [ ] **Step 2:** `signal_store.rs` 생성, 모듈 doc + SIGNAL_COLS 이전:

```rust
//! signals / signals_fts 테이블 데이터 접근 레이어(백로그 F). 모든 signals SQL의 단일 소유자.
//! Approach A: 커맨드에서 verbatim 이전 — 동작 무변경. 백로그 G(테이블 분리)는 이 모듈만 바꾼다.

use crate::db::Db;
use crate::models::WorkSignal;

/// signals 행 → WorkSignal 매핑 컬럼 목록(기존 shared.rs에서 이전).
pub(crate) const SIGNAL_COLS: &str =
    "id, project_id, title, body, source, type, quadrant, suggested_quadrant, \
     kind, area, suggested_area, status, snooze_until, today_for_date, today_done_at, today_rank, \
     impact_high, regret, created_at, updated_at";
```

- [ ] **Step 3:** `commands/mod.rs`에 `mod signal_store;` 추가(알파벳 순 위치). 필요 시 `pub(crate) use signal_store;`는 두지 않음 — 소비자는 `crate::commands::signal_store` 경로로 호출.
- [ ] **Step 4:** `commands/shared.rs`에서 `SIGNAL_COLS` 상수 제거. 기존 소비자 6파일(signals.rs/projects.rs/today/rail.rs/today/overview.rs/agents/enrich.rs/retro.rs)의 `use crate::commands::shared::SIGNAL_COLS;`(또는 `shared::SIGNAL_COLS` 참조)를 `use crate::commands::signal_store::SIGNAL_COLS;`로 변경. (정확한 import 라인은 각 파일에서 `SIGNAL_COLS` grep로 확인.)
- [ ] **Step 5:** 검증: `rtk proxy cargo build --manifest-path src-tauri/Cargo.toml > /tmp/b.log 2>&1` → Read로 `Finished` 확인(아직 fn 없음, 컴파일만).
- [ ] **Step 6:** 커밋: `git add -A && git commit -m "refactor(signals): signal_store 스켈레톤 + SIGNAL_COLS 이전"` (PATH export 후).

---

## Task 1: signals.rs 코어 이전

**Files:** Modify `signal_store.rs`(추가), `commands/signals.rs`(위임).

이전 대상(원본 SQL을 verbatim 복사) — 각 store fn 시그니처:

```rust
// signal_store.rs 에 추가 (본문 SQL은 signals.rs 원본에서 그대로 복사)
pub(crate) async fn insert_signal(db: &Db, input: &crate::models::CreateSignalInput) -> Result<WorkSignal, sqlx::Error> // signals.rs:24-58 (dedup UPDATE + INSERT 두 쿼리 모두)
pub(crate) async fn fetch_signals(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error>          // signals.rs:75-83
pub(crate) async fn set_quadrant(db: &Db, id: &str, quadrant: &str) -> Result<WorkSignal, sqlx::Error> // signals.rs:92-111
pub(crate) async fn set_signal_status(db: &Db, id: &str, status: &str) -> Result<WorkSignal, sqlx::Error> // signals.rs:131-139
pub(crate) async fn snooze_signal(db: &Db, id: &str, until: &str) -> Result<WorkSignal, sqlx::Error> // signals.rs:149-157
pub(crate) async fn update_title(db: &Db, id: &str, title: &str) -> Result<WorkSignal, sqlx::Error> // signals.rs:176-185
pub(crate) async fn delete_signal_row(db: &Db, id: &str) -> Result<u64, sqlx::Error>        // signals.rs:207-211 (rows_affected 반환)
pub(crate) async fn fetch_signal_title(db: &Db, signal_id: &str) -> Result<Option<String>, sqlx::Error> // signals.rs:224-227 (insert_promotion_draft 내부 SELECT)
pub(crate) async fn search_signals(db: &Db, query: &str) -> Result<Vec<WorkSignal>, sqlx::Error> // signals.rs:264-277 (signals JOIN signals_fts)
```

> 주의: 기존 `insert_signal`/`fetch_signals`/`set_quadrant` 등은 이미 `signals.rs`의 `pub(crate) async fn`이다 → **이동**(signal_store로) 후 signals.rs는 재export 하지 말고 호출로 바꾼다. 다른 모듈이 `crate::commands::signals::fetch_signals` 등을 쓰면(예: today/agents 테스트) 그 import도 `signal_store`로 갱신.

- [ ] **Step 1:** 위 9개 fn을 signal_store.rs로 이전(SQL verbatim). `insert_promotion_draft`/`delete_signal`/`classify_signal` 등 커맨드는 signals.rs에 남기고 내부 SQL만 store fn 호출로 교체(예: `delete_signal`은 `signal_store::delete_signal_row(db,&id).await?`의 rows_affected로 기존 not-found 처리 보존).
- [ ] **Step 2:** signals.rs의 커맨드/헬퍼가 store fn을 호출하도록 수정. `use crate::commands::signal_store;` 추가.
- [ ] **Step 3:** `export PATH=...; rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings > /tmp/c.log 2>&1` → Read로 경고 0 확인.
- [ ] **Step 4:** `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/t.log 2>&1` → Read로 `204 passed`(현 기준) 확인.
- [ ] **Step 5:** `git diff --exit-code src/bindings.ts` → **빈값**(exit 0). 아니면 시그니처 변화 → 수정.
- [ ] **Step 6:** 커밋: `git add -A && git commit -m "refactor(signals): signals.rs 코어 SQL을 signal_store로 이전"`.

---

## Task 2: today/rail.rs 이전 (Today 레일 — G 핵심 컬럼)

**Files:** Modify `signal_store.rs`, `commands/today/rail.rs`.

```rust
pub(crate) async fn promote_today(db: &Db, id: &str, date: &str) -> Result<WorkSignal, sqlx::Error>   // rail.rs:12-24 (promote_today_inner 본문)
pub(crate) async fn unpromote_today(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error>             // rail.rs:37-47 (unpromote_today_inner 본문)
pub(crate) async fn toggle_today_done(db: &Db, id: &str, date: &str, done: bool) -> Result<WorkSignal, sqlx::Error> // rail.rs:65-72
pub(crate) async fn reorder_today(db: &Db, ordered_ids: &[String]) -> Result<(), sqlx::Error>         // rail.rs:81-86 (트랜잭션 루프 전체)
pub(crate) async fn fetch_today(db: &Db, today: &str) -> Result<Vec<WorkSignal>, sqlx::Error>         // rail.rs:93-101
```

> 이 컬럼들(today_for_date/rank/done_at)이 G가 위성테이블로 옮길 대상 → 전부 store 경유가 G의 핵심.

- [ ] **Step 1:** 5개 fn 이전(SQL verbatim, 트랜잭션 포함). `promote_today_inner`/`unpromote_today_inner`(기존 pub) 호출부를 store로.
- [ ] **Step 2:** rail.rs 커맨드가 store fn 호출하도록 수정.
- [ ] **Step 3-5:** clippy 0 / test 204 / `git diff --exit-code src/bindings.ts` 빈값.
- [ ] **Step 6:** 커밋: `refactor(signals): today/rail SQL을 signal_store로 이전`.

---

## Task 3: today/overview.rs + today/weekly.rs 이전 (집계)

**Files:** Modify `signal_store.rs`, `commands/today/overview.rs`, `commands/today/weekly.rs`.

overview의 Work Debt 카운트(4개)·Q1/PR-attention SELECT, weekly의 throughput/PR 카운트(4개)는 **signals 단일 테이블** 쿼리 → store fn으로 이전:

```rust
pub(crate) async fn count_unclassified_active(db: &Db) -> Result<i64, sqlx::Error>        // overview.rs:23-29
pub(crate) async fn count_q1_overdue(db: &Db, date: &str) -> Result<i64, sqlx::Error>     // overview.rs:35-43 (localtime/julianday 그대로)
pub(crate) async fn count_stale_backlog(db: &Db, date: &str) -> Result<i64, sqlx::Error>  // overview.rs:46-54
pub(crate) async fn count_cleanup_needed(db: &Db) -> Result<i64, sqlx::Error>             // overview.rs:58-63
pub(crate) async fn fetch_q1_items(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error>       // overview.rs:66-73
pub(crate) async fn fetch_pr_attention(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error>   // overview.rs:76-83
pub(crate) async fn count_captured_in_range(db: &Db, start: &str, end: &str) -> Result<i64, sqlx::Error> // weekly.rs:24-31
pub(crate) async fn count_completed_in_range(db: &Db, start: &str, end: &str) -> Result<i64, sqlx::Error> // weekly.rs:33-37
pub(crate) async fn count_pr_new_in_range(db: &Db, start: &str, end: &str) -> Result<i64, sqlx::Error>    // weekly.rs:48-56
pub(crate) async fn count_pr_resolved_in_range(db: &Db, start: &str, end: &str) -> Result<i64, sqlx::Error> // weekly.rs:57-65
```

> 카운트 fn 시그니처의 인자(date/start/end)는 원본 쿼리의 bind 파라미터와 1:1. `fetch_today_overview`/`fetch_weekly_review`는 커맨드(집계 조립)로 남고 위 store fn들을 호출. weekly가 routines를 조인하는 부분(있다면)은 routines 쪽이라 잔류.

- [ ] **Step 1:** 10개 fn 이전(SQL verbatim — localtime/julianday 표현 그대로). overview/weekly 집계 함수가 호출하도록 수정.
- [ ] **Step 2-4:** clippy 0 / test 204 / bindings.ts 빈 diff.
- [ ] **Step 5:** 커밋: `refactor(signals): today overview/weekly 집계 SQL을 signal_store로 이전`.

---

## Task 4: pr_radar.rs 이전 (upsert + auto_resolve)

**Files:** Modify `signal_store.rs`, `commands/pr_radar.rs`.

```rust
pub(crate) async fn upsert_pr_signal(db: &Db, project_id: &str, title: &str, body: &str, dedup_key: &str, links: &str, suggested_quadrant: &str) -> Result<(), sqlx::Error> // pr_radar.rs:125-141 (INSERT ON CONFLICT) — 인자는 원본 bind 순서대로
pub(crate) async fn fetch_pr_signal_keys(db: &Db, project_id: &str) -> Result<Vec<(String, String)>, sqlx::Error> // pr_radar.rs:198-204 (auto_resolve용 id,dedup_key SELECT)
pub(crate) async fn mark_signal_done(db: &Db, id: &str) -> Result<(), sqlx::Error>          // pr_radar.rs:212-220 (UPDATE status='done')
```

> `upsert_pr_signal`(기존 pr_radar 내 fn)의 **SQL은 store로**, title/body/links 조립과 escalation 로직은 커맨드 잔류. `auto_resolve` 루프 구조는 커맨드 잔류, 내부 SELECT/UPDATE만 store fn 호출(INVARIANT #3 dedup/auto-resolve 보존 — 루프 의미 불변).

- [ ] **Step 1:** 3개 fn 이전. pr_radar의 `upsert_pr_signal`/`auto_resolve`가 store 호출하도록(루프/조건은 그대로).
- [ ] **Step 2-4:** clippy 0 / test 204 / bindings.ts 빈 diff. (pr_radar 테스트 14개가 dedup·auto-resolve·escalation을 커버 → 행위 보존 가드.)
- [ ] **Step 5:** 커밋: `refactor(signals): pr_radar upsert/auto_resolve SQL을 signal_store로 이전`.

---

## Task 5: notion.rs 이전 (promote 링크/프로젝트 해석)

**Files:** Modify `signal_store.rs`, `commands/notion.rs`.

```rust
pub(crate) async fn fetch_signal_links(db: &Db, signal_id: &str) -> Result<Option<String>, sqlx::Error> // notion.rs:92-95
pub(crate) async fn set_signal_links_linked(db: &Db, signal_id: &str, links: &str) -> Result<(), sqlx::Error> // notion.rs:104-111 (links + status='linked')
pub(crate) async fn fetch_signal_project_kind(db: &Db, signal_id: &str) -> Result<Option<(Option<String>, Option<String>)>, sqlx::Error> // notion.rs:238-243 (project_id, kind)
pub(crate) async fn set_signal_project(db: &Db, signal_id: &str, project_id: &str) -> Result<(), sqlx::Error> // notion.rs:248-255 & 278-285 (동일 UPDATE — 한 fn으로 통합 호출)
```

> `finalize_created`의 links 병합 로직은 커맨드 잔류(외부 응답 파싱). `resolve_notion_target`의 두 UPDATE(explicit/auto-assign)가 동일 SQL이면 `set_signal_project` 한 fn으로 양쪽 호출. 반환타입: 원본이 `Result<_, String>` 경로면 store는 `sqlx::Error` 반환, 커맨드가 기존처럼 `.map_err(|e| e.to_string())` 등으로 변환(시그니처 무변경).

- [ ] **Step 1:** 4개 fn 이전, notion.rs 호출 교체.
- [ ] **Step 2-4:** clippy 0 / test 204 / bindings.ts 빈 diff. (notion promote 테스트가 finalize/resolve 커버.)
- [ ] **Step 5:** 커밋: `refactor(signals): notion promote 링크/프로젝트 SQL을 signal_store로 이전`.

---

## Task 6: projects.rs 이전 (reconcile/tag)

**Files:** Modify `signal_store.rs`, `commands/projects.rs`.

```rust
pub(crate) async fn reconcile_signal_projects(db: &Db) -> Result<u64, sqlx::Error>          // projects.rs:142-151 (UPDATE ... FROM projects subquery — cross-table지만 UPDATE 대상이 signals라 store로)
pub(crate) async fn set_signal_project_tag(db: &Db, id: &str, project_id: Option<&str>) -> Result<WorkSignal, sqlx::Error> // projects.rs:168-175
```

> reconcile은 signals를 UPDATE(서브쿼리로 projects 참조) → signals-write이므로 store. set_signal_project는 SIGNAL_COLS RETURNING.

- [ ] **Step 1:** 2개 fn 이전, projects.rs 호출 교체.
- [ ] **Step 2-4:** clippy 0 / test 204 / bindings.ts 빈 diff.
- [ ] **Step 5:** 커밋: `refactor(signals): projects reconcile/tag SQL을 signal_store로 이전`.

---

## Task 7: agents/enrich.rs + triage.rs 이전 (suggested 힌트 — 결정레일 인접, 주의)

**Files:** Modify `signal_store.rs`, `commands/agents/enrich.rs`, `commands/agents/triage.rs`.

```rust
pub(crate) async fn fetch_card_text(db: &Db, signal_id: &str) -> Result<Option<(String, Option<String>, Option<String>)>, sqlx::Error> // enrich.rs:46-52 (title, body, project_id)
pub(crate) async fn set_enrich_hints(db: &Db, signal_id: &str, suggested_quadrant: Option<&str>, suggested_area: Option<&str>, reason: Option<&str>) -> Result<WorkSignal, sqlx::Error> // enrich.rs:140-150
pub(crate) async fn set_signal_area(db: &Db, id: &str, area: Option<&str>) -> Result<WorkSignal, sqlx::Error> // enrich.rs:192-199
pub(crate) async fn fetch_unclassified_for_enrich(db: &Db, project_id: Option<&str>) -> Result<Vec<(String, String)>, sqlx::Error> // enrich.rs:232-250
pub(crate) async fn set_enrich_hints_batch_one(...) // enrich.rs:427-437 (루프 내 1건 UPDATE — 루프는 커맨드 잔류, 1건 UPDATE만 store)
pub(crate) async fn insert_triage_q1_escalation(db: &Db, /* 원본 bind 순 */) -> Result<(), sqlx::Error> // triage.rs:60-76 (INSERT ON CONFLICT)
```

> **INVARIANT #1 주의:** 이 fn들은 `suggested_quadrant`/`suggested_area`/`area`만 쓴다(절대 `quadrant` 확정값 아님). store fn에도 그 SQL을 그대로 이전 — quadrant 컬럼을 건드리지 않음을 critic이 확인. 결정 레일 자동화 침투 없음.

- [ ] **Step 1:** fn 이전. enrich 배치 루프·triage escalation 조건은 커맨드 잔류, SQL만 store.
- [ ] **Step 2-4:** clippy 0 / test 204 / bindings.ts 빈 diff. (agents 테스트가 enrich accept=hints-only를 커버.)
- [ ] **Step 5:** 커밋: `refactor(signals): agents enrich/triage signals SQL을 signal_store로 이전`.

---

## Task 8: retro.rs 이전 (완료 타임라인/회고 태그 — G 핵심 컬럼)

**Files:** Modify `signal_store.rs`, `commands/retro.rs`.

```rust
pub(crate) async fn fetch_completed(db: &Db, start: &str, end: &str) -> Result<Vec<WorkSignal>, sqlx::Error> // retro.rs:19-27 (today_done_at BETWEEN)
pub(crate) async fn set_impact(db: &Db, id: &str, value: bool) -> Result<WorkSignal, sqlx::Error>  // retro.rs:45-52 (impact_high)
pub(crate) async fn set_regret(db: &Db, id: &str, value: bool) -> Result<WorkSignal, sqlx::Error>  // retro.rs:69-76 (regret)
pub(crate) async fn fetch_archived_snoozed(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error>        // retro.rs:96-103
pub(crate) async fn restore_signal(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error>           // retro.rs:116-124
```

> impact_high/regret/today_done_at는 G가 옮길 컬럼 → store 경유 필수.

- [ ] **Step 1:** 5개 fn 이전, retro.rs 호출 교체.
- [ ] **Step 2-4:** clippy 0 / test 204 / bindings.ts 빈 diff.
- [ ] **Step 5:** 커밋: `refactor(signals): retro 완료/태그/복원 SQL을 signal_store로 이전`.

---

## Task 9: signal_store 직접 단위테스트 추가 (testability 목표)

**Files:** Modify `signal_store.rs`(`#[cfg(test)] mod tests`).

목표: signals SQL 경로를 store 단에서 직접 검증(기존엔 커맨드 경유만). `fresh_db()` 사용.

- [ ] **Step 1:** 테스트 작성 — 최소:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::fresh_db;
    use crate::models::CreateSignalInput; // 실제 입력 타입에 맞춤

    #[tokio::test]
    async fn insert_then_fetch_roundtrips() {
        let db = fresh_db().await;
        let s = insert_signal(&db, &/* CreateSignalInput 최소 구성 */).await.unwrap();
        let all = fetch_signals(&db).await.unwrap();
        assert!(all.iter().any(|x| x.id == s.id));
    }

    #[tokio::test]
    async fn promote_sets_today_membership_and_fetch_today_returns_it() {
        let db = fresh_db().await;
        let s = insert_signal(&db, &/* ... */).await.unwrap();
        promote_today(&db, &s.id, "2026-05-23").await.unwrap();
        let today = fetch_today(&db, "2026-05-23").await.unwrap();
        assert!(today.iter().any(|x| x.id == s.id));
    }

    #[tokio::test]
    async fn search_signals_matches_title_via_fts() {
        let db = fresh_db().await;
        insert_signal(&db, &/* title="파이프라인 점검" */).await.unwrap();
        let hits = search_signals(&db, "파이프라인").await.unwrap();
        assert_eq!(hits.len(), 1);
    }
}
```

- [ ] **Step 2:** `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=4 > /tmp/t.log 2>&1` → Read로 신규 테스트 통과 + 총 카운트 증가(204→204+N) 확인.
- [ ] **Step 3:** clippy 0 확인.
- [ ] **Step 4:** 커밋: `test(signal_store): signals 데이터 접근 직접 단위테스트 추가`.

---

## Task 10: 최종 검증 + critic + 문서 + 머지

**Files:** Modify `docs/decisions.md`; (`PLAN.md` Phase 21 승격은 선택 — 아래).

- [ ] **Step 1:** 잔여 signals 인라인 SQL 0 확인(테스트 픽스처 제외): `grep -rn "FROM signals\|INTO signals\|UPDATE signals\|signals_fts" src-tauri/src/commands --include="*.rs"` 가 signal_store.rs(+테스트 픽스처)만 남는지 확인.
- [ ] **Step 2:** 최종 번들: clippy 0 · `cargo test` (≥204+N) · `git diff --exit-code src/bindings.ts` 빈값 · `pnpm typecheck && pnpm build` green.
- [ ] **Step 3:** **critic 패스(self-approve 금지)** — INVARIANT #1(quadrant/결정레일 무변경: enrich/triage가 suggested_*만), #3(dedup upsert+auto-resolve 의미 보존), #7(SQLite SSOT) + 행위 보존(bindings.ts 빈 diff·전 SQL verbatim) 확인. critic ACCEPT 전 머지 금지.
- [ ] **Step 4:** `docs/decisions.md`에 한 줄 + 트레이드오프(대형 단일 PR, verbatim relocation, G 선행).
- [ ] **Step 5:** (선택) `PLAN.md`에 Phase 21(F+G) 승격 한 단락 — F done-criteria 체크.
- [ ] **Step 6:** `git checkout dev && git merge --ff-only refactor/signal-store && git push origin dev && git branch -d refactor/signal-store`.

---

## Self-Review 메모 (작성자 점검 완료)

- **Spec 커버리지:** 설계 §4.2 함수 범주(코어/Today/집계/회고/PR·외부) → Task 1~8에 1:1 매핑. SIGNAL_COLS 이전 → Task 0. testability → Task 9. critic/Phase → Task 10. ✅
- **Placeholder:** store fn 본문은 "원본 file:line SQL을 verbatim 복사"로 명시(relocation 특성상 SQL 재기입은 transcription 위험 → 출처 지정이 정확). 시그니처는 전부 구체. Task 9 테스트 입력의 `CreateSignalInput 최소 구성`은 실제 타입 확인 필요(구현 시 models.rs 참조) — 유일한 "구현 시 확정" 지점.
- **타입 일관성:** store fn은 `Result<_, sqlx::Error>` 통일(커맨드가 AppError 변환 유지) — 시그니처 충돌 없음.
- **G 연결:** G 핵심 컬럼(today_for_date/rank/done_at, impact_high, regret) 접근은 Task 2(rail)·3(overview/weekly)·8(retro)에 모두 포함 → G가 signal_store 내부만 바꾸면 됨. ✅
