# 설계 — `agent_run_store` (백로그 F, agent_runs 슬라이스) (2026-05-23)

> 백로그 **F**(commands 데이터 접근 레이어)의 두 번째 store. signals는 이미
> `commands/signal_store.rs`로 추출 완료(`dd586b7`). 이 문서는 **agent_runs 슬라이스**의
> 설계 정본이다. 정본 규칙은 `AGENTS.md` + `PLAN.md §1`(INVARIANTS) + `docs/architecture.md`.
> 실행 프로토콜(브랜치/검증)은 `docs/plans/2026-05-23-quality-followups-remaining.md §1`을 따른다.

## 1. 목표 / 비목표

**목표:** IPC 핸들러(`agents/*`)와 런타임(`jobs.rs`)에 흩어진 `agent_runs`(+`acceptances`)
SQL을 단일 소유 store로 캡슐화한다. `signal_store`와 **동일 패턴**(Approach A: verbatim 이전,
`pub(crate)` free fn, 동작 무변경).

**비목표:**

- 스키마 변경 없음(테이블/마이그레이션 무변경). G(테이블 분리)와 별개.
- 동작/IPC 표면 변경 없음 — `bindings.ts` diff가 비어야 한다(순수 이전 증명).
- `pr_self_checks`(pr_radar aggregate)·`signals`(signal_store) write는 이 store로 옮기지 않는다.
- 무관 리팩터·정리 없음(AGENTS.md 금지).

## 2. 경계 (합의됨)

- **신규 `src-tauri/src/commands/agent_run_store.rs`** = `agent_runs` + `acceptances` SQL의
  단일 소유자(`pub(crate)` free fn). `acceptances`를 함께 두는 이유: accept 게이트가
  **공-트랜잭션**(acceptances INSERT + agent_runs UPDATE가 한 논리 단위, `record_acceptance`)이라
  두 store로 쪼개면 INVARIANT #2 감사 표면이 흩어진다.
- **`jobs.rs`** = `JobManager` 런타임만 보유(spawn/kill/semaphore/registry). 영속 함수는 store로
  이전하고 `spawn`/커맨드가 store를 호출.
- **`agents/*`** 커맨드 = `#[tauri::command]` 셸(IPC 표면) 유지, SQL 본문만 store에 위임.
- **`require_awaiting`**(accept 상태 가드)는 `agents/mod.rs`에 잔류 — 영속이 아니라 커맨드
  오케스트레이션 정책이다.

## 3. 이전 인벤토리 (무엇이 어디로)

### 3.1 `jobs.rs` → store (영속)

| 이전 대상                                                           | 비고                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `AgentRunRecord`(FromRow) + `From<AgentRunRecord> for AgentRunView` | i64→u32 변환 포함, 그대로                                        |
| `detail_from_result`                                                | **중복 해소 지점** (아래 3.4)                                    |
| `insert_agent_run`                                                  | 큐 진입 INSERT(`AgentStatus::Proposed` 바인딩 — D 결과 보존)     |
| `fetch_agent_runs`                                                  | Jobs 뷰(최근 100)                                                |
| `fetch_log_tail`                                                    | `agent_runs.log_path` 읽기                                       |
| `mark_running` (priv)                                               | `proposed`→`running` CAS                                         |
| `finalize` (priv)                                                   | 종료 전이(succeeded/awaiting_approval/failed/cancelled) — 게이트 |
| `mark_cancelled_in_queue` (priv)                                    | 큐 대기 취소 CAS                                                 |

`jobs.rs` 잔류: `JobManager`(struct + `new`/`log_path`/`spawn`/`kill`). `spawn` 클로저는
`store::mark_running`/`store::finalize`/`store::mark_cancelled_in_queue`를 호출한다.

### 3.2 `agents/mod.rs` → store (영속)

| 이전 대상                     | 비고                                                           |
| ----------------------------- | -------------------------------------------------------------- |
| `new_run_id`                  | id 생성(`randomblob`) — agent_runs 진입용                      |
| `run_status_trigger`          | `(AgentStatus, Option<String>)` 읽기(D 타입 보존)              |
| `run_proposal_raw`            | proposal 원문                                                  |
| `record_acceptance`           | acceptances INSERT + agent_runs UPDATE(게이트) — **단일 정의** |
| `agent_run_status`의 SQL 본문 | 커맨드는 잔류, SQL은 `store::fetch_run_status`로               |
| `detail_from_result_json`     | `detail_from_result`와 통합(3.4)                               |

`agents/mod.rs` 잔류: `require_awaiting`, `require_codex`, trigger 구조체(`EnrichTrigger` 등),
`parse_proposal`, `agent_run_status` 커맨드 셸.

### 3.3 `agents/selfcheck.rs` → store (영속)

- `execute_accept`의 게이트 부분(acceptances INSERT + agent_runs UPDATE) → `store::record_acceptance`
  재사용. `pr_self_checks` INSERT(로컬 효과, pr_radar aggregate)는 **caller(selfcheck)에 잔류**.
- `reject_proposal`의 `awaiting_approval`→`cancelled` UPDATE → `store::reject_run`(rows_affected 반환).
- `accept_proposal`의 인라인 상태 읽기 → `store::run_status_trigger`.

### 3.4 자연스러운 중복 해소 (in-scope, 작업 중 개선)

- `detail_from_result`(jobs.rs:68) ≡ `detail_from_result_json`(agents/mod.rs:154) — 동일 로직.
  store의 단일 헬퍼로 통합(시그니처는 호출부에 맞춰 `Option<&str>`/`&Option<String>` 중 하나로
  통일, 호출부 조정).
- `execute_accept`의 손수 acceptances INSERT(selfcheck.rs:237) ≡ `record_acceptance`의 INSERT
  (mod.rs:106) — `target`만 다름. store의 단일 `record_acceptance(db, run_id, target, json)`를
  양쪽이 호출.

> 이 둘은 "작업 중인 코드의 국소 개선" 범위(AGENTS.md 허용). 그 외 정리 없음.

## 4. store 공개 API (초안)

```rust
// agent_run_store.rs — agent_runs + acceptances 단일 소유자
pub(crate) async fn new_run_id(db) -> Result<String, String>           // 기존 타입 보존
pub(crate) async fn insert_agent_run(db, &NewAgentRun) -> Result<(), sqlx::Error>
pub(crate) async fn fetch_agent_runs(db) -> Result<Vec<AgentRunView>, sqlx::Error>
pub(crate) async fn fetch_log_tail(db, run_id) -> Result<String, sqlx::Error>
pub(crate) async fn fetch_run_status(db, run_id) -> Result<Option<(AgentStatus, Option<String>, Option<String>)>, sqlx::Error>
pub(crate) async fn run_status_trigger(db, run_id) -> Result<(AgentStatus, Option<String>), String>
pub(crate) async fn run_proposal_raw(db, run_id) -> Result<String, String>
pub(crate) async fn mark_running(db, run_id)
pub(crate) async fn finalize(db, run_id, Result<AgentOutcome, AgentError>, gated: bool)
pub(crate) async fn mark_cancelled_in_queue(db, run_id)
pub(crate) async fn record_acceptance(db, run_id, target, accepted_json) -> Result<(), sqlx::Error>
pub(crate) async fn reject_run(db, run_id) -> Result<u64, sqlx::Error>  // rows_affected
fn detail_from_result(result: Option<&str>) -> Option<String>          // store-private 통합 헬퍼
```

> 정확한 시그니처/가시성은 기존 호출부와 1:1로 맞춘다(반환 타입·에러 타입 보존 — 동작 무변경).
> `mark_running`/`finalize`/`mark_cancelled_in_queue`는 기존대로 `let _ =`(에러 무시) 동작 유지.

## 5. INVARIANT 보존

- **#2 Acceptance 게이트:** 모든 `awaiting_approval`→`succeeded`/`cancelled` CAS가 store의
  소수 named fn(`record_acceptance`/`reject_run`/`finalize`)에 모여 단일 감사 지점이 된다.
  D의 `AgentStatus` 바인딩을 그대로 보존(게이트 SQL byte-equivalent). 외부(Notion/GitHub) 호출
  없음 — store는 로컬 영속만.
- **#1 결정 레일:** 자동 분류/승격 도입 없음(순수 이전).
- **#5 bounds:** `JobManager`의 timeout/kill/semaphore 잔류 — 런타임 무변경.
- **#7 SSOT:** 로컬 SQLite가 SSOT, store는 그 접근 캡슐화일 뿐.

## 6. 검증 (done-criteria)

- [ ] `git diff --exit-code src/bindings.ts` **비어 있음** (순수 이전 = IPC 표면 동일).
- [ ] `cargo clippy --all-targets -- -D warnings` = 0.
- [ ] `cargo test --lib` — 기존 agent_runs/jobs 테스트 전부 green + **store 직접 단위테스트 추가**
      (게이트 fn 라운드트립: `fresh_db`에 awaiting 행 삽입 → `record_acceptance`/`reject_run` →
      상태/acceptances 카운트 검증, signal_store의 +5 선례).
- [ ] `pnpm typecheck` + `pnpm test` + `pnpm build` green.
- [ ] **critic 패스**(게이트 변경 → self-approve 금지, INVARIANT #1/#2/#5 보존 확인).
- [ ] `docs/decisions.md`에 한 줄 + 트레이드오프.

## 7. 리스크 / 트레이드오프

- **리스크:** `finalize`/`mark_*`가 `jobs.rs::spawn` 클로저 내부에서 호출됨 → 이전 시 가시성
  (`pub(crate)`)·import 경로만 조정, 로직 무변경. `spawn`은 store fn을 `await`로 호출(동일).
- **트레이드오프:** 게이트 SQL이 커맨드 옆이 아니라 store에 모여 호출부에서 한 단계 멀어짐
  → 대신 단일 소유·단일 감사 지점(INVARIANT #2 검토 용이). signal_store와 일관.
- **누수 주의:** `agents/*` 커맨드가 store fn을 호출하되 트랜잭션 경계는 기존과 동일(개별 쿼리).
  멀티-쿼리 게이트(acceptances+UPDATE)는 기존에도 단일 트랜잭션이 아님 → **동작 보존 위해
  트랜잭션화하지 않는다**(별도 개선 항목이면 G/후속에서).

## 8. 이후 store 로드맵 (별도 PR — 참고)

한 PR = 한 store, 큰 것부터. 이 슬라이스(agent_runs) 다음 순서 제안:

1. `routine_store` (routines/\* ~31 SQL)
2. `promotion_store` (notion/promotions ~21)
3. `skill_store` (skills.rs ~20)
4. `pr_radar_store` (pr_radar.rs ~11, `pr_self_checks` 포함 — selfcheck의 로컬 효과가 여기로 합류 가능)
5. 소형(projects/hermes/calendar/retro/nav) — 기회주의적

> **today 레일**(today/\* ~22)은 `signals` 컬럼을 직접 읽으므로 G(위성 테이블 분리)와 강결합 →
> G 설계와 함께 다룬다. G는 signals 슬라이스만 의존하므로 위 F 잔여와 독립적으로 진행 가능.
