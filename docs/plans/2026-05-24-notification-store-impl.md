# notification_store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** `scheduled_notifications` SQL을 단일 소유 `commands/notification_store.rs`로 캡슐화(백로그 F). 동작·IPC 무변경.

**Architecture:** signal_store/agent_run_store와 동일 — `pub(crate)` free fn, `&Db`, verbatim 이전. `scheduler.rs`는 발사 런타임만 보유하고 store를 호출. producer(routines/pr_radar/scheduler-cmd)는 enqueue/exists 위임.

**Tech Stack:** Rust, sqlx 0.8 (SQLite). 검증: `rtk proxy cargo ...`, `pnpm typecheck/test/build`.

---

## 실행 규칙 (모든 Task)

- cargo 전 `export PATH="$HOME/.cargo/bin:$PATH"`; 검증 `rtk proxy cargo ...`, 파일 확인 Read.
- 브랜치 `refactor/notification-store`. push는 dev만(ff-merge 마지막).
- 순수 이전: SQL 문자열/바인드/동작 무변경. 변경은 위치·가시성·import·(test cmd) fire_at 계산 위치뿐.
- 매 Task: `rtk proxy cargo build` 통과. bindings.ts diff 비어야 함(IPC 무변경).
- manifest 경로는 절대경로(`/Users/davidpark/private_project/work-radar/src-tauri/Cargo.toml`) 권장(쉘 cwd 주의).

## 파일 구조

- Create `src-tauri/src/commands/notification_store.rs`
- Modify `src-tauri/src/commands/mod.rs`(`pub mod notification_store;`)
- Modify `src-tauri/src/scheduler.rs`(런타임만 잔류, store 호출)
- Modify `src-tauri/src/commands/routines/{reminders,crud}.rs`, `pr_radar.rs`, `commands/scheduler.rs`(위임)

---

## Task 1: store 생성 + scheduler.rs 영속 이전 + 전체 API

**Files:** Create `commands/notification_store.rs`; Modify `commands/mod.rs`, `scheduler.rs`.

- [ ] **Step 1: 모듈 선언** — `commands/mod.rs`에 `pub mod notification_store;`(알파벳 위치, `pub mod nav;` 다음 근처).

- [ ] **Step 2: store 작성** — `scheduler.rs`의 `DueNotification`·`due_notifications`·`mark_fired`를 이전하고 producer API 추가:

```rust
//! scheduled_notifications 테이블 데이터 접근 레이어(백로그 F). 모든 알림 큐 SQL의 단일 소유자.
//! generic source/source_id 계약: routines/pr_radar/scheduler가 enqueue, 백그라운드 scheduler가 발사.

use crate::db::Db;

/// 발사 시각이 도래한 미발사 알림 한 건(런타임 발사용 row shape).
pub(crate) struct DueNotification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub source: String,
    pub source_id: Option<String>,
}

/// 알림 행 INSERT(enqueue). fire_at은 'YYYY-MM-DD HH:MM:SS' UTC 문자열. 발사는 백그라운드 스케줄러.
pub(crate) async fn enqueue(
    db: &Db, fire_at: &str, title: &str, body: &str, source: &str, source_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO scheduled_notifications (id, fire_at, title, body, source, source_id) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5)",
    )
    .bind(fire_at).bind(title).bind(body).bind(source).bind(source_id)
    .execute(db).await?;
    Ok(())
}

/// 같은 (source, source_id) 행이 (미발사/발사 무관) 존재하는지 — 멱등 enqueue 가드.
pub(crate) async fn exists(db: &Db, source: &str, source_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM scheduled_notifications WHERE source = ?1 AND source_id = ?2 LIMIT 1",
    )
    .bind(source).bind(source_id).fetch_optional(db).await?;
    Ok(row.is_some())
}

/// 발사 시각 도래(fire_at <= now) + 미발사 행을 fire_at 오름차순으로.
pub(crate) async fn due(db: &Db, now: &str) -> Result<Vec<DueNotification>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, title, body, source, source_id FROM scheduled_notifications \
         WHERE fired_at IS NULL AND fire_at <= ?1 ORDER BY fire_at ASC, id ASC",
    )
    .bind(now).fetch_all(db).await?;
    Ok(rows.into_iter()
        .map(|(id, title, body, source, source_id)| DueNotification { id, title, body, source, source_id })
        .collect())
}

/// id로 발사 완료 마킹(멱등 — fired_at IS NULL 가드).
pub(crate) async fn mark_fired_by_id(db: &Db, id: &str, now: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE scheduled_notifications SET fired_at = ?2 WHERE id = ?1 AND fired_at IS NULL")
        .bind(id).bind(now).execute(db).await?;
    Ok(())
}

/// (source, source_id)로 미발사 행을 발사 완료 마킹(완료 루틴 알림 skip).
pub(crate) async fn mark_fired_by_source(db: &Db, source: &str, source_id: &str, now: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE scheduled_notifications SET fired_at = ?2 \
         WHERE source = ?3 AND source_id = ?1 AND fired_at IS NULL",
    )
    .bind(source_id).bind(now).bind(source).execute(db).await?;
    Ok(())
}

/// source + source_id LIKE 패턴의 미발사 행 삭제(발사 행=히스토리 보존). 루틴 수정 시 재enqueue 준비.
pub(crate) async fn delete_unfired_by_source(db: &Db, source: &str, source_id_like: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM scheduled_notifications \
         WHERE source = ?2 AND source_id LIKE ?1 AND fired_at IS NULL",
    )
    .bind(source_id_like).bind(source).execute(db).await?;
    Ok(())
}
```

> **주의(바인드 순서 보존):** 기존 `mark_fired_by_source`/`delete_unfired_by_source`의 인라인 SQL은 `source='routine'` 리터럴 + `source_id` 바인드였다. generic화하며 위처럼 `?N`를 재배치하되 **바인드 값이 컬럼과 정확히 대응**하는지 Read로 교차검증.

- [ ] **Step 3: scheduler.rs 배선** — `DueNotification`·`due_notifications`·`mark_fired` 정의 제거. `use crate::commands::notification_store::{self, DueNotification};` 추가(또는 경로 직접). `run_tick`:
  - `let due = notification_store::due(db, now).await?;`
  - 발사 성공 시 `notification_store::mark_fired_by_id(db, &n.id, now).await?;`
    `Notifier` trait·`run_tick`·`spawn_loop`·`utc_now_string`·`TICK_INTERVAL`·테스트는 잔류. `DueNotification` 참조는 store의 것을 사용.

- [ ] **Step 4: 빌드** — `rtk proxy cargo build --manifest-path .../Cargo.toml` → 성공. scheduler.rs 테스트가 `due_notifications`/`mark_fired`를 직접 부르면 `notification_store::{due,mark_fired_by_id}`로 경로 보정.

- [ ] **Step 5: test + bindings** — `cargo test --lib`(현 baseline green, 회귀 0) + `git diff --exit-code src/bindings.ts`=0.

- [ ] **Step 6: 커밋** — `cargo fmt` 후 `git add -A && git commit -m "refactor(store): scheduled_notifications 영속을 notification_store로 이전(+generic API)"`.

---

## Task 2: producer 위임 (routines/reminders, pr_radar, commands/scheduler)

**Files:** `commands/routines/reminders.rs`, `commands/pr_radar.rs`, `commands/scheduler.rs`.

- [ ] **Step 1: reminders.rs** — `sync_reminders` 내 exists SELECT → `notification_store::exists(db, "routine", &source_id)`, INSERT → `notification_store::enqueue(db, &fire_at, &title, &body, "routine", Some(&source_id))`. `use crate::commands::notification_store;`.

- [ ] **Step 2: pr_radar.rs** — `enqueue_ci_failure_notification`의 exists → `notification_store::exists(db, "ci", &source_id)`, INSERT → `notification_store::enqueue(db, &fire_at, &title, &body, "ci", Some(&source_id))`.

- [ ] **Step 3: commands/scheduler.rs** — `schedule_test_notification`: fire_at를 Rust로 계산
      `let fire_at = (chrono::Utc::now() + chrono::Duration::seconds(secs)).format("%Y-%m-%d %H:%M:%S").to_string();`
      후 `notification_store::enqueue(db.inner(), &fire_at, "Work Radar 테스트 알림", "백그라운드 스케줄러 스파인이 동작합니다.", "test", None)`. (기존 SQL `datetime(now,'+N seconds')`와 동일 결과.) `utc_now_string` import가 더 안 쓰이면 제거.

- [ ] **Step 4: build + test + bindings** — 성공/green/diff 0. (reminder 멱등·CI 알림 멱등 테스트 보존 확인.)

- [ ] **Step 5: 커밋** — `refactor(store): 알림 producer(routines/pr_radar/scheduler)를 notification_store로 위임`.

---

## Task 3: routine 리마인더 라이프사이클 위임 (routines/crud.rs)

**Files:** `commands/routines/crud.rs`.

- [ ] **Step 1: toggle_routine_check** — 완료 시 UPDATE fired → `notification_store::mark_fired_by_source(db.inner(), "routine", &source_id, &utc_now_string())`. (routine_checks INSERT/DELETE는 routines 소관 — 그대로.)

- [ ] **Step 2: update_routine_inner** — DELETE unfired(비-tx) → `notification_store::delete_unfired_by_source(db, "routine", &pattern)`. (routines SELECT/UPDATE는 그대로.)

- [ ] **Step 3: delete_routine_inner** — **변경 없음**(원자성 tx 보존, 문서화 예외). 인라인 `DELETE scheduled_notifications ... &mut *tx` 잔류. crud.rs 상단에 예외 주석 1줄(왜 store 미경유인지).

- [ ] **Step 4: build + test + bindings** — green(update/delete/완료-skip 보존 테스트). diff 0.

- [ ] **Step 5: 커밋** — `refactor(store): routine 리마인더 fired/cleanup을 notification_store로 위임(delete tx는 예외)`.

---

## Task 4: store 직접 단위테스트 (genuine new)

**Files:** `commands/notification_store.rs`(`#[cfg(test)] mod tests`).

- [ ] **Step 1: 테스트 작성** — `fresh_db`(jobs/store 선례) 위에서:
  - `enqueue` 후 `exists(source,source_id)`=true, 다른 키=false.
  - `due(now)`가 fire_at<=now·미발사만, fire_at 오름차순 반환; `mark_fired_by_id` 후 due에서 빠짐.
  - `mark_fired_by_source` 후 해당 행 fired_at 설정(미발사→fired), due 제외.
  - `delete_unfired_by_source(LIKE 'routine:x:%')`가 미발사만 삭제, 발사 행 보존.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    async fn fresh_db() -> Db {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("wr-notifstore-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::init_db(&dir.join("t.db")).await.unwrap()
    }

    #[tokio::test]
    async fn enqueue_exists_and_due_and_fire() {
        let db = fresh_db().await;
        enqueue(&db, "2026-05-24 08:00:00", "t", "b", "routine", Some("routine:r1:2026-05-24")).await.unwrap();
        assert!(exists(&db, "routine", "routine:r1:2026-05-24").await.unwrap());
        assert!(!exists(&db, "routine", "nope").await.unwrap());
        // 미래 행은 due 아님.
        enqueue(&db, "2999-01-01 00:00:00", "future", "b", "test", None).await.unwrap();
        let due_now = due(&db, "2026-05-24 09:00:00").await.unwrap();
        assert_eq!(due_now.len(), 1);
        assert_eq!(due_now[0].source, "routine");
        // 발사 마킹 → due에서 빠짐.
        mark_fired_by_id(&db, &due_now[0].id, "2026-05-24 09:00:01").await.unwrap();
        assert_eq!(due(&db, "2026-05-24 09:00:00").await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn mark_by_source_and_delete_unfired_keeps_fired() {
        let db = fresh_db().await;
        enqueue(&db, "2026-05-24 08:00:00", "t", "b", "routine", Some("routine:r1:2026-05-24")).await.unwrap();
        // by-source 발사 마킹.
        mark_fired_by_source(&db, "routine", "routine:r1:2026-05-24", "2026-05-24 08:00:01").await.unwrap();
        let (fired,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine' AND fired_at IS NOT NULL")
            .fetch_one(&db).await.unwrap();
        assert_eq!(fired, 1);
        // 미발사 1 + 발사 1 → delete_unfired는 미발사만.
        enqueue(&db, "2026-05-24 09:00:00", "t2", "b", "routine", Some("routine:r1:2026-05-25")).await.unwrap();
        delete_unfired_by_source(&db, "routine", "routine:r1:%").await.unwrap();
        let (total,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM scheduled_notifications WHERE source='routine'").fetch_one(&db).await.unwrap();
        assert_eq!(total, 1, "발사 행만 남음");
    }
}
```

- [ ] **Step 2: test** — `cargo test --lib notification_store` green; 전체 카운트 +2. 컬럼/제약은 `migrations/0001`의 scheduled_notifications와 일치.

- [ ] **Step 3: 커밋** — `test(store): notification_store 단위테스트(enqueue/exists/due/fire/delete)`.

---

## Task 5: 최종 검증 + critic + 머지

- [ ] **Step 1: 번들** — clippy 0 · test green · `git diff --exit-code src/bindings.ts`=0 · pnpm typecheck/test/build green. 각 로그 Read.

- [ ] **Step 2: 잔여 grep** — `rtk proxy grep -rn "scheduled_notifications" src --include서 비-테스트 SQL`이 `notification_store.rs` + `routines/crud.rs delete_routine_inner`(문서화 예외)만인지 확인. (db.rs는 스키마/마이그레이션·테스트라 정상.)

- [ ] **Step 3: critic** — `oh-my-claudecode:critic`에 `git diff dev...HEAD` + 핵심 파일. INVARIANT #5(bounded scheduler 런타임 무변경)·#7(SSOT) 보존 + 순수 이전(특히 generic화 시 바인드 순서, run_tick 발사 로직, 멱등) 확인. ACCEPT 전 머지 금지.

- [ ] **Step 4: decisions.md** — "품질 후속" F-3 한 줄(공유 테이블 단일소유, generic API, delete_routine_inner inline 예외, fire_at 계산 위치 이동). 커밋.

- [ ] **Step 5: 머지** — `git checkout dev && git merge --ff-only refactor/notification-store && git push origin dev && git branch -d refactor/notification-store`.

- [ ] **Step 6: 후속 상태** — followups 플랜 갱신(notification_store done, routine_store 재가능).

## Self-Review 메모

- Spec coverage: §3 API → Task1; §4.1 scheduler → Task1; §4.2 producer → Task2; §4.3 routine lifecycle → Task3; §5 예외 → Task3 Step3; §6 → Task5.
- Placeholder: 없음(코드/테스트 전문 수록).
- Type consistency: `DueNotification`(store) Task1 정의·scheduler/Task1 사용 일치. `enqueue(...,source_id: Option<&str>)` Task1 정의·Task2 사용(Some/None) 일치. `exists -> bool` Task1·Task2 일치.
