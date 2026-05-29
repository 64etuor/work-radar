---
adr-id: ADR-0005
status: proposed
date: 2026-05-29
decision-makers: [yangha.park]
tags: [routines, google-calendar, sync, ipc, schema]
supersedes:
---

# 0005. Routine → Google Calendar 동기화: opt-in master event + PATCH-우선

## Context and Problem Statement

**Scope**: `src-tauri/src/routines/**` (신규 모듈), `src-tauri/src/commands/routines/**`,
`migrations/0037_routines_google_sync.sql`, `src/components/settings/RoutinesSection/**`.

루틴은 "습관"과 "약속"의 스펙트럼 위에 있다. 비타민·스트레칭 같은 daily 루틴을 모두 Google
캘린더에 등록하면 (a) 캘린더가 매일 도배되고 (b) work calendar라면 사적 습관이 노출된다.
반대로 헬스장·PT·약 복용 같은 루틴은 실제 시간 슬롯이라 가족·팀과 안 겹치게 Google에
올라가야 한다.

또한 sync 켜진 루틴을 편집할 때(시간/요일 변경)·"오늘 빼기" 할 때 Google 측 상태 모델을
어떻게 다룰지(전부 DELETE+CREATE인지, PATCH인지)를 정해야 한다. 이는 (a) Google API quota,
(b) 사용자가 Google에 직접 추가한 메타(위치·참석자·알림 설정)의 보존, (c) EXDATE/event id
의 안정성에 직결된다.

## Decision Drivers

- **INVARIANT #1 (자동 분류 0)**: sync 결정은 100% 사용자 토글. 자동/스마트 분류 금지.
- **INVARIANT #2 (외부 변경 = Acceptance 게이트)**: Google 쓰기는 명시적 사용자 액션에서만.
- **INVARIANT #5 (bounded retry)**: 무한 retry/poll 금지. backoff + jitter + terminal failure.
- **INVARIANT #7 (SQLite SSOT)**: Google 상태는 로컬 컬럼/테이블로 mirror, 외부 polling 금지.
- 사용자가 Google에서 직접 편집한 메타(위치·참석자·custom 알림)는 보존되어야 한다.
- 매일 켜지는 sync도 quota 안에 머물러야 한다(불필요한 DELETE+CREATE 회피).
- "오늘만 빼기"는 master 삭제가 아니라 단일 instance skip이어야 한다(다음 occurrence는 살아있어야).

## Considered Options

- **Option A — opt-in master event + PATCH 우선 (채택)**: 루틴별 sync 토글. 켜진 루틴만
  master recurring event 1개를 Google에 생성. 편집은 PATCH, 오늘 빼기는 EXDATE PATCH,
  토글 OFF/루틴 삭제는 DELETE. 캘린더 이동만 DELETE+CREATE (Google API가 calendarId
  변경 PATCH 미지원).
- **Option B — 모든 timed 루틴 자동 sync**: 사용자 결정 없음. 캘린더 도배 + 사적 노출 위험.
  INVARIANT #1 위반.
- **Option C — DELETE+CREATE for every edit**: 편집·skip 시마다 master 재생성.
  Google에서 추가한 메타 매번 손실, quota 낭비, event id 회전 → 외부 참조 깨짐.
- **Option D — per-instance event 생성**(현재 `routine_checks.linked_event_id` 흐름 확장):
  매일 체크 시 단일 이벤트 1개씩. recurring 의미가 없어 사용자가 캘린더에서 시리즈 편집 불가.

## Decision Outcome

**Rule**: 루틴의 Google 동기화는 **opt-in 토글로만** 켜지며, 켜진 루틴은 **Google master
recurring event 1개**(`routine.google_event_id` mirror)로 표현된다. 모든 후속 편집은
**PATCH 우선**, 캘린더 이동만 DELETE+CREATE, "오늘 빼기"는 master에 EXDATE PATCH +
`routine_exdates` 로컬 mirror. 자동 sync·자동 calendar 추론 금지.

Chosen option: **Option A**, because it satisfies all four INVARIANTS, preserves user-added
metadata, minimizes quota, and gives recurring semantics that match how Google represents
habits/appointments.

### Consequences

- Good: 사용자가 Google에 직접 추가한 메타 보존(PATCH가 recurrence/start/end만 갱신).
- Good: quota 절약 — 일상 편집 1 PATCH, master 삭제 1 DELETE, master 생성 1 CREATE.
- Good: EXDATE로 "오늘만 빼기"가 다음 occurrence를 살림.
- Good: 사용자가 Google 클라이언트에서 시리즈로 인식 → 시리즈 편집/확인이 자연스러움.
- Bad: 캘린더 이동은 DELETE+CREATE라 사용자가 Google에 추가한 메타가 손실됨 (UI confirm으로
  명시 surface).
- Bad: 다른 디바이스/사용자가 Google에서 시리즈를 삭제하면 로컬 mirror가 stale — `404
  Not Found`를 graceful로 처리하고 `google_event_id`/`google_calendar_id`를 NULL로 sweep.
- Bad: `linked_event_id`(routine_checks per-instance) 흐름과 별개 — 두 경로가 공존
  (per-instance batch write vs master recurring). 문서/코드에 명확한 경계 표기 필요.

### Confirmation

- 마이그레이션: `0037_routines_google_sync.sql`에 `google_calendar_id`/`google_event_id`/
  `duration_min`/`monthly_pattern`/`monthly_nth_week` 컬럼 + `routine_exdates` 테이블 + pair invariant.
- 단위 테스트(`cargo test --lib routines::rrule`): `routine_to_rrule` 매트릭스 ~15개 +
  `exdate_local` 헬퍼.
- 통합 테스트(PR 2~4): `MockGoogle` 클라이언트로 CREATE/PATCH(EXDATE)/DELETE 라운드트립.
- IPC: `enable_routine_google_sync`/`disable_routine_google_sync`/`patch_routine_master`/
  `exclude_routine_today` — `cargo test --lib commands::routines` + `pnpm typecheck`로
  `src/bindings.ts` drift 0.
- Reviewer checklist: PR 본문에 INVARIANT #1/#2/#5/#7 체크박스 + 실행한 검증 출력.

### Anti-Patterns

- ❌ "자동 sync 추천" UI / "AI가 sync 켜드릴게요" — INVARIANT #1 위반.
- ❌ 편집 시 master DELETE+CREATE — quota 낭비 + 메타 손실.
- ❌ `routine_checks.linked_event_id`를 master id로 백필 — per-instance ≠ recurring master.
- ❌ Google 변경을 주기적으로 polling — INVARIANT #7 위반. `404 → sweep` reactive 경로만.
- ❌ Google 응답 본문을 그대로 로그 — PII. 코드/크기만 (AGENTS.md "로그 PII 금지").
- ❌ "this and following" 시맨틱 처리 — 본 ADR scope 밖. master 통째 PATCH만.

## Pros and Cons of the Options

### Option A — opt-in master event + PATCH 우선 (채택)

- Good: 사용자 의도 명확, INVARIANT #1 자연 충족.
- Good: PATCH로 메타 보존, EXDATE로 단일 instance 처리.
- Bad: master/per-instance 두 경로 공존(문서화로 mitigate).

### Option B — 모든 timed 루틴 자동 sync

- Good: 사용자 입력 0.
- Bad: 캘린더 도배 + 사적 노출 + INVARIANT #1 위반.

### Option C — DELETE+CREATE for every edit

- Good: 코드가 단순(상태 분기 적음).
- Bad: quota 낭비, event id 회전, 사용자 추가 메타 손실.

### Option D — per-instance event 생성

- Good: 현재 `routine_checks.linked_event_id` 흐름 재사용.
- Bad: recurring 의미 없음, Google에서 "시리즈 편집" 불가, EXDATE 의미 없음.

## More Information

- Supersedes: —
- Related: ADR-0002 (Card as Truth, Google as Mirror — 본 ADR이 확장 적용),
  ADR-0003 (Pending Writes Queue — Google 호출은 기존 큐를 통과 또는 동등 bounded retry 적용).
- Implemented in: PR #TBD (PR 1 — schema + RRULE 매핑).
- Key files:
  - `migrations/0037_routines_google_sync.sql`
  - `src-tauri/src/routines/rrule.rs` (신규)
  - `src-tauri/src/routines/google.rs` (PR 2~)
  - `src-tauri/src/models/routines.rs` (필드 추가)
  - `src-tauri/src/commands/routines/google_sync.rs` (PR 2 신규)
  - `docs/plans/2026-05-29-routine-google-sync.md`
