# Today × Timeline Merge — Design Spec

- **status:** draft (brainstorming-approved 2026-05-28)
- **owner:** master@mirrorless.co.kr
- **scope:** Single-package work-radar (Tauri + React).
- **invariants touched:** #1 (결정 레일은 사람) · #7 (외부 mutation = 사람 손)

## 1. 문제

현재 Today / Timeline / Calendar Drawer 세 표면이 같은 시간축을 세 가지 다른 방식으로 보여준다.

- **Today** (`src/components/TodayView.tsx`) — 시간 없는 항목 중심의 운영 콕핏 (Work Debt 스트립 + 오늘 일정 list + Q1 + Today 레일 + PR attention + 루틴). 시간축 없음.
- **Timeline** (`src/components/TimelineView.tsx`) — 시간 그리드 위에 캘린더 timed 이벤트만 배치 (시간당 1행). 드래그 없음.
- **Calendar Drawer** — 일/주/월 조회 전용 ambient.

Today에 올라온 할 일들이 **언제** 처리될지를 시간축 위에서 잡지 못한다. ATracker처럼 시간 위에 블록으로 배치하고, 겹치면 병렬 컬럼으로 자동 정렬하고, 루틴이 시각을 가지면 미리 시간축에 떠 있고, 드래그로 시간을 옮기면 실제 캘린더(개인/업무)에 저장되는 화면이 필요하다.

## 2. 결정 요약

| #   | 결정                                                                                                               | 비고                                          |
| --- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| D1  | `/timeline` 라우트·메뉴·`TimelineView` 완전 제거                                                                   | Today로 흡수                                  |
| D2  | Today 레이아웃 = 좌측 미배치 트레이 + 우측 시간축 (≥1040px)                                                        | 720–1040 = 상단 띠, <720 = 세로 스택          |
| D3  | 미배치 트레이 = Today 레일(시간없음) + 루틴(시간없음) + 종일이벤트(접힘). **Q1 섹션 없음**, PR attention 완전 제거 | 캡처보드에서 이미 우선순위 분류 끝남          |
| D4  | 시간축 = 00:00–24:00 풀스크롤, 15분 그리드                                                                         | 1시간 60px                                    |
| D5  | 겹침 배치 = ATracker/Google Calendar 자동 균등 컬럼 분할                                                           | 사용자 X 좌표는 컬럼 통제 안 함               |
| D6  | 새 이벤트 기본 길이 = 60분                                                                                         |                                               |
| D7  | 일정 클릭 = **인라인 popover**                                                                                     | 더보기로 기존 모달                            |
| D8  | **카드가 정본, Google은 mirror** (last-write-wins)                                                                 | 카드 `scheduled_at`/`duration`이 truth        |
| D9  | 캘린더 매핑 = `projects.default_write_calendar_id` 신규 필드                                                       | 미설정이면 드롭 시 popover로 선택 + 자동 저장 |
| D10 | 루틴 시간 변경 = **오늘 인스턴스만** (`routine_check.time_override`)                                               | 정의 변경은 RoutinesPanel                     |
| D11 | 외부 sync = **optimistic + 800ms 디바운스 + Stage큐 + 지수 backoff**                                               | 같은 target+kind는 머지                       |
| D12 | Acceptance gate 명시 필요 = **cross-calendar 이동만** (staged + "적용" 버튼)                                       | 그 외는 사람 손 = 암묵 통과                   |
| D13 | Work Debt 4타일 = 헤더 안에 칩으로 흡수                                                                            | 별도 스트립 제거                              |
| D14 | DnD 라이브러리 = `@dnd-kit/core` 도입                                                                              | 보드의 `useListReorder`와 공존                |

## 3. 아키텍처

```
┌────────────── Today View ──────────────┐
│ TodayHeader (날짜 nav + debt 칩 흡수)    │
├──────────────┬─────────────────────────┤
│ Unscheduled  │ TimelineCanvas          │
│ Tray         │  ├── Hour grid (00–24)  │
│  ├ Today     │  ├── Now line           │
│  ├ Routines  │  ├── TimelineBlock[]    │
│  └ ▾ All-day │  └── EventPopover       │
└──────────────┴─────────────────────────┘
        │              │
        ▼              ▼
   useSignals       useCalendarEvents
   useTodayRoutines useToday
        │              │
        └──────┬───────┘
               ▼
        timelineLayout.ts (순수 분할)

drag → calendarSync.ts → invoke stage_calendar_write
                                    │
                                    ▼
                          pending_calendar_writes (SQLite)
                                    │
                                    ▼
                          sync worker (tokio, 800ms debounce)
                                    │
                                    ▼
                          calendar/http CalendarWrite
                                    │
                                    ▼
                          Google Calendar API
```

## 4. 데이터 모델

마이그레이션 4개:

### 4.1 `0029_project_default_write_calendar.sql`

```sql
ALTER TABLE projects ADD COLUMN default_write_calendar_id TEXT;
```

NULL 허용. 미설정이면 첫 드롭 시 popover로 선택 → 선택값 자동 저장. `googleCalendarIds`에 없는 id면 무효 처리 → NULL 취급.

### 4.2 `0030_signal_scheduling.sql`

```sql
ALTER TABLE signals ADD COLUMN scheduled_at        TEXT;
ALTER TABLE signals ADD COLUMN scheduled_duration  INTEGER;
ALTER TABLE signals ADD COLUMN linked_event_id     TEXT;
ALTER TABLE signals ADD COLUMN linked_calendar_id  TEXT;
CREATE INDEX idx_signals_scheduled
  ON signals(scheduled_at) WHERE scheduled_at IS NOT NULL;
```

- `scheduled_at`/`scheduled_duration` 둘 다 NULL = 미배치 (트레이).
- `linked_event_id` = Google mirror event id. 끊긴 link는 NULL.
- 카드의 `quadrant`는 영향 없음 (INVARIANT #1 무관).
- `scheduled_at` set 시 `today_for_date`도 자동 set (트레이↔시간축 일관).

### 4.3 `0031_routine_check_time_override.sql`

```sql
ALTER TABLE routine_check ADD COLUMN time_override     TEXT;  -- 'HH:MM'
ALTER TABLE routine_check ADD COLUMN linked_event_id   TEXT;
ALTER TABLE routine_check ADD COLUMN linked_calendar_id TEXT;
```

오늘 인스턴스만. 내일은 정의의 `time_of_day` 복귀.

### 4.4 `0032_pending_calendar_writes.sql`

```sql
CREATE TABLE pending_calendar_writes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN ('create','patch','delete')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('signal','routine_check')),
  target_id       TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  event_id        TEXT,
  payload_json    TEXT NOT NULL,  -- {title, start, end, staged?: bool, ...}
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(target_kind, target_id, kind)
);
CREATE INDEX idx_pending_due ON pending_calendar_writes(next_attempt_at);
```

## 5. IPC 표면 (tauri-specta)

### 5.1 신규 커맨드 (`src-tauri/src/commands/calendar_sync.rs`)

```rust
#[tauri::command, specta::specta]
async fn stage_calendar_write(req: StageWriteRequest) -> Result<(), AppError>;

#[tauri::command, specta::specta]
async fn commit_staged_writes(ids: Vec<i64>) -> Result<(), AppError>;

#[tauri::command, specta::specta]
async fn cancel_pending_write(id: i64) -> Result<(), AppError>;

#[tauri::command, specta::specta]
async fn list_pending_writes() -> Result<Vec<PendingWrite>, AppError>;
```

```rust
pub struct StageWriteRequest {
    pub target: WriteTarget,           // Signal{id} | RoutineCheck{routine_id, date}
    pub op: WriteOp,
    pub idempotency_key: String,       // 프런트 uuid
}

pub enum WriteOp {
    Schedule { at: String, duration_min: u32, calendar_id: String },
    Reschedule { at: String, duration_min: u32 },
    Resize { duration_min: u32 },
    Unschedule,
    MoveCalendar { calendar_id: String },  // staged 자동
    CreateBlank { title: String, at: String, duration_min: u32, calendar_id: String },
}
```

### 5.2 기존 커맨드 반환 확장

- `list_signals`: `+ scheduled_at, scheduled_duration, linked_event_id, linked_calendar_id`
- `list_today_routines`: `+ time_override, linked_event_id`
- `update_project` 입력: `+ default_write_calendar_id?: string`

### 5.3 신규 이벤트

- `CalendarSyncFailed { pending_id, error }`
- `CalendarSyncFlushed { pending_id }`

bindings drift는 CI 게이트(기존 invariant).

## 6. Sync Engine

### 6.1 Stage → Flush

1. 프런트 IPC `stage_calendar_write` → `pending_calendar_writes`에 UPSERT (UNIQUE 머지: 같은 `target+kind`는 update).
2. `next_attempt_at = now + 800ms`. 같은 row 재update 시 timer 리셋 = 마지막 상태 1회 전송.
3. 워커는 `tokio::time::interval(200ms)` + `notify` 깨우기. `next_attempt_at <= now AND staged != true` 행 flush.
4. 성공 → row 삭제. 실패 → `attempts++`, backoff schedule `[1s, 3s, 9s]`. 3회 후 `last_error` 보존 + emit `CalendarSyncFailed`.

### 6.2 Cross-calendar (staged)

- `MoveCalendar` 또는 cross-cal `CreateBlank`는 `payload_json.staged=true`로 큐 insert.
- 워커가 skip. 프런트는 `list_pending_writes`로 staged 행 가져와 상단 "변경 N건 — 적용" 표시.
- 클릭 → `commit_staged_writes(ids)` → staged 플래그 제거 → 다음 tick에 flush.

### 6.3 Google → 카드 역방향 sync

- `useCalendarEvents` 폴링 결과에 `linked_event_id` 매칭되는 카드가 있으면 `start/end/title` diff 감지.
- diff 있고 큐에 해당 카드 pending write 없음 → 카드를 Google 값으로 silent update (last-write-wins).
- 큐에 pending write 있음 → 우리 쪽이 이김 (사용자 손이 최근).

### 6.4 Optimistic UI

- 드래그 끝 시점에 React Query 캐시 (`signals`, `calendarEvents`)에 낙관적 패치 + IPC 발사.
- 성공 무음.
- `CalendarSyncFailed` 수신 → 토스트 "동기화 실패 — 재시도 / 되돌리기". 되돌리기 = 캐시 롤백 + `cancel_pending_write`.

### 6.5 INVARIANT #7 해석

- 시간 nudge/리사이즈/within-cal 이동 = 사람 손 직접 = 암묵 acceptance.
- Cross-calendar 이동 = "결정" = 명시 "적용" 버튼이 게이트.

## 7. 드래그 인터랙션 명세

| #   | from → to               | 동작                         | sync                       | 게이트                     |
| --- | ----------------------- | ---------------------------- | -------------------------- | -------------------------- |
| 1   | 트레이 → 시간축 빈영역  | Schedule + Google create     | optimistic                 | popover (캘린더 미설정 시) |
| 2   | 블록 → 같은 시간축 이동 | Reschedule + patch           | optimistic 디바운스        | —                          |
| 3   | 블록 끝 리사이즈        | Resize + patch               | optimistic 디바운스        | —                          |
| 4   | 블록 → 트레이           | Unschedule + delete          | optimistic 디바운스        | 토스트 되돌리기 1.5s       |
| 5   | 블록 → 다른 캘린더      | MoveCalendar (delete+create) | **staged**                 | 명시 "적용"                |
| 6   | 블록 클릭               | EventPopover                 | popover 저장 버튼이 게이트 | —                          |
| 7   | 시간축 빈영역 클릭      | EventPopover (신규)          | popover 저장 버튼이 게이트 | —                          |

**루틴 특수:**

- `time_of_day` 있는 루틴 = 시간축에 미리 자동 배치 (Google 이벤트 없이 가상). 드래그하면 `time_override` set + Google create.
- 트레이로 빼면 `time_override` clear + linked event delete.

## 8. 프런트 구조

### 8.1 신규

- `src/components/today/TodayHeader.tsx` — 날짜 nav + debt 칩 4개 흡수
- `src/components/today/UnscheduledTray.tsx`
- `src/components/today/TimelineCanvas.tsx`
- `src/components/today/TimelineBlock.tsx`
- `src/components/today/EventPopover.tsx` (shadcn Popover)
- `src/lib/timelineLayout.ts` + `.test.ts` — 병렬 분할 순수함수
- `src/lib/calendarSync.ts` — IPC 래퍼 + optimistic 헬퍼
- `src/lib/query/calendarSync.ts` — `usePendingWrites`

### 8.2 교체

- `src/components/TodayView.tsx` → 새 셸 (TodayHeader + UnscheduledTray + TimelineCanvas)
- `TodayView.css` 전체 재작성

### 8.3 삭제

- `src/components/TimelineView.tsx`, `TimelineView.css`
- `src/lib/nav.ts`의 `timeline` 라우트
- `App.tsx`의 timeline case + 사이드바 메뉴 아이템

### 8.4 의존성

- `@dnd-kit/core` + `@dnd-kit/utilities` 추가.

### 8.5 ATracker 병렬 분할 알고리즘 (`timelineLayout.ts`)

```
입력: TimedBlock[] = signals(scheduled_at) ∪ google events ∪ routine instances
1. 시작시간 정렬
2. sweep: 현재 활성 집합 추적 (current.end > nextStart인 것)
3. cluster = 직접/간접으로 겹치는 모든 블록의 connected component
4. cluster 내 그리디 컬럼 배정 (가능한 가장 왼쪽)
5. clusterCols = cluster의 max(col)+1
6. 출력: {id, top, height, leftPct, widthPct}
출력 left = (col / clusterCols) * 100%, width = (1 / clusterCols) * 100%
```

## 9. 검증

| Layer          | 테스트                                                           |
| -------------- | ---------------------------------------------------------------- |
| Rust           | UNIQUE 머지: 같은 target+kind 후속 update가 행 추가 안 함        |
| Rust           | backoff schedule = [1s, 3s, 9s] 정확                             |
| Rust           | staged=true 행은 워커가 skip                                     |
| Rust           | retry 3회 후 `last_error` 보존 + 이벤트 emit                     |
| Rust           | Google→카드 역방향 sync: 큐 pending 있으면 우리 값 유지          |
| Front (vitest) | timelineLayout: 단일/순차/완전겹침/부분겹침/3중겹침/all-day 제외 |
| Front (vitest) | 미배치 트레이 그룹화                                             |
| Front (vitest) | optimistic 패치 + 실패 시 롤백                                   |
| Integration    | tauri dev 부팅, 드래그→Google PATCH 800ms 후 발사 (수동)         |
| Integration    | 오프라인 → 큐 보존 → 재시작 후 flush (수동)                      |

## 10. 의도적 deferred

- 멀티 일자 이벤트 (00:00 넘는) — v1은 same-day만, cross-day는 트레이 칩 + 모달.
- Google recurring 이벤트 편집 — v1은 single instance만, "Google에서 열기".
- 시간축 week view — Calendar Drawer가 담당.
- 드래그 중 자동 스크롤 — v2.
- 키보드 only 블록 이동 — v2.
- 명시적 충돌 토스트 (silent last-write-wins 대신) — 신호 보고 결정.

## 11. PR 분할

1. **PR 1** — 마이그 0029~0032 + 모델 필드 + `update_project` 확장 + `list_*` 반환 확장 (UI 무변경, bindings drift만).
2. **PR 2** — `pending_calendar_writes` 워커 + IPC 4종 (UI 호출 없음, Rust 테스트만).
3. **PR 3** — TimelineView 제거 + 새 TodayView 셸 (트레이 + 빈 시간축, read-only).
4. **PR 4** — `timelineLayout.ts` + 블록 렌더 + 인라인 popover (편집은 기존 모달 경유).
5. **PR 5** — `@dnd-kit` + 드래그 7가지 + optimistic UI + staged 적용 UI.
6. **PR 6** — 루틴 `time_override` + linked event 라이프사이클.
7. **PR 7** — Work Debt 헤더 흡수, 잔재 정리, 모션/접근성 패스.

## 12. ADR

- `00XX-card-as-truth-google-as-mirror.md` — §D8.
- `00YY-pending-writes-queue.md` — §6 sync 워커.
- `00ZZ-dnd-kit-adoption.md` — `useListReorder`와 공존.

## 13. Area Map 영향

- `docs/areas/today-timeline.md` 신규 — 트레이+시간축 규율, 분할 알고리즘 invariants, sync 워커 호출 패턴.
- `docs/areas/area-map.md`에 라우팅 행 추가:
  - `src/components/today/**` → `docs/areas/today-timeline.md`
  - `src-tauri/src/commands/calendar_sync.rs` → `today-timeline.md` + `ipc-conventions.md`

## 14. INVARIANT 체크

- **#1 (결정 레일은 사람):** 시간축 배치는 결정 아님, 실행 plan. `quadrant`/`area` 자동 확정 0건. ✓
- **#7 (외부 mutation):** within-cal = 사람 손 암묵, cross-cal = 명시 "적용". ✓
- **bounded retry:** [1s, 3s, 9s] 3회 + terminal failure 표면화. ✓
- **외부 호출은 Rust:** 모든 Google PATCH/POST는 sync 워커. ✓
- **마이그레이션으로만:** 0029~0032. ✓
- **카드 정본 모델 변경은 ADR.** ✓
