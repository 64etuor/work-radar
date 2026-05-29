# Routine → Google Calendar 동기화 (opt-in)

**Branch**: `feature/routine-google-sync`
**시작일**: 2026-05-29
**전제 컨텍스트**: dev 15c08cc

## 1. 배경 & 결정

루틴은 본질적으로 "습관"이지 "약속"이 아니다. 모든 timed 루틴을 Google에 자동 등록하면 캘린더가 매일 "비타민" "스트레칭"으로 도배되고, work calendar면 사적 습관이 노출된다. 반대로 일부 루틴(헬스장, PT, 약 복용)은 실제 캘린더 슬롯이라 가족/팀과 안 겹치게 Google에 올라가야 한다.

→ **루틴별 opt-in 동기화**. 기본 local-only, 사용자가 켠 루틴만 Google master recurring event로 등록.

### 잠금된 결정 (사용자 확정)

| #   | 결정                                | 의미                                                                                                                 |
| --- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | **BYDAY 풍부 모델**                 | `monthly_pattern` 추가 — `day_of_month` 외 `nth_weekday`("2nd Tuesday", "last Friday") 지원                          |
| 2   | **EXDATE 지원**                     | sync된 루틴의 "오늘 빼기" = master event에 EXDATE PATCH. skip 이력 보존.                                             |
| 3   | **`duration_min` 컬럼 추가**        | NULL → 기존 30분 default fallback. 헬스장 60분 / 스트레칭 15분 등 다양성 대응.                                       |
| 4   | **PATCH 전략 (DELETE+CREATE 아님)** | 루틴 편집 시 master event PATCH — EXDATE/이벤트 ID/사용자가 Google에 추가한 메타(위치·참석자·알림) 보존. quota 절약. |

### INVARIANTS 준수

- INVARIANT #1 (자동 분류 0): sync 결정은 100% 사용자 토글. 자동 동기화 X.
- INVARIANT #2 (외부 변경 = Acceptance 게이트): Google PATCH/DELETE는 명시적 사용자 액션에서만.
- INVARIANT #5 (bounded retry): Google 호출은 backoff + jitter + terminal failure 토스트.
- INVARIANT #7 (SQLite SSOT): `google_calendar_id`/`google_event_id`/`routine_exdates` 모두 로컬 마이그레이션으로만.

---

## 2. Schema 델타 (PR 1)

> ⚠️ **마이그레이션 번호**: dev에 `0036_agent_runs_acked_at.sql`가 이미 머지됨(4852d37).
> → 이 변경은 **`0037_routines_google_sync.sql`**.

```sql
-- 0037_routines_google_sync.sql

-- 1) routines에 sync 필드 + 풍부 monthly 패턴 + duration 추가
--    sync-pair invariant는 SQLite row-level CHECK으로 enforce (drift 차단).
ALTER TABLE routines ADD COLUMN google_calendar_id TEXT;       -- NULL = local-only
ALTER TABLE routines ADD COLUMN google_event_id TEXT;          -- master recurring event id
ALTER TABLE routines ADD COLUMN duration_min INTEGER;          -- NULL → fallback 30
ALTER TABLE routines ADD COLUMN monthly_pattern TEXT
  CHECK (monthly_pattern IS NULL OR monthly_pattern IN ('day_of_month','nth_weekday'));
ALTER TABLE routines ADD COLUMN monthly_nth_week INTEGER
  CHECK (monthly_nth_week IS NULL OR (monthly_nth_week BETWEEN -1 AND 5 AND monthly_nth_week != 0));
-- nth_week: 1=첫째, 2=둘째, 3=셋째, 4=넷째, 5=다섯째(존재 시), -1=마지막

-- NOTE: ALTER TABLE ADD COLUMN ... CHECK 제약은 0011처럼 rebuild 패턴이 필요할 수 있음.
-- sync-pair invariant는 0011 패턴을 따라 routines_new 재작성으로 추가:
--   CHECK (
--     (google_event_id IS NULL AND google_calendar_id IS NULL)
--     OR (google_event_id IS NOT NULL AND google_calendar_id IS NOT NULL)
--   )
-- PR 1 시작 시 ALTER vs rebuild 비용 비교 — 신규 컬럼만 추가하므로 ALTER로 충분하면
-- application-level 가드로 합의(0011 rebuild 비용 회피). 결정은 ADR에 한 줄.

-- 2) EXDATE 저장(local SSOT) — Google EXDATE와 양방향 일치
CREATE TABLE routine_exdates (
  routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,                       -- 'YYYY-MM-DD' (로컬)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (routine_id, date)
);
CREATE INDEX idx_routine_exdates_routine ON routine_exdates(routine_id);
```

**선후 가드**:

- `monthly_pattern='nth_weekday'` 일 때 application-level 검증: `monthly_nth_week IS NOT NULL` + `weekdays`가 정확히 1개 요소.
- `google_event_id IS NOT NULL` ↔ `google_calendar_id IS NOT NULL` — rebuild 채택 시 CHECK, 아니면 application + 테스트.
- biweekly: `anchor_date`는 `weekdays` 중 하나의 요일이어야 하고 그 자체가 ON week이어야 함 (PR 1 RRule 매핑에서 normalize, 단위 테스트 포함).

**모듈 경로 (신규)**:

- `src-tauri/src/routines/` 신규 모듈 디렉터리 생성 — `mod.rs` + `rrule.rs` (PR 1) + `google.rs` (PR 2~).
- 모델은 기존 `src-tauri/src/models/routines.rs` 유지(신규 컬럼 필드 추가).
- IPC는 기존 `src-tauri/src/commands/routines/` 유지(신규 명령 파일 추가).

---

## 3. RRULE 매핑 정본 (Rust 순수 함수)

```rust
// src-tauri/src/routines/rrule.rs (신규)

pub struct RRuleSpec {
    pub dtstart_local: String,    // 'YYYYMMDDTHHMMSS' wall-clock
    pub tzid: String,             // 'Asia/Seoul' 등
    pub rrule: String,            // 'FREQ=...'
    pub duration_min: u32,        // DTEND 계산용
    pub exdates: Vec<String>,     // 각 'YYYYMMDDTHHMMSS'
}

pub fn routine_to_rrule(r: &Routine, exdates: &[String]) -> Result<RRuleSpec, RRuleError>;

// EXDATE 변환 헬퍼: routine_exdates.date('YYYY-MM-DD') + routine.time_of_day('HH:MM')
// → EXDATE local format 'YYYYMMDDTHHMMSS'. NULL time → 09:00 fallback (DTSTART와 일치).
pub fn exdate_local(date_ymd: &str, time_hm: Option<&str>) -> Result<String, RRuleError>;
```

### 매핑 표

| 입력                                                                                  | 출력 RRULE                        | DTSTART                             |
| ------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| `freq=daily`, `time=09:00`                                                            | `FREQ=DAILY`                      | `anchor_date or created_at` + 09:00 |
| `freq=weekly`, `weekdays=[mon,wed,fri]`                                               | `FREQ=WEEKLY;BYDAY=MO,WE,FR`      | 첫 매칭 요일                        |
| `freq=biweekly`, `weekdays=[mon]`, `anchor_date=2026-05-25`                           | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` | anchor_date (anchor가 ON 주)        |
| `freq=monthly`, `monthly_pattern=day_of_month`, `anchor_date=2026-05-15`              | `FREQ=MONTHLY;BYMONTHDAY=15`      | anchor_date                         |
| `freq=monthly`, `monthly_pattern=nth_weekday`, `monthly_nth_week=2`, `weekdays=[tue]` | `FREQ=MONTHLY;BYDAY=2TU`          | anchor_date                         |
| `freq=monthly`, `monthly_nth_week=-1`, `weekdays=[fri]`                               | `FREQ=MONTHLY;BYDAY=-1FR`         | anchor_date                         |

### 요일 코드 매핑

`["sun","mon","tue","wed","thu","fri","sat"]` → `["SU","MO","TU","WE","TH","FR","SA"]` (상수 함수)

### 단위 테스트 매트릭스 (~15개)

- daily 기본 / 자정 경계 (`time_of_day=00:00`, `23:59`) — KST(no DST) 정합 회귀.
- weekly 단일 요일 / 복수 요일 / 모든 요일(=daily 의미)
- biweekly anchor 주 (ON week, weekdays 중 하나) / off-week (validation error) / anchor 변경
- monthly day_of_month: 1일 / 15일 / 31일(2월 처리는 Google이 알아서 — RRULE은 그대로 전달)
- monthly nth_weekday: 2nd Tue / 1st Mon / -1st Fri
- monthly nth_weekday 5번째 존재 안 함 (RRULE 그대로 전달, Google이 skip)
- EXDATE 1건 + 다중 + 정렬 보장 + `exdate_local` 헬퍼 (`time_of_day` NULL→09:00 fallback)

---

## 4. Google API 호출 정본 (Rust)

### CREATE master event (sync ON)

```
POST /calendar/v3/calendars/{calId}/events
{
  "summary": routine.title,
  "start": {"dateTime": "...", "timeZone": "Asia/Seoul"},
  "end":   {"dateTime": "...", "timeZone": "Asia/Seoul"},
  "recurrence": ["RRULE:FREQ=..."],
}
→ event.id 를 routine.google_event_id 에 저장
```

### PATCH (편집 / EXDATE 추가)

```
PATCH /calendar/v3/calendars/{calId}/events/{eventId}
- 시간/요일/주기 편집 → recurrence + start + end 동시 send
- skip 추가 → recurrence: ["RRULE:...", "EXDATE;TZID=Asia/Seoul:YYYYMMDDTHHMMSS,..."]
```

### DELETE (sync OFF / 루틴 삭제)

```
DELETE /calendar/v3/calendars/{calId}/events/{eventId}
→ routine.google_calendar_id = NULL, google_event_id = NULL
```

### Bounded retry 정책 (INVARIANT #5)

- 5xx / 429: exponential backoff (1s, 2s, 4s) + jitter, **최대 3회**.
- 4xx (404=already deleted 등): no retry, graceful — 로컬 상태만 정리.
- timeout 30s — 그 외엔 toast로 terminal failure surface (메시지 + traceId).

---

## 5. PR 분할 (5개)

### PR 1 — Schema + RRULE 매핑 (백엔드 only, IPC 미노출)

- `migrations/0036_routines_google_sync.sql`
- `src-tauri/src/routines/rrule.rs` — `routine_to_rrule` 순수 함수
- 단위 테스트 ~14개 (위 매트릭스)
- 모델 업데이트: `Routine` struct에 신규 필드 + specta export 확인
- 마이그레이션 보존 테스트: 기존 routine row가 NULL 신규 필드로 진입하는지

**검증**: `cargo test --lib routines::rrule` + `pnpm typecheck`(bindings drift 0).

### PR 2 — Google 동기화 enable/disable IPC + 설정 UI

> ⚠️ **결정 (2026-05-29, 사용자 확정): 루틴은 자신의 kind와 같은 kind의 프로젝트에 매핑.**
> 루틴에도 개인/업무 구분이 있다(`RoutineToday.kind` = personal|work). 개인 루틴 → 개인
> 프로젝트, 업무 루틴 → 업무 프로젝트. Google OAuth는 이 앱에서 **프로젝트별 연결**
> (`start_google_oauth(projectId)` 등)이고 루틴은 `project_id`가 NULL인 채 생성돼 왔으므로
> 토큰 경로가 없었다. → sync 토글 시 UI가 **routine.kind와 같은 kind의 프로젝트 + 그 캘린더**를
> 넘기고, 백엔드가 `project.kind == routine.kind`를 검증한다(개인↔업무 캘린더 교차 노출을
> 양방향 차단 — §1 프라이버시 우려를 구조로 강제). `routine.kind`가 None이면 매핑 결정 불가 →
> 거부. enable 시 `routine.project_id`를 그 프로젝트로 set → 이후 disable/patch가 그대로 동작.

#### PR 2a — 백엔드 IPC + RRuleSpec→event parts (완료, ffb19be)

- IPC: `enable_routine_google_sync` / `disable_routine_google_sync` + provider injection 헬퍼.
- `RRuleSpec::to_event_parts()` + `CreateEventInput` recurrence/time_zone 확장.
- ⚠️ enable 시그니처는 PR 2a에서 `(routine_id, calendar_id)`였고, **PR 2b-1에서
  `(routine_id, project_id, calendar_id)` + kind=personal 검증으로 수정**(아래).

#### PR 2b-1 — 신규 필드 노출 + crud 배선 + enable 시그니처 수정 (백엔드)

- `RoutineToday`에 `googleCalendarId`/`googleEventId`/`monthlyPattern`/`monthlyNthWeek`/`durationMin` 노출
  (`models/routines.rs` + `commands/routines/listing.rs` SELECT).
- `CreateRoutineInput`/`UpdateRoutineInput` + `crud` INSERT/UPDATE에 monthly_pattern/monthly_nth_week/duration_min 배선.
- `enable_routine_google_sync(routine_id, project_id, calendar_id)` — `project.kind == routine.kind`
  검증(`routine.sync.kind_mismatch`), `routine.kind` None이면 `routine.sync.kind_required`,
  통과 시 `routine.project_id` set.
- 테스트: kind mismatch 거부 / kind None 거부 / kind 일치 통과 + project_id 저장 / 신규 필드 라운드트립.

**검증**: `cargo test --lib` + `pnpm typecheck`(bindings drift 의도분만).

#### PR 2b-2 — sync 토글 + 캘린더 picker (프런트, 헤드라인)

- `RoutineSyncButton`(신규) — RoutinesPanel 행 액션에 Google 동기화 토글. shadcn Popover로
  picker(overlay-stack Esc 계약 자동). 후보 = routine.kind와 같은 kind 프로젝트의 선택 캘린더
  (`project.googleCalendarIds` 로컬 JSON — 네트워크 없음, CalendarPickerPopover 패턴 미러).
- 훅 `useEnableRoutineGoogleSync`/`useDisableRoutineGoogleSync` + CaptureBoard 핸들러(토스트).
- 백엔드: monthly인데 패턴 미지정이면 enable에서 `day_of_month` 기본 → 로컬 due-calc와 일치
  (nth_weekday 없이도 monthly 루틴 sync 가능).
- kind None / 후보 없음 / 이미 sync 각각 명확한 상태 표시.

**검증**: `cargo test --lib`(google_sync 7) + `pnpm typecheck` + `pnpm lint`.

#### PR 2b-3 — monthly nth_weekday 편집 UI (프런트, deferred)

- RoutinesPanel 폼: monthly일 때 radio(day_of_month vs nth_weekday) + nth_week 셀렉트
  (1st~5th, last) + duration(분) 입력. RoutineDraft 확장 + CaptureBoard 실제 값 전달.
- **진입 조건(critic)**: `monthly_nth_week` IPC-boundary 검증(create/update) — 현재 DB CHECK 의존.
- (선택) 로컬 due-calc의 nth_weekday 지원 — 현재 day_of_month만 → 별도 follow-up일 수도.

**검증**: `cargo test --lib`(create/update nth_week 검증) + `pnpm typecheck` + `pnpm lint`.

### PR 3 — 루틴 편집 시 PATCH 전파

- 루틴 freq/weekdays/anchor/time/duration 변경 시 sync 켜진 거면 PATCH 트리거
- recurrence + start + end 동시 send
- 실패 시 graceful: 로컬 변경은 유지, sync 실패는 toast로 surface ("Google 동기화 실패 — 설정에서 재시도")

**검증**: PATCH 호출 케이스 단위 (단순 시각 변경 / 요일 변경 / freq 변경 daily→weekly).

### PR 4 — 오늘 unschedule = EXDATE PATCH (EventPopover 통합)

- EventPopover 루틴 블록 라벨: "삭제" → "**오늘 타임라인에서 빼기**" (명확한 의도)
- 호출 흐름:
  1. `routine_exdates` 테이블에 `(routine_id, today)` INSERT OR IGNORE
  2. sync ON 루틴이면 master event PATCH로 EXDATE 추가
  3. 기존 `routineUnschedule` stage(시간 배치 제거)
- 되돌리기: sync 켜진 루틴이면 EXDATE 제거 PATCH + local row 삭제 (toast undo 5초)

**검증**: routine without sync(local) / with sync 양쪽 unschedule 후 Google 호출 여부 확인.

### PR 5 — invariant 가드 + 이동/삭제 경로

> ⚠️ **백필 없음**: `routine_checks.linked_event_id`는 **per-instance 이벤트 ID**(그날 batch write 단일)
> 라서 master recurring event id로 백필할 수 없다. 첫 sync ON 시 신규 master event CREATE만 한다.
> per-instance routine_checks 흐름은 건드리지 않는다.

- Settings UI: sync ON 루틴의 calendar_id 변경 시 (다른 캘린더로 이동) 명시 confirm
  → Google API 제약상 PATCH로 calendarId 못 바꿈 → DELETE 옛 master + CREATE 새 master.
- Routine 삭제 시: sync ON이면 Google master event 먼저 DELETE → 실패 시 confirm "Google 삭제 실패. 로컬만 지울까요?"
- Invariant 가드 회귀 테스트: `google_event_id ↔ google_calendar_id` pair, monthly_pattern 가드.

**검증**: 캘린더 이동(DELETE+CREATE 라운드트립) / DELETE 실패 경로 토스트 / pair invariant 위반 차단.

---

## 6. AI/오버엔지니어링 가드

- **"This and following" 시맨틱은 안 다룬다** — PR 3에서 모든 편집은 master 통째 PATCH. 사용자가 "오늘 이후만 변경" 같은 걸 원하면 별도 follow-up.
- **다중 캘린더 이동** — sync 켜진 루틴의 calendar 변경은 DELETE 옛 master + CREATE 새 master (PATCH로 calendarId 못 바꿈 — Google API 제약). PR 5에서 처리.
- **TZ 변경 대응** — 사용자 TZ 변경(예: 출장)은 다음 sync 시점에 새 TZID로 PATCH. 기존 instance는 Google이 wall-clock 유지(의도와 일치).
- **Yearly freq 지원 안 함** — 현재 schema에도 없음. 필요 시 schema 확장 후 별도 PR.

---

## 7. 결정 갱신 로그 위치

- 구조적 결정 (PATCH vs DELETE+CREATE, opt-in 토글, EXDATE local-SSOT) →
  **`docs/adr/0005-routine-google-sync.md`** — PR 1 **첫 커밋**(또는 그 직전 별도 커밋)으로 freeze.
  schema/IPC 모양이 ADR에 의존하므로 PR 1 코드보다 먼저 정착시킨다.
- 작은 Phase 트레이드오프 (ALTER vs rebuild for CHECK 등) → `docs/decisions.md`에 한 줄씩

---

## 8. 세션 핸드오프 (현재 상태 — 2026-05-29 갱신)

> 이 §8은 **현재 진행 상태 정본**이다. 새 세션은 여기부터 읽고 재진입한다.

### 워크트리 / 브랜치

- 워크트리: `.claude/worktrees/routine-google-sync`
- 브랜치: `feature/routine-google-sync` (origin/dev `d3d7a2a` 위에 rebase됨, push 완료)
- **dev 미머지** — 이 브랜치는 feature 브랜치다. main은 PR-only, push는 dev만(이 작업은 feature 브랜치로 격리).

### 완료 (origin에 push됨)

| 단계       | 커밋                | 내용                                                                                 |
| ---------- | ------------------- | ------------------------------------------------------------------------------------ |
| ADR + plan | `2e2fdf9`/`a966df9` | ADR-0005 freeze, plan amend                                                          |
| PR 1       | `d5caf3d`/`c9dc6c4` | 0037 마이그레이션 + `routines/rrule.rs` 순수 매핑 + 26 테스트                        |
| (refactor) | `ee235e3`           | `CreateEventInput` recurrence/time_zone 확장                                         |
| PR 2a      | `ffb19be`           | enable/disable IPC + provider injection + `RRuleSpec::to_event_parts()`              |
| PR 2b-1    | `e809912`           | `RoutineToday`/입력에 google·monthly 필드 노출 + crud 배선 + enable kind 매핑 검증   |
| PR 2b-2    | `5cc7b49`           | RoutineSyncButton(동기화 토글 + 캘린더 picker) + popover overlay-stack Esc 수정      |
| PR 2b-3    | (이 세션)           | monthly nth_weekday 편집 UI + IPC-boundary 검증 + **로컬 due-calc nth_weekday 정합** |

핵심 결정(잠금): **루틴 kind ↔ 프로젝트 kind 매핑** — 개인 루틴은 개인 프로젝트, 업무 루틴은
업무 프로젝트 캘린더에만 sync. 백엔드가 `project.kind == routine.kind` 검증(교차 노출 차단).
monthly 패턴 미지정 시 enable에서 `day_of_month` 기본(로컬 due-calc 일치).

### 다음 작업 (우선순위 순)

1. **⚠️ cmux Esc 라이브 스모크** (deferred, blocking-ish) — PR 2b-2의 RoutineSyncButton popover를
   보드에서 열고 Esc → 창이 안 숨고 popover만 닫히는지 확인(`docs/areas/shadcn-migration.md` §52-58).
   헤드리스에서 실행 못 했음. **인터랙티브 세션 필수.** (overlay-stack 단위계약+select.tsx 동일 패턴으로
   결정적 근거는 있으나 라이브 미확인.) PR 2b-3은 native `<select>` 없이 버튼 행으로 구현해 새 overlay를
   추가하지 않았으므로 이 스모크 범위는 2b-2 popover 그대로.
2. **PR 3** — 루틴 편집 시 PATCH 전파(§5 PR 3). `update_routine_inner`는 현재 `google_*` 미변경
   (crud.rs 주석) — 동기화된 루틴의 스케줄 편집이 Google master event에 전파되도록 PATCH 추가.
3. **PR 4** — 오늘 unschedule = EXDATE PATCH(§5 PR 4).
4. **PR 5** — invariant 가드 + 캘린더 이동/삭제 경로(§5 PR 5).

> **PR 2b-3 완료 노트**: monthly nth_weekday 편집 UI + IPC-boundary 검증(`crud::validate_monthly_input`)
>
> - 로컬 due-calc nth_weekday 정합(`schedule::routine_due_on`에 monthly_pattern/nth_week 인자 추가,
>   호출처 4곳 갱신). 사용자 결정으로 로컬 due-calc까지 같은 PR에 포함(local↔Google 정합). nit(비차단):
>   nth_weekday 요일 미선택 시 submit 무피드백(기존 weekly 관례와 동일, 백엔드가 차단).

### 컨텍스트 재진입 단축경로

이 파일(§1 결정 + §8 핸드오프) + `docs/adr/0005-routine-google-sync.md` + 아래 4개 핵심 소스만
읽으면 즉시 재개 가능:

- `src-tauri/src/routines/rrule.rs` — RRULE/EXDATE 매핑 정본
- `src-tauri/src/commands/routines/google_sync.rs` — enable/disable IPC + kind 검증
- `src/components/board/RoutineSyncButton.tsx` + `src/lib/routineSync.ts` — 동기화 UI + 순수 로직
- `src-tauri/migrations/0037_routines_google_sync.sql` — 스키마

검증 명령(정본 `docs/reference/commands.md`): `cargo test --lib` / `cargo clippy --all-targets -- -D warnings`
/ `cargo fmt --check` / `pnpm typecheck` / `pnpm lint` / `pnpm vitest run`. cargo PATH는
`export PATH="$HOME/.cargo/bin:$PATH"` 필요(커밋 시 husky pre-commit도). 백그라운드 셸은 cwd가
워크트리 루트로 리셋되니 `--manifest-path src-tauri/Cargo.toml` 권장.
