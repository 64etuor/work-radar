# Today×Timeline PR 6 — 루틴 time_override & Linked Event 라이프사이클

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 루틴의 `time_of_day` 기반 자동 시간축 배치를 완성. 드래그로 오늘 인스턴스만 시간 변경(`time_override`) + Google 이벤트 mirror. 트레이로 빼면 override clear + Google delete. 정의 자체 변경은 RoutinesPanel에서만 (본 PR 무관).

**Architecture:** PR 4의 `buildTodayBlocks`가 이미 time_override > time_of_day 우선이고 PR 5의 dispatcher가 `routineSchedule`/`routineUnschedule`을 매핑함. 본 PR은 (a) 인스턴스가 정의 시간 기반인데 linked_event가 없을 때 "처음 드래그하면 create" 흐름과 (b) override가 있는데 사용자가 다음날 화면을 봐도 그 날은 다시 정의 시간으로 돌아옴을 보장 + (c) Routines 정의 시간 변경 시 동기화 정책 정리.

**Tech Stack:** Rust (signal sync.rs 확장), React.

**Spec:** §4.3, §7 루틴 특수, §D10. **Depends on:** PR 1, PR 2, PR 4, PR 5.

---

### Task 1: routine_check 자동 행 생성 (드래그 시점)

**Files:**

- Modify: `src-tauri/src/commands/calendar_sync.rs`

문제: `stage_calendar_write`가 `RoutineCheck { routine_id, date }`를 받지만 그 행이 routine_check 테이블에 아직 없을 수 있음 (오늘 처음 인터랙션). UPDATE/SELECT가 0행 영향이 되어 link_back/fetch_linked_event가 실패. → 큐잉 직전 idempotent INSERT 보장.

- [ ] **Step 1: helper 함수 추가**

```rust
async fn ensure_routine_check_row(pool: &SqlitePool, routine_id: &str, date: &str) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO routine_check (routine_id, date, done)
         VALUES (?, ?, 0)
         ON CONFLICT(routine_id, date) DO NOTHING"
    ).bind(routine_id).bind(date).execute(pool).await?;
    Ok(())
}
```

(routine_check PK 또는 UNIQUE가 (routine_id, date)임을 가정. 아니면 마이그레이션 0011 확인 후 UNIQUE 추가 마이그레이션 필요.)

- [ ] **Step 2: stage_calendar_write 진입부에서 호출**

```rust
pub async fn stage_calendar_write(req: StageWriteRequest, pool: State<'_, SqlitePool>, notify: State<'_, Arc<Notify>>) -> Result<(), AppError> {
    if let WriteTarget::RoutineCheck { routine_id, date } = &req.target {
        ensure_routine_check_row(&pool, routine_id, date).await?;
    }
    // ... 기존 ...
}
```

- [ ] **Step 3: time_override도 함께 저장** — Schedule/Reschedule 시 `time_override = HH:MM` UPDATE

`build_queue_row`의 Schedule/Reschedule 매치에서 RoutineCheck target일 때 추가 UPDATE 한 줄:

```rust
if let WriteTarget::RoutineCheck { routine_id, date } = &req.target {
    if let WriteOp::Schedule { at, .. } | WriteOp::Reschedule { at, .. } = &req.op {
        let hhmm = at.get(11..16).unwrap_or("00:00").to_string();
        sqlx::query("UPDATE routine_check SET time_override=? WHERE routine_id=? AND date=?")
            .bind(hhmm).bind(routine_id).bind(date).execute(pool).await?;
    }
}
```

- [ ] **Step 4: Unschedule 시 time_override clear (sync 워커 unlink가 이미 처리)**

`sync.rs::unlink`의 routine_check 분기는 이미 `time_override=NULL` set 함 (PR 2 작성). 확인만.

- [ ] **Step 5: 빌드 + 테스트**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings
```

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/commands/calendar_sync.rs
git commit -m "feat(routine): ensure routine_check row + set time_override on stage (PR 6/7)"
```

---

### Task 2: 루틴 정의 시간 변경 → 다음날부터 적용 (정책 보장)

**Files:**

- Modify: `src-tauri/src/commands/routines.rs` (또는 update_routine 핸들러)

정책: `routines.time_of_day` 변경 시 **기존 routine_check.time_override는 건드리지 않는다** (오늘 인스턴스는 그대로). 다음날부터 새 정의 시간으로 자동.

- [ ] **Step 1: update_routine 핸들러에서 ROLLBACK 안전 확인**

Run: `grep -n "fn update_routine\|update_routine_def" src-tauri/src/`. 핸들러 안에 routine_check를 건드리는 쿼리가 있는지 확인. 있으면 제거 (정책 위반).

- [ ] **Step 2: 동작 검증 테스트**

```rust
// src-tauri/src/commands/routines.rs 하단 또는 별도 tests
#[tokio::test]
async fn update_routine_time_does_not_touch_today_override() {
    // ... pool + 루틴 1개 + 오늘 routine_check.time_override='10:00' 시드
    // update_routine(time_of_day = '08:00') 호출
    // assert: routine_check.time_override == '10:00' 그대로
}
```

- [ ] **Step 3: 테스트 통과 + 커밋**

```bash
cd src-tauri && cargo test --lib update_routine
git add src-tauri/src/commands/routines.rs
git commit -m "feat(routine): definition time change leaves today override intact (PR 6/7)"
```

---

### Task 3: 트레이 → 시간축 드래그 시 시간 슬롯 표시

**Files:**

- Modify: `src/components/today/UnscheduledTray.tsx`
- Modify: `src/components/today/TimelineCanvas.tsx`

루틴은 시간 미정이라 트레이에 있음. 사용자가 드래그를 시작하면 캔버스에 "여기에 떨어뜨리면 09:00" 식의 hover hint 슬롯을 보여줘야 함.

- [ ] **Step 1: TimelineCanvas에 dragOver hint state**

```tsx
const [hoverMin, setHoverMin] = useState<number | null>(null);
const onPointerMove = (e: React.PointerEvent) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - rect.top;
  setHoverMin(Math.round(((y / HOUR_PX) * 60) / 15) * 15);
};
// ... render hint:
{
  hoverMin !== null && (
    <div className="today-canvas-hint" style={{ top: (hoverMin / 60) * HOUR_PX }}>
      {String(Math.floor(hoverMin / 60)).padStart(2, "0")}:{String(hoverMin % 60).padStart(2, "0")}
    </div>
  );
}
```

(또는 @dnd-kit의 `useDndMonitor`로 active drag일 때만 표시.)

- [ ] **Step 2: CSS**

```css
.today-canvas-hint {
  position: absolute;
  left: 60px;
  right: 0;
  height: 2px;
  background: rgba(74, 123, 184, 0.5);
  pointer-events: none;
}
.today-canvas-hint::after {
  content: attr(data-time);
  position: absolute;
  left: 6px;
  top: -16px;
  font-size: 10px;
  color: #4a7bb8;
  font-family: ui-monospace, monospace;
}
```

- [ ] **Step 3: 스모크 + 커밋**

```bash
pnpm tauri dev
# 트레이 → 캔버스 드래그 중 시간 hint 라인이 따라옴
git add src/components/today/
git commit -m "feat(today): hover time hint during drag (PR 6/7)"
```

---

### Task 4: 루틴 블록 시각 구분 + 인스턴스 토글 (완료)

**Files:**

- Modify: `src/components/today/TimelineBlock.tsx`

루틴은 시간축에 있지만 완료 체크는 `routine_check.done` (`useToggleRoutineCheck`). popover 클릭 시 토글 가능해야 함.

- [ ] **Step 1: TimelineBlock에 done 표시**

`box.block`에 `done?: boolean` 추가 (buildTodayBlocks에서 routine은 r.done 전달).

`TimelineBlock`:

```tsx
{
  block.kind === "routine" && block.done && (
    <span className="line-through opacity-60">{block.title}</span>
  );
}
```

- [ ] **Step 2: EventPopover에 routine done 토글**

routine block일 때 popover 안에 "완료/미완료" 버튼 추가. `useToggleRoutineCheck` 호출.

- [ ] **Step 3: 스모크 + 커밋**

```bash
pnpm tauri dev
# 루틴 블록 클릭 → popover에서 완료 토글 → 블록 스타일 변경
git add src/components/today/ src/lib/todayBlocks.ts
git commit -m "feat(today): routine done toggle in popover + visual (PR 6/7)"
```

---

### Task 5: 통합 검증 + push

- [ ] **Step 1: 풀체크**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && pnpm lint && pnpm vitest run
```

- [ ] **Step 2: E2E 시나리오**

```bash
pnpm tauri dev
```

- 정의 시간 07:00 루틴이 시간축 07:00에 자동 표시
- 트레이로 드래그 → time_override clear + Google delete + 트레이에 다시 노출
- 트레이에서 다시 09:00로 드래그 → time_override='09:00' + Google create
- 다음 날짜로 nav → 정의의 07:00에 다시 표시 (override는 오늘만)

- [ ] **Step 3: push**

```bash
git push origin dev
```

## 자체 검증

- ✅ Spec §4.3 time_override 라이프사이클
- ✅ Spec §7 루틴 특수 (정의 → 가상 → linked)
- ✅ Spec §D10 오늘 인스턴스만 변경, 정의는 RoutinesPanel
- ✅ 정의 시간 변경 시 오늘 override 보존 (정책 테스트)
