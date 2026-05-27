# 설계 — `notification_store` (백로그 F, scheduled_notifications 슬라이스) (2026-05-24)

> 백로그 **F**(commands 데이터 접근 레이어)의 세 번째 store. signals(`signal_store`)·agent_runs(`agent_run_store`)
> 완료에 이어 **공유 cross-cutting 테이블 `scheduled_notifications`**를 단일 소유로 추출한다.
> 정본 규칙: `AGENTS.md` + `PLAN.md §1`(INVARIANTS) + `docs/architecture.md`. 실행 프로토콜은
> `docs/plans/2026-05-23-quality-followups-remaining.md §1`.

## 1. 배경 / 동기

`scheduled_notifications`는 **소유자 없는 공유 테이블**이다 — 4개 모듈이 직접 SQL로 접근:
producer 3(routines 리마인더 / pr_radar CI 실패 / commands::scheduler 테스트), consumer 1(백그라운드
`scheduler.rs` 틱). 모두 동일한 generic 계약(`source`/`source_id`)을 쓰므로 단일 store로 깔끔히 모인다.
(routine_store는 scheduled_notifications 트랜잭션 결합 + 읽기-로직 융합으로 부적합 판정 — 이 store가 선행.)

## 2. 목표 / 비목표

**목표:** `scheduled_notifications`의 모든 SQL을 `commands/notification_store.rs`(단일 소유, `pub(crate)`
free fn, `&Db`)로 verbatim 이전. producer/consumer는 store fn 호출로 위임. 동작·IPC 표면 무변경.

**비목표:** 스키마 변경 없음. 알림 발사 런타임(`Notifier`/`run_tick`/`spawn_loop`)은 `scheduler.rs`에 잔류
(jobs.rs=런타임 / agent_run_store=영속 분리와 동일 패턴). 무관 리팩터 없음.

## 3. store API (generic source/source_id)

```rust
// commands/notification_store.rs — scheduled_notifications 단일 소유자
pub(crate) struct DueNotification { id, title, body, source, source_id: Option<String> } // scheduler.rs에서 이전

pub(crate) async fn enqueue(db, fire_at: &str, title: &str, body: &str, source: &str, source_id: Option<&str>) -> Result<(), sqlx::Error>
pub(crate) async fn exists(db, source: &str, source_id: &str) -> Result<bool, sqlx::Error>
pub(crate) async fn due(db, now: &str) -> Result<Vec<DueNotification>, sqlx::Error>          // due_notifications 이전
pub(crate) async fn mark_fired_by_id(db, id: &str, now: &str) -> Result<(), sqlx::Error>     // mark_fired 이전
pub(crate) async fn mark_fired_by_source(db, source: &str, source_id: &str, now: &str) -> Result<(), sqlx::Error>
pub(crate) async fn delete_unfired_by_source(db, source: &str, source_id_like: &str) -> Result<(), sqlx::Error>
```

> 시그니처/SQL 문자열/바인드 순서는 기존 호출부와 1:1. 모든 fn 단일 쿼리(executor-generic 불필요).

## 4. 이전 인벤토리 (무엇이 어디로)

### 4.1 `scheduler.rs`(백그라운드 런타임) → store

- `DueNotification` struct → store(자연스러운 row shape). `scheduler.rs`가 import.
- `due_notifications` → `notification_store::due`.
- `mark_fired` → `notification_store::mark_fired_by_id`.
- 잔류: `Notifier` trait, `run_tick`(due→notify→mark_fired_by_id 호출), `spawn_loop`, `utc_now_string`, `TICK_INTERVAL`.

### 4.2 producer 위임

- `routines/reminders.rs sync_reminders`: exists(`'routine'`,source_id) + INSERT → `exists` + `enqueue(...,'routine',Some(id))`.
- `pr_radar.rs enqueue_ci_failure_notification`: exists(`'ci'`,source_id) + INSERT → `exists` + `enqueue(...,'ci',Some(id))`.
- `commands/scheduler.rs schedule_test_notification`: INSERT(computed fire_at) → fire_at를 Rust(now+secs, chrono)로 계산 후 `enqueue(...,'test',None)`. (SQL `datetime()` → Rust 계산, 동작 동일.)

### 4.3 routine 리마인더 라이프사이클(`routines/crud.rs`)

- `toggle_routine_check`: UPDATE fired_at WHERE source='routine' AND source_id → `mark_fired_by_source('routine',id,now)`.
- `update_routine_inner`: DELETE unfired WHERE source='routine' AND source_id LIKE pattern → `delete_unfired_by_source('routine',pattern)` (비-트랜잭션 — `&Db` OK).

## 5. 한 가지 예외 (문서화)

`routines/crud.rs::delete_routine_inner`는 `scheduled_notifications`(unfired) + `routine_checks` + `routines`를
**단일 트랜잭션**으로 삭제(원자성). `&Db` store fn은 이 tx에 합류 못 한다. 동작(원자성) 보존을 위해
**그 in-tx `DELETE scheduled_notifications`만 inline 잔류**(executor-generic 도입 회피 — `&Db` 선례 유지).
나머지 scheduled_notifications SQL은 전부 store 경유. (대안: 전 store fn executor-generic → 완전 단일소유,
단 복잡·선례 이탈. 채택 안 함.)

## 6. 검증 (done-criteria)

- [ ] `git diff --exit-code src/bindings.ts` 비어 있음(순수 이전 — IPC 무변경).
- [ ] `cargo clippy --all-targets -- -D warnings` = 0.
- [ ] `cargo test --lib` 기존 테스트 green(특히 scheduler `run_tick`/due/mark_fired, routines reminder 멱등·완료-skip·update/delete 보존, pr_radar CI 알림 멱등) + **store 직접 단위테스트 추가**(enqueue/exists/due/mark_fired ×2/delete_unfired 라운드트립).
- [ ] `pnpm typecheck`+`test`+`build` green.
- [ ] **critic 패스**(INVARIANT #5 bounded scheduler·#7 SSOT 보존, 동작 무변경 확인).
- [ ] `docs/decisions.md` 한 줄 + 트레이드오프(delete_routine_inner inline 예외).
- [ ] 잔여 grep: `scheduled_notifications` 비-테스트 SQL은 store + `delete_routine_inner`(문서화 예외)만.

## 7. 리스크

- **낮음**(단일 테이블, generic CRUD, INVARIANT 게이트 없음). 가장 큰 주의는 `scheduler.rs` 런타임/영속 분리 시
  `DueNotification` 이동 + `run_tick`의 store 호출 배선. 백그라운드 틱은 단위테스트(`run_tick`)가 보호.
- `schedule_test_notification`의 fire_at 계산 위치 변경(SQL→Rust)은 시연 커맨드라 영향 미미, 동작 동일.

## 8. 후속 (참고)

- 이 store 완료 후 **routine_store** 재시도 시: routines가 리마인더를 `notification_store`로 호출 → routines/
  잔여는 routines+routine_checks(읽기 로직 융합) 위주라 더 작아짐(여전히 today/ 결합 존재 → G 인접).
- 남은 F store: skill_store / promotion_store / pr_radar_store(나머지) — 별도 PR.
