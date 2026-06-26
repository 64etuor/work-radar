# 루틴 활성 기간 (시작일 + 종료일) — Design

- 날짜: 2026-06-25
- 상태: 구현 완료 · 독립 Opus critic ACCEPT · 전 게이트 green · **미커밋**(사용자 커밋 지시 대기)
- 도메인: 루틴(`src-tauri/src/commands/routines/**`, `src-tauri/src/routines/**`, `src/components/board/Routine*`)
- 관련 정본: ADR-0005(routine Google sync), `docs/areas/data-layer-conventions.md`, `docs/areas/ipc-conventions.md`

## 1. 문제 / 목표

루틴은 한 번 만들면 **수동으로 끄거나(`active=0`) 지울 때까지 무기한** 반복된다.
사용자가 _기간이 정해진_ 루틴(예: "이번 분기 동안 매일", "30일 챌린지", "시험 전까지
매주 화·목")을 표현할 방법이 없다.

목표: 루틴 생성/수정 시 **선택적 활성 구간** `[start_date, end_date]`을 지정할 수 있게 한다.

## 2. 합의된 결정 (brainstorm)

1. **기간 모양 = 시작일 + 종료일** (둘 다 optional).
   - `start_date` 비움 = 하한 없음(생성 시점부터, = 현재 동작).
   - `end_date` 비움 = 무기한(= 현재 동작).
   - 둘 다 비움 = **현재 동작과 동일** → 기존 루틴/흔한 경우 **행동 변화 0**.
2. **Google 캘린더 동기화에도 구간 미러링** (full parity).
   - 동기화 ON이면 Google master recurring event도 `start_date`에 시작(DTSTART floor)·
     `end_date`에 종료(RRULE `UNTIL`). 로컬·Google이 항상 일치(이 코드베이스의 parity 원칙).

## 3. 핵심 의미 — "구간 밖 = 오늘 해당 안 됨"

활성 구간 밖의 날짜는 루틴이 **"due 아님"**으로 처리된다. 이는 **이미 존재하는 요일
게이팅과 정확히 같은 의미**다 — 월요일 루틴이 화요일에 안 보이는 것과 동일. 따라서:

- 오늘 목록(`list_today_routines`): 구간 밖이면 카드가 안 보임(요일 미스매치와 동일).
- 트래킹/주간 이행률: 구간 밖 날짜는 due로 세지 않음.
- 관리(편집/삭제)는 "오늘" 패널에서 due일 때 하므로, **구간 안에 있을 때 편집/연장 가능**
  (요일 루틴을 해당 요일에만 편집하는 것과 동일한 기존 제약 — 신규 제약 아님).
- 만료된 루틴은 여전히 `active=1`이라 **트래킹 화면엔 due=0으로 남아 가시성 유지**.

`active`(수동 on/off)와 기간은 **직교**한다: 둘 중 하나라도 막으면 숨김. 충돌 없음, additive.

## 4. 데이터 모델 — migration `0061` (순수 additive)

```sql
-- 0061_routine_active_period.sql
ALTER TABLE routines ADD COLUMN start_date TEXT;  -- 'YYYY-MM-DD', NULL = 하한 없음
ALTER TABLE routines ADD COLUMN end_date   TEXT;  -- 'YYYY-MM-DD', NULL = 무기한
```

- 테이블 rebuild·FTS·복잡 CHECK 불필요 → 0011 같은 FK-안전 rebuild 위험 없음.
- 날짜 형식(`YYYY-MM-DD`)·순서(`end >= start`) 검증은 **Rust app-level**(monthly `nth_week`
  교차검증을 app이 보증하는 것과 동일 패턴 — SQLite CHECK로 날짜 형식 강제는 부적절).
- INVARIANT #7(SQLite 마이그레이션으로만) 준수. auto-classify 컬럼 아님(#1 무관).

## 5. due 게이트 — `routine_due_on`이 단일 정본 (한 곳만 고친다)

`schedule.rs::routine_due_on()`는 daily/weekly/biweekly/monthly의 "이 날 **패턴상** due인가"를
결정하는 **순수 함수**다. 여기에 **별도의 순수 윈도우 술어**를 더해 호출부에서 AND-결합한다:

> 신규 `within_active_window(start: Option<&str>, end: Option<&str>, date: NaiveDate) -> bool`:
>
> ```
> start 있고 date < parse(start) → false
> end   있고 date > parse(end)   → false
> 그 외 true. (형식 깨진 날짜는 true=통과 — 진입점 검증이 형식 보장; 방어적.)
> ```
>
> 호출부는 `routine_due_on(...) && within_active_window(start, end, date)`로 결합.

- **`routine_due_on` 시그니처는 불변** — mod.rs의 ~25개 패턴 테스트가 그대로 통과(diff 최소).
  "패턴 매칭"(routine_due_on)과 "활성 구간"(within_active_window)을 분리 → 각각 독립 테스트.
  의미는 `start 전·end 후 게이트 후 패턴`과 동일(due ⟺ 패턴∧구간).
- **대안(거부): SQL `WHERE`절 게이팅.** `listing.rs`는 SQL이지만 `tracking.rs`/`weekly.rs`는
  Rust에서 날짜를 enumerate한다. SQL 게이팅은 후자를 커버 못 함 → 순수 술어 결합이 세 경로를
  한 번에 일관시킨다.
- 호출부 4곳(listing 1 · tracking 1 · weekly 2 [done·due 둘 다 적용 → done ⊆ due 유지]): SELECT에
  `start_date, end_date` 추가 + FromRow 구조체 필드 추가 + AND-결합. `RoutineToday` 매핑에도
  두 필드 포함(폼 편집 시드용).

## 6. Google 동기화 — 구간 미러링 (full parity)

동기화는 생성 후 opt-in 토글(`enable_routine_google_sync`)이며, master recurring event를
`build_master_event_input`(→ `routine_to_rrule`)로 만든다. 구간을 여기에 반영한다.

### 6a. `end_date` → RRULE `UNTIL` (전 freq, 단순)

RRULE 끝에 `;UNTIL=<YYYYMMDD>T<HHMMSS>` 추가. UNTIL은 RFC5545에서 **마지막 가능 인스턴스
시각(inclusive)** — `end_date` + 루틴 `time_of_day`로 만들어 end_date 당일 발생은 포함,
다음 발생은 제외. **기존 `until_for_previous_day` + `cap_recurrence_before` 헬퍼가 이미
이 포맷·삽입 메커니즘을 구현**(편집 시 series-split UNTIL)하므로 재사용/미러.

### 6b. `start_date` → DTSTART floor (parity 보존)

DTSTART는 **`start_date` 이후 첫 스케줄 발생일**이어야 하되, **패턴(BYMONTHDAY/BYDAY/INTERVAL/
BYSETPOS)은 원래 anchor에서 그대로** 유지(예: "매월 31일 클램프"가 깨지면 안 됨).

- **계산 방법(parity-safe):** `build_master_event_input`(google_sync.rs)에서 `start_date`가
  있으면 그 날부터 하루씩 forward 스캔하며 **원래 freq/weekdays/anchor/pattern으로
  `routine_due_on`이 true인 첫 날** = `effective_dtstart`. **로컬 SSOT를 재사용**하므로
  biweekly 2주 parity·monthly day 클램프·nth_weekday가 **구성적으로 로컬과 일치**.
  - 스캔은 패턴 occurrence를 찾는 것이므로 `routine_due_on`에 **start/end 윈도우 게이트는
    넘기지 않는다**(start=None/end=None) — 순환 회피. start_date 자체가 floor.
  - **스캔 상한:** hard cap 366일(early-exit). 보통 daily ≤1·weekly ≤7·biweekly ≤14·
    monthly day_of_month ≤31. 단 `nth_weekday`의 5번째(존재 안 하는 달 건너뜀)는 최대 수개월
    뒤일 수 있어 넉넉한 상한 필요. 366일 내 발생 없으면 빈 구간(6b edge)으로 취급.
- **rrule.rs 변경:** `RRuleInput`에 `dtstart_override: Option<&str>` 추가 — 설정되면 DTSTART
  날짜만 대체하고 **RRULE 패턴 도출은 `anchor_date` 그대로**(monthly 클램프 보존). `start_date`
  없으면 기존 자연 DTSTART(현재 동작 무변화).
- **빈 구간 edge:** `effective_dtstart > end_date`(구간 내 발생 0)면 master event 생성을
  **skip 또는 `routine.sync.empty_window` validation 에러**로 surface(파괴적 호출 전 차단).

### 6c. 편집 series-split과의 합성

편집 시 `split_routine_sync_after_edit_with_provider`가 옛 master를 effective_date 전날로
UNTIL cap하고 새 master를 만든다. **새 master의 UNTIL = `end_date`**(있으면)로 둔다 — 즉
구간 end와 split UNTIL 중 **end_date를 새 series의 종료로 적용**. 옛 series는 기존대로
effective_date 전날 cap. (구현: `first_due_on_or_after`의 floor = `max(start_date, reference_override)`
라 새 master는 과거를 재생성하지 않고, old master는 `cap_recurrence_before`가 window UNTIL을
effective-1로 덮어쓴다.)

**빈-구간 가드(critic Finding #1 반영):** `first_due_on_or_after`는 `start_date` 유무와 무관하게
**`window_end`가 있으면 항상** 실행된다(floor = `start_date` 있으면 그것, 없으면 자연 기준
`reference`). 따라서 end_date만 있고 그 end가 DTSTART보다 과거인 경우(예: 만료된 end-only 루틴
enable)에도 `DTSTART > UNTIL` 깨진 RRULE 대신 `routine.sync.empty_window`로 정직하게 거부한다.
구간 안에 발생이 있으면 동기화 전파가 정상 동작하고, 없으면 로컬 편집/생성은 커밋되되 동기화는
patch_failed로 surface된다.

**잔존 deferred 엣지:** 루틴을 *생성 당일 첫 발생 전*에 편집하면 split의 old master가
DTSTART(첫 발생) > UNTIL(effective-1)로 degenerate해질 수 있다 — 이는 활성 구간과 무관한
**기존 split 동작**이며(window 미사용 시에도 동일) 본 변경의 회귀가 아니다. 별도 follow-up.

## 7. 폼 / UX — `RoutineForm.tsx`

기존 컴팩트 폼에 "기간" 행 1개 추가:

- `시작일` / `종료일` 두 개의 `<input type="date">`. **둘 다 빈칸이 기본**(=무기한, 현재 동작).
- 클라이언트 검증: 둘 다 있고 `end < start`면 제출 차단(기존 요일/nth_weekday 검증과 동일
  방식 — `submit`에서 early-return). 형식은 `type="date"`가 보장.
- 편집 모드: `RoutineToday.startDate/endDate`로 시드(빈 값이면 빈칸).
- 카피: 행 라벨 "기간(선택)", hint "비우면 무기한 반복". (DESIGN.md 토큰/기존 `.rtime` 패턴 따름.)

### 타입 흐름 (camelCase, 기존 패턴)

- `RoutineDraft`(routineSchedule.ts) += `startDate: string | null`, `endDate: string | null`.
- `CreateRoutineInput`/`UpdateRoutineInput`(models/routines.rs) += `start_date`/`end_date`
  (`Option<String>`). `RoutineToday` += 동일.
- CaptureBoard의 draft→input 매핑에 두 필드 추가.
- `bindings.ts`는 **`cargo test`로 재생성**(수기 TS IPC 타입 금지 — INVARIANT). drift = CI 게이트.

## 8. 검증 (Rust, crud.rs)

`insert_routine`/`update_routine_inner` 진입 전(또는 `create_routine`/`update_routine`
command에서) 신규 헬퍼 `validate_active_period(start, end)`:

- 각각 있으면 `YYYY-MM-DD` 파싱 성공해야 함(실패 → `routine.period.bad_date`).
- 둘 다 있으면 `end >= start`(위반 → `routine.period.end_before_start`).
- 빈 문자열은 `None`으로 정규화(기존 `time_of_day` trim→NULL 패턴과 동일).

## 9. 테스트 (행동 변경엔 테스트 — Review Bar)

- `schedule.rs`: `routine_due_on` 게이트 단위 테스트 — start 전/start 당일/구간 내/end 당일/
  end 후, daily·weekly·monthly 각각; start=None·end=None 무변화 회귀.
- `crud.rs`: `validate_active_period` — 형식 오류, end<start, 빈 문자열 정규화, 단방향(start만/end만).
- `rrule.rs`: `dtstart_override` 적용 시 DTSTART만 바뀌고 BYMONTHDAY=31 클램프 패턴 유지;
  `UNTIL` 부착 포맷(daily/weekly/monthly).
- `google_sync.rs`: 구간 있는 루틴 enable → create_event 페이로드의 RRULE에 `UNTIL=` 포함 +
  DTSTART가 effective_dtstart; 빈 구간 → skip/empty_window.
- `tracking.rs`/`weekly.rs`: 구간 밖 due 미집계(간단 케이스 1개씩).
- 프런트: RoutineForm `end < start` 제출 차단 dom 테스트(기존 RoutinesPanel.dom.test 패턴).

## 10. 변경 파일 요약

| 파일                                        | 변경                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| `migrations/0061_routine_active_period.sql` | **신규** — `start_date`/`end_date` ADD COLUMN                          |
| `models/routines.rs`                        | `RoutineToday`/`CreateRoutineInput`/`UpdateRoutineInput` += 2 필드     |
| `commands/routines/crud.rs`                 | insert/update 바인딩 + `validate_active_period`                        |
| `commands/routines/schedule.rs`             | 신규 `within_active_window` 순수 술어 (+테스트); `routine_due_on` 불변 |
| `commands/routines/listing.rs`              | SELECT/FromRow/매핑 += 2 필드, `&& within_active_window` 결합          |
| `commands/routines/tracking.rs`             | SELECT/FromRow += 2 필드, `&& within_active_window` 결합               |
| `commands/today/weekly.rs`                  | 2개 SELECT + done·due 두 루프에 `&& within_active_window` 결합         |
| `routines/rrule.rs`                         | `RRuleInput.dtstart_override` + `UNTIL` 부착 (+테스트)                 |
| `commands/routines/google_sync.rs`          | effective_dtstart 스캔 + end→UNTIL 합성 + 빈 구간 가드                 |
| `components/board/routineSchedule.ts`       | `RoutineDraft` += `startDate`/`endDate`                                |
| `components/board/RoutineForm.tsx`          | 기간 입력 2개 + 검증                                                   |
| `components/CaptureBoard.tsx`               | draft→input 매핑 += 2 필드                                             |
| `src/bindings.ts`                           | `cargo test` 재생성(drift 게이트)                                      |

## 11. 범위 밖 (YAGNI / 명시적 deferred)

- "N일/N주 챌린지" 빠른 길이 프리셋 — 시작+종료로 표현 가능, 별도 UX는 follow-up.
- 만료 루틴 자동 archive/정리 UI — 현재처럼 트래킹에 남김(가시성). 별도 follow-up.
- 시작일 전 "예정" 배지/카운트다운 표시 — 표시 전용, follow-up.
- 단일 부기(single-package) 외 영향 없음.

## 12. INVARIANT 점검 (decision-rails 7개)

- #1 자동분류 결정레일 침투: **무관**(순수 로컬 스케줄 필드, 자동화 아님).
- #5 bounded retry: **무관**(신규 네트워크 루프 없음; Google PATCH는 기존 경로 재사용).
- #7 SQLite 마이그레이션으로만 + 로컬 SSOT: **준수**(0061 additive, 외부 무관 로컬 필드).
- IPC=생성 타입: **준수**(`bindings.ts` 재생성, 수기 금지).
- AppError 단일 envelope: **준수**(신규 검증 에러는 `AppError::validation`).
- 토큰/PII 로그: **무관**.
- 별도 reviewer 패스(self-approve 금지): 구현 후 critic 패스 필요.
