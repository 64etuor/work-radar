# Routine → Google Calendar 동기화 (opt-in)

**Branch**: `feature/routine-google-sync`
**시작일**: 2026-05-29
**전제 컨텍스트**: dev 15c08cc

## 1. 배경 & 결정

루틴은 본질적으로 "습관"이지 "약속"이 아니다. 모든 timed 루틴을 Google에 자동 등록하면 캘린더가 매일 "비타민" "스트레칭"으로 도배되고, work calendar면 사적 습관이 노출된다. 반대로 일부 루틴(헬스장, PT, 약 복용)은 실제 캘린더 슬롯이라 가족/팀과 안 겹치게 Google에 올라가야 한다.

→ **루틴별 opt-in 동기화**. 기본 local-only, 사용자가 켠 루틴만 Google master recurring event로 등록.

### 잠금된 결정 (사용자 확정)
| # | 결정 | 의미 |
|---|---|---|
| 1 | **BYDAY 풍부 모델** | `monthly_pattern` 추가 — `day_of_month` 외 `nth_weekday`("2nd Tuesday", "last Friday") 지원 |
| 2 | **EXDATE 지원** | sync된 루틴의 "오늘 빼기" = master event에 EXDATE PATCH. skip 이력 보존. |
| 3 | **`duration_min` 컬럼 추가** | NULL → 기존 30분 default fallback. 헬스장 60분 / 스트레칭 15분 등 다양성 대응. |
| 4 | **PATCH 전략 (DELETE+CREATE 아님)** | 루틴 편집 시 master event PATCH — EXDATE/이벤트 ID/사용자가 Google에 추가한 메타(위치·참석자·알림) 보존. quota 절약. |

### INVARIANTS 준수
- INVARIANT #1 (자동 분류 0): sync 결정은 100% 사용자 토글. 자동 동기화 X.
- INVARIANT #2 (외부 변경 = Acceptance 게이트): Google PATCH/DELETE는 명시적 사용자 액션에서만.
- INVARIANT #5 (bounded retry): Google 호출은 backoff + jitter + terminal failure 토스트.
- INVARIANT #7 (SQLite SSOT): `google_calendar_id`/`google_event_id`/`routine_exdates` 모두 로컬 마이그레이션으로만.

---

## 2. Schema 델타 (PR 1)

```sql
-- 0036_routines_google_sync.sql

-- 1) routines에 sync 필드 + 풍부 monthly 패턴 + duration 추가
ALTER TABLE routines ADD COLUMN google_calendar_id TEXT;       -- NULL = local-only
ALTER TABLE routines ADD COLUMN google_event_id TEXT;          -- master recurring event id
ALTER TABLE routines ADD COLUMN duration_min INTEGER;          -- NULL → fallback 30
ALTER TABLE routines ADD COLUMN monthly_pattern TEXT
  CHECK (monthly_pattern IS NULL OR monthly_pattern IN ('day_of_month','nth_weekday'));
ALTER TABLE routines ADD COLUMN monthly_nth_week INTEGER
  CHECK (monthly_nth_week IS NULL OR (monthly_nth_week BETWEEN -1 AND 5 AND monthly_nth_week != 0));
-- nth_week: 1=첫째, 2=둘째, 3=셋째, 4=넷째, 5=다섯째(존재 시), -1=마지막

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
- `google_event_id IS NOT NULL` ↔ `google_calendar_id IS NOT NULL` (한쪽만 있으면 inconsistent).

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
```

### 매핑 표

| 입력 | 출력 RRULE | DTSTART |
|---|---|---|
| `freq=daily`, `time=09:00` | `FREQ=DAILY` | `anchor_date or created_at` + 09:00 |
| `freq=weekly`, `weekdays=[mon,wed,fri]` | `FREQ=WEEKLY;BYDAY=MO,WE,FR` | 첫 매칭 요일 |
| `freq=biweekly`, `weekdays=[mon]`, `anchor_date=2026-05-25` | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO` | anchor_date (anchor가 ON 주) |
| `freq=monthly`, `monthly_pattern=day_of_month`, `anchor_date=2026-05-15` | `FREQ=MONTHLY;BYMONTHDAY=15` | anchor_date |
| `freq=monthly`, `monthly_pattern=nth_weekday`, `monthly_nth_week=2`, `weekdays=[tue]` | `FREQ=MONTHLY;BYDAY=2TU` | anchor_date |
| `freq=monthly`, `monthly_nth_week=-1`, `weekdays=[fri]` | `FREQ=MONTHLY;BYDAY=-1FR` | anchor_date |

### 요일 코드 매핑
`["sun","mon","tue","wed","thu","fri","sat"]` → `["SU","MO","TU","WE","TH","FR","SA"]` (상수 함수)

### 단위 테스트 매트릭스 (~14개)
- daily 기본 / DST 전환일 ("2026-03-08" US DST 진입)
- weekly 단일 요일 / 복수 요일 / 모든 요일(=daily 의미)
- biweekly anchor 주 / off-week / anchor 변경
- monthly day_of_month: 1일 / 15일 / 31일(2월 처리는 Google이 알아서 — RRULE은 그대로 전달)
- monthly nth_weekday: 2nd Tue / 1st Mon / -1st Fri
- monthly nth_weekday 5번째 존재 안 함 (RRULE 그대로 전달, Google이 skip)
- EXDATE 1건 + 다중 + 정렬 보장

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
- IPC: `enable_routine_google_sync(routine_id, calendar_id)`, `disable_routine_google_sync(routine_id)`
- Rust: master event CREATE/DELETE + bounded retry + `google_event_id` 저장
- 설정 UI: 루틴 행에 calendar picker + 토글 (signal의 default_write_calendar 흐름 재사용)
- 신규 monthly 필드 편집 UI (radio: day_of_month vs nth_weekday)

**검증**: integration test — fake Google client(`MockGoogle`) injection으로 CREATE/DELETE 라운드트립. 설정에서 토글 후 `google_event_id` populated 확인.

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

### PR 5 — 백필 + invariant 가드
- 기존 linkedEventId가 있던 루틴 sweep → `google_calendar_id` + `google_event_id` 채움 (백필 마이그레이션 또는 startup hook)
- Settings UI: sync ON 루틴의 calendar_id 변경 시 (다른 캘린더로 이동) 명시 confirm
- Routine 삭제 시: sync ON이면 Google master event 먼저 DELETE → 실패 시 confirm "Google 삭제 실패. 로컬만 지울까요?"

**검증**: 백필 멱등성 (재실행해도 같은 결과). DELETE 실패 경로 토스트.

---

## 6. AI/오버엔지니어링 가드

- **"This and following" 시맨틱은 안 다룬다** — PR 3에서 모든 편집은 master 통째 PATCH. 사용자가 "오늘 이후만 변경" 같은 걸 원하면 별도 follow-up.
- **다중 캘린더 이동** — sync 켜진 루틴의 calendar 변경은 DELETE 옛 master + CREATE 새 master (PATCH로 calendarId 못 바꿈 — Google API 제약). PR 5에서 처리.
- **TZ 변경 대응** — 사용자 TZ 변경(예: 출장)은 다음 sync 시점에 새 TZID로 PATCH. 기존 instance는 Google이 wall-clock 유지(의도와 일치).
- **Yearly freq 지원 안 함** — 현재 schema에도 없음. 필요 시 schema 확장 후 별도 PR.

---

## 7. 결정 갱신 로그 위치

- 구조적 결정 (PATCH vs DELETE+CREATE, RRULE subset 등) → `docs/adr/ADR-NNNN-routine-google-sync.md` (PR 1 함께)
- 작은 Phase 트레이드오프 → `docs/decisions.md`에 한 줄씩

---

## 8. 다음 액션 (이번 세션은 여기서 끝, 다음 세션 시작점)

1. 이 plan 검토 + ADR 초안 작성 (`docs/adr/`)
2. PR 1 마이그레이션 SQL 작성 → `pnpm tauri dev` 부팅 확인 (마이그레이션 실패 시 즉시 catch)
3. PR 1 RRULE 함수 + 14개 테스트 TDD 사이클
4. PR 1 PR 본문 작성 + 푸시

**컨텍스트 재진입 단축경로**: 이 파일 + `docs/areas/decision-rails.md` + `docs/areas/data-layer-conventions.md` + `migrations/0011_routines_phase16.sql` 4개만 읽으면 다음 세션 즉시 시작 가능.
