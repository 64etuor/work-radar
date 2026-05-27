# Today×Timeline PR 1 — Schema & Model Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 마이그레이션 0029~0032 + 모델 필드 확장 + IPC 반환/입력 확장. UI 변경 0건. `src/bindings.ts` drift만 발생.

**Architecture:** sqlx migrations (additive ALTER + 신규 테이블) → Rust 모델 구조체 필드 추가 → 기존 list_* 쿼리에 SELECT 절 확장 → `update_project` 입력 옵셔널 필드 추가 → tauri-specta export → `pnpm tauri-bindings` 재생성.

**Tech Stack:** Rust 2021, sqlx 0.8, tauri-specta, specta, vitest (typecheck only).

**Spec:** `docs/superpowers/specs/2026-05-28-today-timeline-merge-design.md` §4, §5.

---

### Task 1: Migration 0029 — projects.default_write_calendar_id

**Files:**
- Create: `src-tauri/migrations/0029_project_default_write_calendar.sql`

- [ ] **Step 1: 마이그레이션 작성**

```sql
-- Phase: Today×Timeline merge PR 1.
-- 프로젝트별 "일정 생성 기본 캘린더" id. drop 시 카드의 project를 통해 조회된다.
-- NULL = 미설정 → 프런트가 드롭 시 popover로 선택을 요구하고 첫 선택을 저장.
-- googleCalendarIds(JSON array)에 없는 id면 무효 → 프런트에서 NULL 취급.

ALTER TABLE projects ADD COLUMN default_write_calendar_id TEXT;
```

- [ ] **Step 2: 컴파일/마이그레이션 적용 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: 빌드 성공. `rtk proxy cargo build`로 한 번 더 검증 (rtk truncation 회피, memory 참조).

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/migrations/0029_project_default_write_calendar.sql
git commit -m "feat(db): add projects.default_write_calendar_id (PR 1/7)"
```

---

### Task 2: Migration 0030 — signals scheduling 필드

**Files:**
- Create: `src-tauri/migrations/0030_signal_scheduling.sql`

- [ ] **Step 1: 마이그레이션 작성**

```sql
-- Phase: Today×Timeline merge PR 1.
-- 카드를 시간축에 배치하기 위한 필드. spec §D8: 카드가 정본, Google은 mirror.
-- - scheduled_at: RFC3339 UTC. NULL=미배치 (트레이에 남음).
-- - scheduled_duration: 분.
-- - linked_event_id / linked_calendar_id: Google mirror 핸들. delete 후 NULL.

ALTER TABLE signals ADD COLUMN scheduled_at        TEXT;
ALTER TABLE signals ADD COLUMN scheduled_duration  INTEGER;
ALTER TABLE signals ADD COLUMN linked_event_id     TEXT;
ALTER TABLE signals ADD COLUMN linked_calendar_id  TEXT;

CREATE INDEX idx_signals_scheduled
  ON signals(scheduled_at) WHERE scheduled_at IS NOT NULL;
```

- [ ] **Step 2: 빌드 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: 성공.

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/migrations/0030_signal_scheduling.sql
git commit -m "feat(db): add signal scheduling fields (PR 1/7)"
```

---

### Task 3: Migration 0031 — routine_check time_override

**Files:**
- Create: `src-tauri/migrations/0031_routine_check_time_override.sql`

- [ ] **Step 1: 마이그레이션 작성**

```sql
-- Phase: Today×Timeline merge PR 1.
-- spec §D10: 루틴 시간 변경은 "오늘 인스턴스만". 내일은 정의의 time_of_day로 복귀.
-- routine_check은 (routine_id, date) 단위 행이라 여기에 override + linked event 저장.

ALTER TABLE routine_check ADD COLUMN time_override      TEXT;
ALTER TABLE routine_check ADD COLUMN linked_event_id    TEXT;
ALTER TABLE routine_check ADD COLUMN linked_calendar_id TEXT;
```

- [ ] **Step 2: 빌드 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: 성공.

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/migrations/0031_routine_check_time_override.sql
git commit -m "feat(db): add routine_check time_override (PR 1/7)"
```

---

### Task 4: Migration 0032 — pending_calendar_writes 테이블

**Files:**
- Create: `src-tauri/migrations/0032_pending_calendar_writes.sql`

- [ ] **Step 1: 마이그레이션 작성**

```sql
-- Phase: Today×Timeline merge PR 1 (PR 2에서 sync 워커가 사용).
-- spec §6: 같은 target+kind 후속 update는 머지 (UNIQUE로 보장).
-- staged=true payload는 워커가 skip → cross-cal 변경의 명시 Acceptance 게이트.

CREATE TABLE pending_calendar_writes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('create','patch','delete')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('signal','routine_check')),
  target_id       TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  event_id        TEXT,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(target_kind, target_id, kind)
);

CREATE INDEX idx_pending_due ON pending_calendar_writes(next_attempt_at);
```

- [ ] **Step 2: 빌드 확인**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build`
Expected: 성공.

- [ ] **Step 3: 커밋**

```bash
git add src-tauri/migrations/0032_pending_calendar_writes.sql
git commit -m "feat(db): add pending_calendar_writes queue (PR 1/7)"
```

---

### Task 5: Project 모델 필드 추가

**Files:**
- Modify: `src-tauri/src/models/project.rs`

- [ ] **Step 1: 현재 Project struct 위치 확인**

Run: `grep -n "pub struct Project" src-tauri/src/models/project.rs`
Expected: 한 줄 출력. 그 아래 필드 목록 확인.

- [ ] **Step 2: `default_write_calendar_id` 필드 추가**

`Project` 구조체 + `UpdateProjectInput` 구조체 둘 다에 추가 (Option<String>). 예:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, Type)]
pub struct Project {
    // ... 기존 필드 ...
    pub default_write_calendar_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct UpdateProjectInput {
    // ... 기존 필드 ...
    pub default_write_calendar_id: Option<Option<String>>, // None=무변경, Some(None)=clear, Some(Some(id))=set
}
```

- [ ] **Step 3: 모든 SELECT 쿼리에 새 컬럼 추가**

Run: `grep -rn "SELECT.*FROM projects" src-tauri/src/` 로 위치 찾기. 각 쿼리에 `default_write_calendar_id` 추가.

- [ ] **Step 4: `update_project` 핸들러에 처리 분기 추가**

Run: `grep -n "fn update_project\|update_project_handler" src-tauri/src/`로 위치 찾기. `Option<Option<String>>` 패턴매치로 UPDATE 절 조립.

- [ ] **Step 5: 빌드 + 테스트**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib && cargo clippy --all-targets -- -D warnings
```
Expected: 모두 통과.

- [ ] **Step 6: 커밋**

```bash
git add src-tauri/src/models/project.rs src-tauri/src/commands/
git commit -m "feat(model): Project.default_write_calendar_id + update plumbing (PR 1/7)"
```

---

### Task 6: WorkSignal 모델에 scheduling 필드

**Files:**
- Modify: `src-tauri/src/models/signals.rs`

- [ ] **Step 1: WorkSignal struct에 필드 추가**

```rust
pub struct WorkSignal {
    // ... 기존 필드 ...
    pub scheduled_at: Option<String>,
    pub scheduled_duration: Option<i32>,
    pub linked_event_id: Option<String>,
    pub linked_calendar_id: Option<String>,
}
```

- [ ] **Step 2: list_signals / get_signal SELECT 절 확장**

Run: `grep -rn "FROM signals" src-tauri/src/`로 모든 쿼리 위치 찾기. 각 SELECT에 4개 컬럼 추가.

- [ ] **Step 3: 빌드 + 테스트**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib
```
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/models/signals.rs src-tauri/src/
git commit -m "feat(model): WorkSignal scheduling fields (PR 1/7)"
```

---

### Task 7: RoutineCheck 모델에 override 필드

**Files:**
- Modify: `src-tauri/src/models/routines.rs`

- [ ] **Step 1: RoutineCheck (또는 TodayRoutineItem) struct에 추가**

```rust
pub struct TodayRoutineItem {
    // ... 기존 ...
    pub time_override: Option<String>,        // 'HH:MM'
    pub linked_event_id: Option<String>,
    pub linked_calendar_id: Option<String>,
}
```

- [ ] **Step 2: list_today_routines SELECT 절 확장**

Run: `grep -rn "FROM routine_check\|routines_today" src-tauri/src/`. SELECT에 3개 컬럼 LEFT JOIN/SELECT 추가.

- [ ] **Step 3: 빌드 + 테스트**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test --lib
```
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/models/routines.rs src-tauri/src/
git commit -m "feat(model): RoutineCheck time_override (PR 1/7)"
```

---

### Task 8: tauri-specta bindings 재생성

**Files:**
- Modify: `src/bindings.ts` (자동 생성)

- [ ] **Step 1: bindings 재생성 명령 확인**

Run: `grep -n "bindings\|specta" package.json src-tauri/Cargo.toml`
Expected: `tauri-bindings` 또는 유사 스크립트 발견. 보통 `pnpm tauri:bindings` 또는 빌드 시 자동.

- [ ] **Step 2: 재생성**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo run --bin generate_bindings 2>/dev/null || cargo test --lib export_bindings
```
(프로젝트 패턴에 맞게 조정. 보통 `cargo test`가 export 트리거.)

- [ ] **Step 3: drift 확인**

Run: `git diff src/bindings.ts | head -40`
Expected: `default_write_calendar_id`, `scheduled_at`, `scheduled_duration`, `linked_event_id`, `linked_calendar_id`, `time_override` 등이 추가된 diff.

- [ ] **Step 4: 타입체크 + 린트**

```bash
pnpm typecheck && pnpm lint
```
Expected: 통과. (`bindings.ts` 변경으로 인한 컴파일 에러 없음 — 신규 필드가 옵셔널이므로.)

- [ ] **Step 5: 커밋**

```bash
git add src/bindings.ts
git commit -m "chore(bindings): regenerate for scheduling fields (PR 1/7)"
```

---

### Task 9: 통합 검증 + dev push

- [ ] **Step 1: 전체 검증**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && pnpm lint && pnpm vitest run
```
Expected: 모두 통과.

- [ ] **Step 2: tauri dev 부팅 스모크**

Run: `pnpm tauri dev` (백그라운드). 앱 열림 확인 후 종료.
Expected: 부팅 실패 없음. 마이그레이션 자동 적용.

- [ ] **Step 3: dev 푸시**

```bash
git push origin dev
```
Expected: husky pre-push 통과 (dev 브랜치 OK, memory 참조). CI green.

---

## 자체 검증

- ✅ Spec §4.1~§4.4 모든 마이그레이션 추가됨
- ✅ Spec §5.2 모든 list_* 반환 확장
- ✅ Spec §5.2 update_project 입력 확장
- ✅ UI 변경 0건 (PR 1 스코프)
- ✅ INVARIANT: 마이그레이션으로만 (임의 ALTER 없음), bounded retry는 PR 2

## 다음 PR

PR 2 — pending_calendar_writes 워커 + 4 IPC 커맨드. 본 PR 머지 후 plan
`2026-05-28-today-timeline-pr-2-sync-worker.md` 참조.
