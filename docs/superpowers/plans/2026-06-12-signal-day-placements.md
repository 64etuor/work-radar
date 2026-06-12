# Signal Day Placements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 브레인덤프 카드의 타임라인 배치를 날짜별 레코드(`signal_day_placements`)로 전환해 — 미완료 carry-over 시 트레이 복귀, 날짜별 재배치, 누적 시간 집계(카드 배지 + Weekly Review)를 가능하게 한다.

**Architecture:** 루틴의 `routine_checks(routine_id, date)` 패턴을 시그널에 적용. 새 테이블 `signal_day_placements(signal_id, date, start_at, duration_min, UNIQUE(signal_id,date))`가 **렌더링·집계의 SSOT**. 기존 `signals.scheduled_at/scheduled_duration/linked_*`는 드랍하지 않고 **"최신 배치 + Google 미러 커서"**로 계속 유지한다(캘린더 sync 워커·absorb 로직이 의존; spec §3 "미러는 최신 배치를 따라 이동"과 정합). 배치 쓰기는 전부 `stage_calendar_write_inner`의 `WriteTarget::Signal` 분기 한 곳에 모이므로, 그 안에서 placement 행을 함께 미러한다. 과거 날짜 블록도 정확히 조작할 수 있도록 `WriteOp::Reschedule/Resize/Unschedule`에 `from_date: Option<String>`을 추가하고 FE가 블록의 날짜를 동봉한다.

**Tech Stack:** Rust(sqlx 0.8 + tauri-specta), SQLite migration 0050, React + TanStack Query, vitest.

**Spec:** `docs/superpowers/specs/2026-06-12-signal-day-placements-design.md`

**검증 명령 정본:** `docs/reference/commands.md`. cargo는 `export PATH="$HOME/.cargo/bin:$PATH"` 후 `src-tauri/`에서. `cargo test`가 `src/bindings.ts`를 재생성한다(drift=CI 게이트). git commit도 husky가 cargo fmt를 돌리므로 같은 PATH export 필요.

**탐사로 확정된 사실 (구현자가 다시 조사하지 않아도 됨):**

- `signals.scheduled_at`은 모델 주석("RFC3339 UTC")과 달리 실제로는 **타임존 없는 로컬 ISO** `"YYYY-MM-DDTHH:MM:SS"` (간혹 `+09:00` 오프셋 포함 가능 — `src/lib/timeAxis.ts` 헤더 주석, 테스트 데이터 `"2026-05-28T10:00:00"`). 날짜는 항상 앞 10글자.
- 시그널 배치 쓰기 경로는 **단 한 곳**: `src-tauri/src/commands/calendar_sync.rs::stage_calendar_write_inner` (lines 216–274, `WriteTarget::Signal` 분기).
- `WriteOp::CreateBlank`의 Signal target id는 **placeholder UUID**(실제 signals 행 아님, `calendarSync.ts:203`) — placement FK 위반이므로 CreateBlank은 placement 미러 **제외**.
- 블록 id `signal:${id}`는 다일 배치 시 `buildTimelineBlocks`의 id dedup과 충돌 → id를 `signal:${id}:${date}`로 바꾸고 `TimedBlock.signalId` 필드를 추가해야 한다. id 파싱 소비처 4곳: `src/lib/todayBlocks.ts:19`(blockNoteTarget), `src/components/TodayView.tsx:169`, `src/components/today/useTimelineScheduleActions.ts:34`, `src/components/today/TimelineBlock.tsx:73,112`(stripBlockPrefix).
- Today 레일 fetch(`signal_store::fetch_today`, 롤오버 필터)는 **무변경** — carry-over는 이미 동작.
- 트레이 필터는 `src/components/TodayView.tsx:123` `rail.filter((s) => !s.scheduledAt)` 한 줄.
- 새 PK/카운트 정수는 i32/u32 (specta i64 금지).
- migration 테스트 DB는 빈 DB에 전체 마이그레이션을 돌리므로 백필 SQL은 마이그레이션 시점엔 no-op — 백필 SQL 자체는 store 테스트에서 동일 문장을 재실행해 검증한다(Task 1).

---

### Task 1: Migration 0050 — signal_day_placements 테이블 + 백필

**Files:**

- Create: `src-tauri/migrations/0050_signal_day_placements.sql`
- Test: `src-tauri/src/commands/placement_store.rs` (Task 2에서 생성될 모듈의 테스트에 백필 SQL 검증 포함 — 여기서는 테이블 생성만 커밋)

- [ ] **Step 1: 마이그레이션 파일 작성**

```sql
-- signal_day_placements — 시그널의 날짜별 타임라인 배치 (1일 1블록).
--
-- 배경: signals.scheduled_at/scheduled_duration은 카드당 단일 값이라 (a) 어제 배치한
-- 미완료 카드를 오늘 다시 배치할 수 없고(블록은 그 날짜에 스코프, 트레이는 NULL만 표시),
-- (b) 재배치가 이전 기록을 덮어써 누적 시간 집계가 불가능했다.
-- routine_checks(routine_id, date) 패턴을 시그널에 적용한다.
--
-- SSOT: 렌더링·집계는 이 테이블. signals.scheduled_at/linked_*는 "최신 배치 + Google
-- 미러 커서"로 유지(워커/absorb 의존). 스펙: docs/superpowers/specs/2026-06-12-signal-day-placements-design.md
CREATE TABLE signal_day_placements (
  id           TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,             -- YYYY-MM-DD (로컬, start_at 앞 10글자와 일치)
  start_at     TEXT NOT NULL,             -- 로컬 ISO "YYYY-MM-DDTHH:MM:SS" (scheduled_at과 동일 포맷)
  duration_min INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(signal_id, date)
);

CREATE INDEX idx_signal_day_placements_date ON signal_day_placements(date);

-- 백필: 기존 단일 배치를 그 날짜의 placement 행으로 승계.
-- scheduled_at은 로컬 ISO — 날짜는 항상 앞 10글자(substr 1-based).
INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min)
SELECT lower(hex(randomblob(16))), id, substr(scheduled_at, 1, 10), scheduled_at, scheduled_duration
  FROM signals
 WHERE scheduled_at IS NOT NULL AND scheduled_duration IS NOT NULL;
```

- [ ] **Step 2: 마이그레이션이 적용되는지 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test signal_store 2>&1 | tail -5`
Expected: 기존 테스트 PASS (테스트 DB가 0050까지 마이그레이션 적용 — 실패 시 SQL 문법 오류)

- [ ] **Step 3: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src-tauri/migrations/0050_signal_day_placements.sql
git commit -m "feat(today): add signal_day_placements table for per-day placement"
```

---

### Task 2: 모델 + placement_store.rs (CRUD/집계, TDD)

**Files:**

- Modify: `src-tauri/src/models/signals.rs` (모델 2개 추가, `WorkSignal` struct 뒤)
- Modify: `src-tauri/src/models/mod.rs` (re-export — 파일 열어 기존 `pub use signals::*;` 패턴 확인, 글롭이면 무변경)
- Create: `src-tauri/src/commands/placement_store.rs`
- Modify: `src-tauri/src/commands/mod.rs` (`pub mod placement_store;` — 알파벳 순서상 `pr_radar` 앞)

- [ ] **Step 1: 모델 추가** (`models/signals.rs`, `WorkSignal` 정의 뒤에)

```rust
/// 시그널의 날짜별 타임라인 배치(1일 1블록, UNIQUE(signal_id, date)).
/// 렌더링·누적 집계의 SSOT. signals.scheduled_at은 최신 배치 + Google 미러 커서로 별도 유지.
#[derive(Debug, Clone, Serialize, Deserialize, Type, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SignalDayPlacement {
    pub id: String,
    pub signal_id: String,
    /// YYYY-MM-DD (로컬).
    pub date: String,
    /// 로컬 ISO "YYYY-MM-DDTHH:MM:SS".
    pub start_at: String,
    pub duration_min: i32,
}

/// 카드별 누적 배치 시간(배지용). specta i64 금지 → u32.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SignalTimeTotal {
    pub signal_id: String,
    pub total_min: u32,
    pub day_count: u32,
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `placement_store.rs` 파일을 테스트와 함께 생성. 테스트 셋업은 `signal_store.rs` 하단 `#[cfg(test)]`의 기존 패턴(test DB 헬퍼)을 열어 그대로 복제한다(헬퍼 이름/마이그레이션 적용 방식을 변경하지 말 것).

```rust
//! signal_day_placements 데이터 접근 레이어. 모든 placement SQL의 단일 소유자.
//! 스펙: docs/superpowers/specs/2026-06-12-signal-day-placements-design.md

use crate::db::Db;
use crate::models::{SignalDayPlacement, SignalTimeTotal};

/// (signal_id, date) upsert — 같은 날 재배치/이동은 같은 행 갱신(dedup upsert 관례).
pub(crate) async fn upsert_placement(
    db: &Db,
    signal_id: &str,
    date: &str,
    start_at: &str,
    duration_min: i32,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4) \
         ON CONFLICT(signal_id, date) DO UPDATE SET \
           start_at = excluded.start_at, duration_min = excluded.duration_min, \
           updated_at = datetime('now')",
    )
    .bind(signal_id)
    .bind(date)
    .bind(start_at)
    .bind(duration_min)
    .execute(db)
    .await?;
    Ok(())
}

/// 그 날짜의 배치 제거(트레이 복귀/날짜 이동의 출발지 정리).
pub(crate) async fn delete_placement(
    db: &Db,
    signal_id: &str,
    date: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM signal_day_placements WHERE signal_id = ?1 AND date = ?2")
        .bind(signal_id)
        .bind(date)
        .execute(db)
        .await?;
    Ok(())
}

/// [start, end] inclusive 범위의 placement — 타임라인 렌더용.
pub(crate) async fn fetch_placements_in_range(
    db: &Db,
    start_date: &str,
    end_date: &str,
) -> Result<Vec<SignalDayPlacement>, sqlx::Error> {
    sqlx::query_as::<_, SignalDayPlacement>(
        "SELECT id, signal_id, date, start_at, duration_min \
         FROM signal_day_placements WHERE date BETWEEN ?1 AND ?2 ORDER BY date, start_at",
    )
    .bind(start_date)
    .bind(end_date)
    .fetch_all(db)
    .await
}

/// 카드별 누적 배치 시간 + 배치된 날 수(배지용). Today 레일 카드만 의미 있지만
/// 전체를 반환하고 FE가 매핑한다(레일은 보통 소수 — 스코프 조인 불필요).
pub(crate) async fn fetch_signal_time_totals(db: &Db) -> Result<Vec<SignalTimeTotal>, sqlx::Error> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT signal_id, SUM(duration_min), COUNT(*) \
         FROM signal_day_placements GROUP BY signal_id",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(signal_id, total, days)| SignalTimeTotal {
            signal_id,
            total_min: total.max(0) as u32,
            day_count: days.max(0) as u32,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    // signal_store.rs 테스트의 DB 셋업 헬퍼 패턴을 그대로 복제할 것.

    // 헬퍼: FK 충족용 시그널 삽입.
    async fn insert_sig(db: &Db, id: &str) {
        sqlx::query(
            "INSERT INTO signals (id, title, source, type) VALUES (?1, 'X', 'braindump', 'thought')",
        )
        .bind(id)
        .execute(db)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn upsert_is_idempotent_per_day_and_updates_in_place() {
        // setup db…
        insert_sig(&db, "s1").await;
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T14:00:00", 60).await.unwrap();
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T15:00:00", 90).await.unwrap();
        let rows = fetch_placements_in_range(&db, "2026-06-11", "2026-06-11").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].start_at, "2026-06-11T15:00:00");
        assert_eq!(rows[0].duration_min, 90);
    }

    #[tokio::test]
    async fn totals_sum_across_days() {
        insert_sig(&db, "s1").await;
        upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T14:00:00", 60).await.unwrap();
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T10:00:00", 120).await.unwrap();
        let totals = fetch_signal_time_totals(&db).await.unwrap();
        assert_eq!(totals.len(), 1);
        assert_eq!(totals[0].total_min, 180);
        assert_eq!(totals[0].day_count, 2);
    }

    #[tokio::test]
    async fn delete_removes_only_that_date() {
        insert_sig(&db, "s1").await;
        upsert_placement(&db, "s1", "2026-06-10", "2026-06-10T14:00:00", 60).await.unwrap();
        upsert_placement(&db, "s1", "2026-06-11", "2026-06-11T10:00:00", 30).await.unwrap();
        delete_placement(&db, "s1", "2026-06-10").await.unwrap();
        let rows = fetch_placements_in_range(&db, "2026-06-01", "2026-06-30").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, "2026-06-11");
    }

    /// 0050 백필 SQL의 의미 검증 — 테스트 DB는 빈 채로 마이그레이션되므로
    /// 동일 백필 문장을 scheduled_at 있는 시그널 위에 재실행해 행 생성/날짜 추출을 확인.
    #[tokio::test]
    async fn backfill_statement_creates_row_from_scheduled_at() {
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, scheduled_at, scheduled_duration) \
             VALUES ('s9', 'X', 'braindump', 'thought', '2026-06-10T23:45:00', 45)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO signal_day_placements (id, signal_id, date, start_at, duration_min) \
             SELECT lower(hex(randomblob(16))), id, substr(scheduled_at, 1, 10), scheduled_at, scheduled_duration \
               FROM signals WHERE scheduled_at IS NOT NULL AND scheduled_duration IS NOT NULL",
        )
        .execute(&db)
        .await
        .unwrap();
        let rows = fetch_placements_in_range(&db, "2026-06-10", "2026-06-10").await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, "2026-06-10");
        assert_eq!(rows[0].start_at, "2026-06-10T23:45:00");
        assert_eq!(rows[0].duration_min, 45);
    }
}
```

- [ ] **Step 3: 테스트 실패 확인** (모듈 미등록 상태면 컴파일 에러 = 실패로 간주)

Run: `cd src-tauri && cargo test placement_store 2>&1 | tail -5`
Expected: FAIL/컴파일 에러

- [ ] **Step 4: `commands/mod.rs`에 `pub mod placement_store;` 추가 후 테스트 통과**

Run: `cd src-tauri && cargo test placement_store 2>&1 | tail -5`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models/signals.rs src-tauri/src/commands/placement_store.rs src-tauri/src/commands/mod.rs
git commit -m "feat(today): placement store — per-day upsert/delete/range/totals"
```

---

### Task 3: WriteOp.from_date + stage 경로 placement 미러 (TDD)

**Files:**

- Modify: `src-tauri/src/commands/calendar_sync.rs`
- Test: 같은 파일 `#[cfg(test)]` (기존 테스트 보강 + 신규)

- [ ] **Step 1: 실패하는 테스트 작성** — `calendar_sync.rs` 테스트 모듈에 추가 (기존 테스트의 DB/notify 셋업 패턴 재사용):

```rust
#[tokio::test]
async fn signal_schedule_upserts_day_placement() {
    // setup: signals 행 s1 삽입 (기존 테스트 패턴)
    stage_calendar_write_inner(&pool, &notify, StageWriteRequest {
        target: WriteTarget::Signal { id: "s1".into() },
        op: WriteOp::Schedule {
            at: "2026-06-11T14:00:00".into(), duration_min: 60,
            calendar_id: "cal".into(), title: "X".into(),
        },
        idempotency_key: "k1".into(),
    }).await.unwrap();
    let (date, start, dur): (String, String, i64) = sqlx::query_as(
        "SELECT date, start_at, duration_min FROM signal_day_placements WHERE signal_id='s1'",
    ).fetch_one(&pool).await.unwrap();
    assert_eq!(date, "2026-06-11");
    assert_eq!(start, "2026-06-11T14:00:00");
    assert_eq!(dur, 60);
}

#[tokio::test]
async fn signal_reschedule_across_dates_moves_placement_row() {
    // s1을 6/10에 배치(placement 직접 INSERT 또는 Schedule stage) 후:
    stage_calendar_write_inner(&pool, &notify, StageWriteRequest {
        target: WriteTarget::Signal { id: "s1".into() },
        op: WriteOp::Reschedule {
            at: "2026-06-11T10:00:00".into(), duration_min: 60,
            from_date: Some("2026-06-10".into()),
        },
        idempotency_key: "k2".into(),
    }).await.unwrap();
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT date FROM signal_day_placements WHERE signal_id='s1' ORDER BY date",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(rows, vec![("2026-06-11".to_string(),)]); // 6/10 행 삭제 + 6/11 행 생성
}

#[tokio::test]
async fn signal_reschedule_same_date_keeps_other_days_history() {
    // s1: 6/10 + 6/11 두 placement. 6/11 블록을 6/11 안에서 이동 →
    // 6/10 히스토리는 보존되어야 한다(carry-over 집계의 핵심).
    // …setup…
    stage_calendar_write_inner(&pool, &notify, StageWriteRequest {
        target: WriteTarget::Signal { id: "s1".into() },
        op: WriteOp::Reschedule {
            at: "2026-06-11T16:00:00".into(), duration_min: 30,
            from_date: Some("2026-06-11".into()),
        },
        idempotency_key: "k3".into(),
    }).await.unwrap();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT date, start_at FROM signal_day_placements WHERE signal_id='s1' ORDER BY date",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].0, "2026-06-10");           // 보존
    assert_eq!(rows[1].1, "2026-06-11T16:00:00");  // 갱신
}

#[tokio::test]
async fn signal_unschedule_deletes_only_from_date_placement() {
    // s1: 6/10 + 6/11 placement, linked event 없음.
    stage_calendar_write_inner(&pool, &notify, StageWriteRequest {
        target: WriteTarget::Signal { id: "s1".into() },
        op: WriteOp::Unschedule { from_date: Some("2026-06-11".into()) },
        idempotency_key: "k4".into(),
    }).await.unwrap();
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT date FROM signal_day_placements WHERE signal_id='s1'",
    ).fetch_all(&pool).await.unwrap();
    assert_eq!(rows, vec![("2026-06-10".to_string(),)]);
}
```

주의: `unschedule_without_link_does_not_clear_signal_schedule_or_queue` 테스트(line ~969)가 보여주듯 **링크 없는 unschedule은 `build_queue_row`가 Err를 내 로컬 미러에 도달하지 않을 수 있다**. 신규 unschedule 테스트가 이 경로에 걸리면(Err 반환) 기존 동작에 맞춰 테스트를 조정하라 — placement 삭제도 scheduled_at 미러와 **같은 위치**(queue_row 성공 후)에 두어 분리-상태를 막는 것이 원칙이다. Err 경로면 placement도 보존되는 게 옳다(미러와 동일 운명).

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd src-tauri && cargo test calendar_sync 2>&1 | tail -10`
Expected: 신규 4개 FAIL(컴파일 에러 — from_date 필드 없음)

- [ ] **Step 3: WriteOp에 from_date 추가** (`calendar_sync.rs:56-85`)

```rust
    /// 시간 이동 — patch(start+duration), 기존 linked event 필요, Google API 디바운스.
    /// `from_date`: Signal 타깃 전용 — 이동 출발 블록의 날짜(YYYY-MM-DD).
    /// 날짜가 바뀌는 이동이면 그 날짜의 signal_day_placements 행을 삭제한다.
    /// routine_check/event 타깃에선 무시. None이면 현 scheduled_at의 날짜로 폴백(레거시 큐 행).
    Reschedule {
        at: String,
        duration_min: i32,
        #[serde(default)]
        from_date: Option<String>,
    },
    /// 리사이즈만 — start와 함께 묶어 patch로 보낸다(워커 단순화). 기존 linked event 필요.
    /// `from_date`: Reschedule과 동일 의미(top-핸들 리사이즈는 날짜를 넘을 수 있다).
    Resize {
        at: String,
        duration_min: i32,
        #[serde(default)]
        from_date: Option<String>,
    },
    /// 큐에서 delete → 카드 mirror 정리(scheduled_at/duration/linked_* NULL).
    /// `from_date`: Signal 타깃 전용 — 트레이로 복귀시키는 블록의 날짜.
    /// 그 날짜의 placement 행만 삭제한다(과거 날짜 히스토리는 보존).
    Unschedule {
        #[serde(default)]
        from_date: Option<String>,
    },
```

`WriteOp::Unschedule`이 unit → struct variant가 되므로 **컴파일러를 따라 모든 매치/생성 지점을 고친다**: 패턴은 `WriteOp::Unschedule { .. }`, 생성은 `WriteOp::Unschedule { from_date: None }` (기존 Rust 테스트들 + `validate_write_op` + `build_queue_row` + 워커 쪽 매치). `Reschedule`/`Resize` 기존 생성부엔 `from_date: None` 추가. 동작 의미는 무변경.

- [ ] **Step 4: stage_calendar_write_inner에 placement 미러 추가** — `WriteTarget::Signal` 분기(line 216~) 를 다음으로 교체:

```rust
    if let WriteTarget::Signal { id } = &req.target {
        // placement from_date 폴백용 — 미러 UPDATE 전에 읽는다(이후엔 새 값으로 덮임).
        let prev_date: Option<String> =
            sqlx::query_scalar("SELECT substr(scheduled_at, 1, 10) FROM signals WHERE id = ?1")
                .bind(id)
                .fetch_optional(pool)
                .await?
                .flatten();
        match &req.op {
            WriteOp::Schedule {
                at,
                duration_min,
                calendar_id,
                ..
            } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2, \
                     linked_calendar_id = ?3 WHERE id = ?4",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(calendar_id)
                .bind(id)
                .execute(pool)
                .await?;
                // 날짜별 배치 SSOT 미러 — 트레이→캔버스 신규 배치는 그 날짜 행 upsert.
                placement_store::upsert_placement(pool, id, local_date_of(at), at, *duration_min)
                    .await?;
            }
            // CreateBlank의 Signal id는 placeholder UUID(실 카드 아님) — FK 위반이므로
            // placement 미러 제외. scheduled_at UPDATE는 기존처럼 0행 no-op.
            WriteOp::CreateBlank {
                at,
                duration_min,
                calendar_id,
                ..
            } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2, \
                     linked_calendar_id = ?3 WHERE id = ?4",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(calendar_id)
                .bind(id)
                .execute(pool)
                .await?;
            }
            WriteOp::Reschedule {
                at,
                duration_min,
                from_date,
            }
            | WriteOp::Resize {
                at,
                duration_min,
                from_date,
            } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = ?1, scheduled_duration = ?2 WHERE id = ?3",
                )
                .bind(at)
                .bind(*duration_min)
                .bind(id)
                .execute(pool)
                .await?;
                // 날짜를 넘는 이동이면 출발 날짜 행 삭제(같은 날이면 upsert가 그 행을 갱신).
                let new_date = local_date_of(at);
                let src = from_date.as_deref().or(prev_date.as_deref());
                if let Some(src) = src {
                    if src != new_date {
                        placement_store::delete_placement(pool, id, src).await?;
                    }
                }
                placement_store::upsert_placement(pool, id, new_date, at, *duration_min).await?;
            }
            WriteOp::Unschedule { from_date } => {
                sqlx::query(
                    "UPDATE signals SET scheduled_at = NULL, scheduled_duration = NULL, \
                     linked_event_id = NULL, linked_calendar_id = NULL WHERE id = ?1",
                )
                .bind(id)
                .execute(pool)
                .await?;
                // 그 날짜의 배치만 트레이 복귀 — 과거 날짜 placement는 누적 집계 히스토리로 보존.
                if let Some(src) = from_date.as_deref().or(prev_date.as_deref()) {
                    placement_store::delete_placement(pool, id, src).await?;
                }
            }
            // MoveCalendar는 staged — Acceptance 게이트 전까지 로컬 mirror도 보류.
            // commit_staged_writes 시점이 아니라 워커 flush 시 link_back에서 반영된다.
            WriteOp::MoveCalendar { .. } => {}
        }
    }
```

파일 상단 use에 `use crate::commands::placement_store;` 추가, `extract_hhmm` 근처에 헬퍼 추가:

```rust
/// 로컬 ISO 'YYYY-MM-DD…'에서 날짜 10글자. validate_write_op가 빈 at을 선차단하므로
/// 짧은 입력은 방어적으로 전체 문자열 반환(placement date 불일치는 upsert가 무해).
fn local_date_of(at: &str) -> &str {
    at.get(0..10).unwrap_or(at)
}
```

- [ ] **Step 5: 전체 cargo 게이트 통과 확인 (bindings 재생성 포함)**

Run: `cd src-tauri && cargo test 2>&1 | tail -5 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check`
Expected: 전부 green. `git status`에 `src/bindings.ts` 변경(WriteOp에 from_date) 확인.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/calendar_sync.rs src/bindings.ts
git commit -m "feat(today): mirror signal day placements in stage_calendar_write (from_date op field)"
```

---

### Task 4: 읽기 IPC — list_signal_placements / signal_time_totals

**Files:**

- Create: `src-tauri/src/commands/today/placements.rs`
- Modify: `src-tauri/src/commands/today/mod.rs` (모듈 선언 + re-export — 파일 열어 `weekly`/`rail` 기존 패턴 그대로)
- Modify: `src-tauri/src/lib.rs` (collect_commands에 2개 등록 — `commands::weekly_review` 근처 line ~108)

- [ ] **Step 1: 커맨드 작성** (`today/placements.rs`)

```rust
use tauri::State;

use crate::commands::placement_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{SignalDayPlacement, SignalTimeTotal};

/// [start_date, end_date] inclusive 범위의 날짜별 배치 — 타임라인 렌더용 (read only).
#[tauri::command]
#[specta::specta]
pub async fn list_signal_placements(
    db: State<'_, Db>,
    start_date: String,
    end_date: String,
) -> Result<Vec<SignalDayPlacement>, AppError> {
    Ok(placement_store::fetch_placements_in_range(db.inner(), &start_date, &end_date).await?)
}

/// 카드별 누적 배치 시간/일수 — Today 카드 배지용 (read only).
#[tauri::command]
#[specta::specta]
pub async fn signal_time_totals(db: State<'_, Db>) -> Result<Vec<SignalTimeTotal>, AppError> {
    Ok(placement_store::fetch_signal_time_totals(db.inner()).await?)
}
```

- [ ] **Step 2: today/mod.rs 선언 + lib.rs 등록** — `commands::list_signal_placements,` / `commands::signal_time_totals,`를 `commands::weekly_review,` 옆에 추가.

- [ ] **Step 3: cargo test로 컴파일+바인딩 재생성 확인**

Run: `cd src-tauri && cargo test 2>&1 | tail -3`
Expected: PASS. `src/bindings.ts`에 `listSignalPlacements`/`signalTimeTotals` + `SignalDayPlacement`/`SignalTimeTotal` 타입 생성 확인:
`grep -n "listSignalPlacements\|signalTimeTotals" src/bindings.ts` → 매치 존재.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/today/placements.rs src-tauri/src/commands/today/mod.rs src-tauri/src/lib.rs src/bindings.ts
git commit -m "feat(today): list_signal_placements + signal_time_totals IPC"
```

---

### Task 5: Weekly 시간 집계 (백엔드)

**Files:**

- Modify: `src-tauri/src/models/today.rs` (`WeeklyReview`에 필드 추가 + 구조체 2개)
- Modify: `src-tauri/src/commands/today/weekly.rs` (쿼리 + 조립)
- Test: `weekly.rs` 또는 기존 weekly 테스트 위치에 추가 (기존 `fetch_weekly_review` 테스트가 있으면 그 옆, 없으면 `placement_store` 스타일로 신규)

- [ ] **Step 1: 모델 추가** (`models/today.rs` 끝, `use super::WorkSignal;` 옆에 `use super::AreaTag;` 추가)

```rust
/// 주간 영역별 배치 시간 한 줄. area=NULL은 미태깅 카드 묶음.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyAreaTime {
    pub area: Option<AreaTag>,
    pub total_min: u32,
}

/// 주간 배치 시간 합산(signal_day_placements 기반). 배치=시간 사용으로 간주(스펙 §요구사항).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyTimeSpent {
    pub total_min: u32,
    pub by_area: Vec<WeeklyAreaTime>,
}
```

`WeeklyReview`에 `pub time_spent: WeeklyTimeSpent,` 추가.

- [ ] **Step 2: 실패하는 테스트** — 시그널 2개(area 다름) + placement 3행(주 범위 2행/범위 밖 1행) 삽입 후 `fetch_weekly_review` 호출, `time_spent.total_min`이 범위 내 합, `by_area` 그루핑 검증.

```rust
#[tokio::test]
async fn weekly_time_spent_sums_placements_in_range_by_area() {
    // s1(area='health'): 6/09 60분, s2(area=NULL): 6/10 30분, s1: 6/01 999분(범위 밖)
    // …signals + signal_day_placements INSERT…
    let review = fetch_weekly_review(&db, "2026-06-12").await.unwrap(); // 범위 [06-06, 06-12]
    assert_eq!(review.time_spent.total_min, 90);
    assert_eq!(review.time_spent.by_area.len(), 2);
}
```

- [ ] **Step 3: 구현** (`weekly.rs`, debt_trend 블록 앞에)

```rust
    // 배치 시간 합산 — signal_day_placements(날짜별 배치 SSOT) 기반. 배치=시간 사용 간주.
    let area_rows: Vec<(Option<AreaTag>, i64)> = sqlx::query_as(
        "SELECT s.area, SUM(p.duration_min) \
           FROM signal_day_placements p JOIN signals s ON s.id = p.signal_id \
          WHERE p.date BETWEEN ?1 AND ?2 \
          GROUP BY s.area ORDER BY SUM(p.duration_min) DESC",
    )
    .bind(&start_s)
    .bind(&end_s)
    .fetch_all(db)
    .await?;
    let time_spent = WeeklyTimeSpent {
        total_min: area_rows.iter().map(|(_, m)| (*m).max(0) as u32).sum(),
        by_area: area_rows
            .into_iter()
            .map(|(area, m)| WeeklyAreaTime {
                area,
                total_min: m.max(0) as u32,
            })
            .collect(),
    };
```

`WeeklyReview { …, time_spent }` 조립에 추가, use에 `AreaTag, WeeklyAreaTime, WeeklyTimeSpent` 추가.

- [ ] **Step 4: 게이트**

Run: `cd src-tauri && cargo test 2>&1 | tail -3 && cargo clippy --all-targets -- -D warnings 2>&1 | tail -3 && cargo fmt --check`
Expected: green, bindings.ts에 `WeeklyTimeSpent` 생성.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models/today.rs src-tauri/src/commands/today/weekly.rs src/bindings.ts
git commit -m "feat(weekly): time-spent aggregation from signal day placements"
```

---

### Task 6: FE stage 배관 — fromDate 동봉

**Files:**

- Modify: `src/lib/calendarSync.ts` (StageInput + toRequest)
- Modify: `src/components/today/useTimelineDnd.ts` (signal reschedule/resize/unschedule 호출부)
- Modify: `src/components/today/useTimelineScheduleActions.ts` (signal 삭제 경로)

- [ ] **Step 1: StageInput 확장** (`calendarSync.ts`) — 시그널용 3개 variant에 추가:

```ts
  | {
      kind: "reschedule";
      targetSignalId: string;
      at: string;
      durationMin: number;
      /** 이동 출발 블록의 날짜(YYYY-MM-DD) — 날짜를 넘는 이동 시 그 날의 placement 행 삭제. */
      fromDate?: string;
    }
  | {
      kind: "resize";
      targetSignalId: string;
      at: string;
      durationMin: number;
      fromDate?: string;
    }
```

`unschedule` variant: `{ kind: "unschedule"; targetSignalId: string; fromDate?: string }`.

`toRequest` 매핑 — bindings 재생성 후 `WriteOp`의 정확한 TS 형태(`from_date` 필수 nullable일 가능성 높음)에 맞춘다:

```ts
    case "reschedule": {
      const target: WriteTarget = { kind: "signal", id: i.targetSignalId };
      const op: WriteOp = {
        op: "reschedule",
        at: i.at,
        duration_min: i.durationMin,
        from_date: i.fromDate ?? null,
      };
      return { target, op, idempotency_key };
    }
```

`resize` 동일. `unschedule`(signal): `{ op: "unschedule", from_date: i.fromDate ?? null }`. **event/routine 경로의 reschedule/resize/unschedule도 같은 WriteOp 타입을 쓰므로 `from_date: null`을 추가**(eventReschedule/eventResize/eventUnschedule/routineReschedule/routineResize/routineUnschedule — 백엔드는 Signal 타깃에서만 읽음).

- [ ] **Step 2: 호출부에 fromDate 전달** (`useTimelineDnd.ts`)

- resize 분기(line ~383): `stage({ kind: "resize", targetSignalId: a.signalId, at, durationMin: clamped, fromDate: localDateOf(a.startISO) })`
- reschedule 분기(line ~448): `stage({ kind: "reschedule", targetSignalId: a.signalId, at, durationMin: a.durationMin, fromDate: localDateOf(a.startISO) })`
- unschedule 분기(line ~476): `stage({ kind: "unschedule", targetSignalId: signalId, fromDate: localDateOf(prevAt) })`
- unschedule undo(line ~481): `stage({ kind: "reschedule", targetSignalId: signalId, at: prevAt, durationMin: prevDur, fromDate: localDateOf(prevAt) })` (같은 날 upsert = 복원)

`useTimelineScheduleActions.ts:35`: `await stage({ kind: "unschedule", targetSignalId: signalId, fromDate: occDate });`

- [ ] **Step 3: 타입 체크**

Run: `pnpm typecheck`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/calendarSync.ts src/components/today/useTimelineDnd.ts src/components/today/useTimelineScheduleActions.ts
git commit -m "feat(today): pass placement fromDate through stage pipeline"
```

---

### Task 7: FE 블록 렌더링 — placements 기반 시그널 블록 (TDD)

**Files:**

- Modify: `src/lib/timelineLayout.ts` (TimedBlock에 `signalId?: string`)
- Modify: `src/lib/todayBlocks.ts` (Input에 placements, 시그널 블록 빌드 교체, blockNoteTarget)
- Modify: `src/components/today/TimelineBlock.tsx` (DragData의 signalId — `stripBlockPrefix` 대신 `block.signalId`)
- Modify: `src/components/TodayView.tsx:169` / `src/components/today/useTimelineScheduleActions.ts:34` (id 파싱 → `block.signalId`)
- Test: `src/lib/todayBlocks.test.ts` (기존 테스트 파일 위치 확인 — 없으면 신규; `buildTodayBlocks` 기존 테스트가 다른 파일에 있으면 그곳에)

- [ ] **Step 1: 실패하는 테스트** — placements 기반 동작:

```ts
import { describe, expect, it } from "vitest";
import { buildTodayBlocks, buildTimelineBlocks } from "./todayBlocks";

// 기존 테스트 헬퍼(시그널/이벤트 fixture)가 있으면 재사용. 핵심 케이스:
describe("placement-based signal blocks", () => {
  const sig = makeSignal({ id: "s1", title: "X" }); // scheduledAt 없이도 블록이 떠야 한다
  const p = (date: string, hhmm: string, dur: number) => ({
    id: `pl-${date}`,
    signalId: "s1",
    date,
    startAt: `${date}T${hhmm}:00`,
    durationMin: dur,
  });

  it("renders a block from the viewed date's placement (not scheduledAt)", () => {
    const blocks = buildTodayBlocks({
      signals: [sig],
      placements: [p("2026-06-11", "14:00", 60)],
      events: [],
      routines: [],
      date: "2026-06-11",
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("signal:s1:2026-06-11");
    expect(blocks[0].signalId).toBe("s1");
    expect(blocks[0].startISO).toBe("2026-06-11T14:00:00");
  });

  it("multi-day: same signal renders one block per placed date, no dedup collision", () => {
    const placements = [p("2026-06-10", "14:00", 60), p("2026-06-11", "10:00", 120)];
    const blocks = buildTimelineBlocks({
      signals: [sig],
      placements,
      eventsByDate: {},
      routinesByDate: {},
      dates: ["2026-06-10", "2026-06-11"],
    });
    expect(blocks.filter((b) => b.kind === "signal")).toHaveLength(2);
  });

  it("no placement on viewed date -> no signal block (tray case)", () => {
    const blocks = buildTodayBlocks({
      signals: [sig],
      placements: [p("2026-06-10", "14:00", 60)],
      events: [],
      routines: [],
      date: "2026-06-11",
    });
    expect(blocks).toHaveLength(0);
  });
});
```

Run: `pnpm vitest run src/lib/todayBlocks.test.ts` → FAIL

- [ ] **Step 2: 구현**

`timelineLayout.ts` TimedBlock에:

```ts
  /** signal 블록의 원본 signal id — id는 `signal:${id}:${date}`라 파싱 대신 이 필드를 쓴다. */
  signalId?: string;
```

`todayBlocks.ts`:

- `import type { SignalDayPlacement } from "@/bindings";`, Input에 `placements: SignalDayPlacement[];`
- 시그널 루프(line 132-151) 교체:

```ts
const signalById = new Map(signals.map((s) => [s.id, s]));
for (const p of placements) {
  if (p.date !== date) continue;
  const s = signalById.get(p.signalId);
  if (!s) continue; // 레일 밖 시그널(완료 후 미표시 등) — 블록 생략
  out.push({
    id: `signal:${s.id}:${date}`, // 날짜 포함 — 다일 배치 시 buildTimelineBlocks dedup 충돌 방지
    kind: "signal",
    signalId: s.id,
    title: s.title,
    startISO: p.startAt,
    endISO: plusMinutesLocal(p.startAt, p.durationMin),
    calendarId: s.linkedCalendarId ?? "",
    calendarLabel: s.linkedCalendarId ?? "",
    color: SIGNAL_COLOR,
    linkedEventId: s.linkedEventId ?? undefined,
    done: Boolean(s.todayDoneAt),
  });
  // Google 미러 absorb — 미러는 최신 배치(scheduled_at)를 따라가므로 그 날짜에서만 흡수.
  if (s.scheduledAt && localDateOf(s.scheduledAt) === date) {
    const key = eventKey(s.linkedCalendarId, s.linkedEventId);
    if (key) absorbed.add(key);
  }
}
```

- `blockNoteTarget`(line 15-19): Pick에 `"signalId"` 추가, signal 분기를 `targetId: block.signalId ?? block.id.replace(/^signal:/, "")`로 (구 형식 호환 폴백).
- `buildTimelineBlocks`: 파라미터에 `placements: SignalDayPlacement[]` 추가해 `buildTodayBlocks`로 전달. doc 주석의 "signal은 1회만" 문구를 "signal은 placement 날짜별 별개 블록(id에 날짜 포함)"으로 갱신.

소비처 파싱 교체:

- `TodayView.tsx:169`: `const id = block.signalId ?? block.id.replace(/^signal:/, "");`
- `useTimelineScheduleActions.ts:34`: `const signalId = block.signalId ?? block.id.replace(/^signal:/, "");`
- `TimelineBlock.tsx:73,112`: `signalId: block.signalId ?? stripBlockPrefix(block.id, "signal"),`

- [ ] **Step 3: 테스트/타입 통과** — `buildTodayBlocks`/`buildTimelineBlocks` 기존 호출부(테스트 포함)에 `placements: []` 추가가 필요할 수 있다. `pnpm typecheck`가 전부 찾아준다.

Run: `pnpm typecheck && pnpm vitest run`
Expected: green (timelinePreview.test.ts, TimelineBlock.test.ts, useTimelineDnd.test.ts 회귀 포함)

- [ ] **Step 4: Commit**

```bash
git add src/lib/timelineLayout.ts src/lib/todayBlocks.ts src/lib/todayBlocks.test.ts src/components/TodayView.tsx src/components/today/TimelineBlock.tsx src/components/today/useTimelineScheduleActions.ts
git commit -m "feat(today): render signal blocks from per-day placements"
```

---

### Task 8: FE TodayView 와이어링 — placements 쿼리 · 트레이 필터 · optimistic (TDD)

**Files:**

- Modify: `src/lib/query/today.ts` (훅 2개)
- Modify: `src/lib/optimisticSchedule.ts` (placement 패치 순수함수)
- Test: `src/lib/optimisticSchedule.test.ts` (있으면 추가, 없으면 신규)
- Modify: `src/components/TodayView.tsx` (쿼리 + 트레이 필터 + blocks 입력)
- Modify: `src/components/today/useTimelineDnd.ts` (optimistic placement 패치 + invalidate)

- [ ] **Step 1: 쿼리 훅** (`query/today.ts`)

```ts
/** [start,end] 범위 날짜별 배치 — 타임라인 시그널 블록의 SSOT. */
export function useSignalPlacements(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ["signalPlacements", startDate, endDate],
    queryFn: () => unwrap(commands.listSignalPlacements(startDate, endDate)),
  });
}

/** 카드별 누적 배치 시간(분)/일수 — Today 카드 배지. */
export function useSignalTimeTotals() {
  return useQuery({
    queryKey: ["signalTimeTotals"],
    queryFn: () => unwrap(commands.signalTimeTotals()),
  });
}
```

(`src/lib/query/index.ts`가 모듈별 re-export면 자동 — 아니면 export 추가.)

- [ ] **Step 2: optimistic 순수함수 + 테스트** (`optimisticSchedule.ts`)

```ts
import type { SignalDayPlacement, WorkSignal } from "@/bindings";

export type PlacementPatch =
  | { type: "upsert"; date: string; startAt: string; durationMin: number }
  | { type: "move"; fromDate: string; date: string; startAt: string; durationMin: number }
  | { type: "remove"; date: string };

/** ["signalPlacements"] 캐시 즉시 패치 — 드래그 직후 스냅백 방지. refetch가 정본으로 교체. */
export function applyPlacementPatch(
  placements: SignalDayPlacement[],
  signalId: string,
  patch: PlacementPatch,
): SignalDayPlacement[] {
  const without = (date: string) =>
    placements.filter((p) => !(p.signalId === signalId && p.date === date));
  if (patch.type === "remove") return without(patch.date);
  const base = patch.type === "move" ? without(patch.fromDate) : placements;
  const rest = base.filter((p) => !(p.signalId === signalId && p.date === patch.date));
  return [
    ...rest,
    {
      id: `optimistic:${signalId}:${patch.date}`,
      signalId,
      date: patch.date,
      startAt: patch.startAt,
      durationMin: patch.durationMin,
    },
  ];
}
```

테스트(신규/기존 파일): upsert가 같은 (signal,date) 행을 교체, move가 fromDate 행 제거+새 날짜 추가, remove가 해당 날짜만 제거(다른 날짜 보존), 타 시그널 무영향 — 4케이스.

Run: `pnpm vitest run src/lib/optimisticSchedule.test.ts` → 구현 전 FAIL → 구현 → PASS

- [ ] **Step 3: useTimelineDnd 패치 적용** — `patchSignalCaches` 옆에:

```ts
const patchPlacementCaches = (signalId: string, patch: PlacementPatch) => {
  qc.setQueriesData<SignalDayPlacement[]>({ queryKey: ["signalPlacements"] }, (old) =>
    old ? applyPlacementPatch(old, signalId, patch) : old,
  );
};
```

각 시그널 분기에서 기존 `patchSignalCaches` 직후 호출:

- schedule(#1): `patchPlacementCaches(a.signalId, { type: "upsert", date: localDateOf(at), startAt: at, durationMin });`
- resize(#3 signal): `patchPlacementCaches(a.signalId, { type: "move", fromDate: localDateOf(a.startISO), date: localDateOf(at), startAt: at, durationMin: clamped });`
- reschedule(#2 signal): 동일 패턴(`durationMin: a.durationMin`).
- unschedule(#4): `patchPlacementCaches(signalId, { type: "remove", date: localDateOf(prevAt) });`

`invalidateSignalCaches`에 추가:

```ts
void qc.invalidateQueries({ queryKey: ["signalPlacements"] });
void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
```

또한 각 시그널 분기 stage 성공 후에도 `void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });` 1줄 추가(배지 즉시 갱신; placements는 optimistic 패치가 이미 반영, 실패 시 invalidate가 정리).

- [ ] **Step 4: TodayView 와이어링**

```ts
const placementsQ = useSignalPlacements(
  visibleDates[0] ?? today,
  visibleDates[visibleDates.length - 1] ?? today,
);
const placements = placementsQ.data ?? [];
```

(visibleDates가 오름차순인지 `useTimelineScroll.ts`에서 확인 — 아니면 min/max로.)

트레이 필터(line 123) 교체:

```ts
// carry-over: 미완료 카드가 "보는 날짜"에 배치가 없으면 트레이 — 과거 배치 기록은 보존된다.
const placedOnDate = new Set(placements.filter((p) => p.date === date).map((p) => p.signalId));
const unscheduledTodays = rail.filter((s) => !placedOnDate.has(s.id));
```

blocks 입력에 `placements` 추가:

```ts
const blocks = buildTimelineBlocks({
  signals: rail,
  placements,
  eventsByDate: eventsQ.byDate,
  routinesByDate: routinesQ.byDate,
  dates: visibleDates,
});
```

`useTimelineScheduleActions.ts`의 삭제 경로 invalidate에도 `["signalPlacements"]`/`["signalTimeTotals"]` 추가.

- [ ] **Step 5: 게이트**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/lib/query/today.ts src/lib/optimisticSchedule.ts src/lib/optimisticSchedule.test.ts src/components/TodayView.tsx src/components/today/useTimelineDnd.ts src/components/today/useTimelineScheduleActions.ts
git commit -m "feat(today): placements query + tray carry-over filter + optimistic placement patch"
```

---

### Task 9: 카드 배지 — "누적 Xh · N일째" (TDD)

**Files:**

- Create: `src/lib/timeTotals.ts` + `src/lib/timeTotals.test.ts`
- Modify: `src/components/today/UnscheduledTray.tsx` (prop + footer)
- Modify: `src/components/TodayView.tsx` (totals 전달)

- [ ] **Step 1: 포맷/age 순수함수 + 테스트**

```ts
// src/lib/timeTotals.ts
/** 분 → "45m" | "3h" | "1h 30m". */
export function fmtMinutes(min: number): string {
  if (min <= 0) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Today 등록 후 경과일(1일째부터) — frontend-board 정본 공식 (today − today_for_date) + 1. */
export function todayAgeDays(todayForDate: string, today: string): number {
  const diff =
    new Date(`${today}T00:00:00`).getTime() - new Date(`${todayForDate}T00:00:00`).getTime();
  return Math.max(0, Math.round(diff / 86_400_000)) + 1;
}
```

테스트: `fmtMinutes(45)="45m"`, `fmtMinutes(180)="3h"`, `fmtMinutes(90)="1h 30m"`, `fmtMinutes(0)="0m"`; `todayAgeDays("2026-06-10","2026-06-12")=3`, 같은 날=1.
(구현 시 `(today − today_for_date)+1` age 공식이 보드 코드에 이미 있으면 — `grep -rn "일째" src/` — 재사용하고 이 헬퍼는 만들지 않는다.)

Run: `pnpm vitest run src/lib/timeTotals.test.ts` → FAIL → 구현 → PASS

- [ ] **Step 2: UnscheduledTray에 배지** — Props에 추가:

```ts
  /** signalId → 누적 배치 시간(분)/일수. 없으면 배지 생략. */
  totals?: Map<string, { totalMin: number; dayCount: number }>;
  /** 로컬 오늘(YYYY-MM-DD) — N일째 계산. */
  today: string;
```

`SignalDraggableCard`에 `badge?: string` prop 추가, footer 교체:

```tsx
      footer={badge ?? shortDate(signal.createdAt)}
```

`UnscheduledTray` 본문 map에서:

```tsx
const t = totals?.get(s.id);
const badge =
  t && s.todayForDate
    ? `누적 ${fmtMinutes(t.totalMin)} · ${todayAgeDays(s.todayForDate, today)}일째`
    : undefined;
```

(JSX map 안 변수 — map 콜백을 블록 바디로 바꿔 계산 후 `<SignalDraggableCard … badge={badge} />`.)

- [ ] **Step 3: TodayView에서 전달**

```ts
const totalsQ = useSignalTimeTotals();
const totalsBySignal = new Map(
  (totalsQ.data ?? []).map((t) => [t.signalId, { totalMin: t.totalMin, dayCount: t.dayCount }]),
);
```

`<UnscheduledTray … totals={totalsBySignal} today={today} />`.

- [ ] **Step 4: 게이트 + Commit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`

```bash
git add src/lib/timeTotals.ts src/lib/timeTotals.test.ts src/components/today/UnscheduledTray.tsx src/components/TodayView.tsx
git commit -m "feat(today): cumulative time badge on tray cards"
```

---

### Task 10: Weekly Review 시간 섹션

**Files:**

- Modify: `src/components/WeeklyView.tsx`
- Modify: `src/components/WeeklyView.css` (필요한 최소 스타일 — 기존 `wk-sec`/`wk-stats` 재사용 우선, 색은 DESIGN 토큰만)

- [ ] **Step 1: KPI 스트립에 "배치 시간" 섹션 추가** — `wk-kpis` 안 PR 활동 섹션 뒤:

```tsx
<section className="wk-sec">
  <div className="wk-sec-head">
    <Clock className="text-wr-subtle size-4" />
    <span className="wk-sec-name">배치 시간</span>
  </div>
  <div className="wk-stats wk-stats-2">
    <StatTile
      icon={<Clock className="size-4" />}
      label="총 배치"
      value={fmtMinutes(data?.timeSpent?.totalMin ?? 0)}
    />
  </div>
  {(data?.timeSpent?.byArea ?? []).length > 0 && (
    <ul className="wk-time-areas">
      {(data?.timeSpent?.byArea ?? []).map((row) => (
        <li key={row.area ?? "untagged"} className="wk-time-area">
          <span>{row.area ? areaLabel(row.area) : "미태깅"}</span>
          <span>{fmtMinutes(row.totalMin)}</span>
        </li>
      ))}
    </ul>
  )}
</section>
```

- import: `Clock`(lucide), `fmtMinutes`(`@/lib/timeTotals`), `areaLabel`(`@/components/board/boardUtils`).
- `StatTile`의 `value: number`를 `value: number | string`으로 확장.
- **주의**: `weeklyReview` 쿼리는 persist 대상(`src/lib/query/persist.ts`) — 구버전 캐시엔 `timeSpent`가 없으므로 모든 접근은 `data?.timeSpent?.…` 옵셔널 체인(위 코드처럼).
- `wk-time-areas` 스타일은 기존 WeeklyView.css 리스트 패턴에 맞춰 최소(행간/양끝 정렬). **TSX에 하드코딩 색 금지**(design-tokens 가드).

- [ ] **Step 2: 게이트 + Commit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`

```bash
git add src/components/WeeklyView.tsx src/components/WeeklyView.css
git commit -m "feat(weekly): placement time-spent section (total + by area)"
```

---

### Task 11: 풀 게이트 · 문서 · 마무리

**Files:**

- Modify: `docs/decisions.md` (한 줄 append)
- Modify: `docs/areas/today-timeline.md` (placement SSOT 한 단락 — 기존 §데이터 부분에)

- [ ] **Step 1: 전체 게이트 실행** (`docs/reference/commands.md` 정본)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check && cd ..
pnpm typecheck && pnpm lint && pnpm vitest run
git status --short   # bindings.ts drift 0 (커밋된 상태) 확인
```

Expected: 전부 green. 실패 시 고치고 재실행 — prose로 우회 금지.

- [ ] **Step 2: 문서**

`docs/decisions.md`에 append:

```
- 2026-06-12 signal_day_placements: 시그널 타임라인 배치를 날짜별 행(UNIQUE(signal_id,date))으로 전환 — carry-over 트레이 복귀/재배치/누적 시간 집계. signals.scheduled_at은 최신 배치+Google 미러 커서로 유지(드랍은 후속). 스펙: docs/superpowers/specs/2026-06-12-signal-day-placements-design.md
```

`docs/areas/today-timeline.md`의 데이터 설명에 placement 테이블 역할(렌더/집계 SSOT vs scheduled_at=미러 커서) 한 단락 추가.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions.md docs/areas/today-timeline.md
git commit -m "docs(today): record signal_day_placements decision + area doc"
```

- [ ] **Step 4: 별도 reviewer 패스** — AGENTS.md 규칙: self-approve 금지. critic(opus) 별도 패스로 INVARIANT(특히 #1 사용자 결정권 — 자동 배치 없음 확인, #3 dedup upsert, #7 SQLite SSOT) + 회귀(루틴 경로 무변경: `calendar_sync.rs` 루틴 테스트 green) 검토 후 ACCEPT까지 반영.

- [ ] **Step 5: 라이브 스모크는 사용자/cmux** — `pnpm tauri dev` 부팅 + 어제 배치 미완료 카드의 트레이 복귀/재배치/배지 확인은 에이전트가 실행 못 하면 "could not run"으로 명시 보고.

---

## 자기 검토 노트 (스펙 대비)

- 스펙 §2 "fetch_today에 placement LEFT JOIN" → 구현은 **별도 `list_signal_placements` 쿼리**로 변경: 타임라인이 다일(visibleDates) 렌더라 단일 날짜 join보다 범위 쿼리가 맞고, `WorkSignal` 구조체 오염을 피한다. 의미는 동일(그 날짜 placement 유무 = 트레이 판정).
- 스펙 §1 "scheduled_at 읽기/쓰기 중단" → **부분 유지로 정정**: 쓰기(미러 커서)는 계속, 블록 렌더/트레이 판정 읽기만 placements로 이전. Google 미러가 "최신 배치를 따라간다"(§3)는 결정이 이 커서를 요구한다. 컬럼 드랍 불가 사유와 동일하게 후속 정리 대상.
- 하루 1블록(UNIQUE) / 자동 복제 없음 / 배지+Weekly 둘 다 — 전부 태스크로 커버(T1, T8 트레이 필터, T9, T10).
