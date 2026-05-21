# Phase 11 — Today / Timeline / Weekly review / Work Debt (정본 설계)

> Phase 10(Google Calendar read 레일) 완료 후 진입. 이 문서는 brainstorming(AskUserQuestion)으로
> 확정한 Phase 11 설계 정본이다. PLAN.md Phase 11 / docs/decisions.md "Phase 11" 항목과 함께 읽는다.
> 상위 규칙은 PLAN.md §1 INVARIANTS 7개 + AGENTS.md.

## 0. 확정된 설계 선결 (사용자 결정, AskUserQuestion)

1. **Timeline = 오늘 시간축 아젠다.** 캘린더 타임드 이벤트 + Today 레일 + Q1을 한 날의 시간대별
   세로 타임라인으로 병합. 날짜 피커로 앞뒤 이동. all-day/untimed는 상단 밴드. (히스토리 피드 아님.)
2. **Weekly review = 4종.** ① 처리량(캡처/완료/승격) ② PR 활동(머지/오픈) ③ 루틴 이행률 ④ 부채 추세.
3. **Work Debt = Today 뷰 상단 스트립 + PLAN 4지표**(미분류 · Q1 overdue · stale backlog · cleanup needed).
4. **3 PR 분할:** (11a) Today 운영 뷰 + Work Debt → (11b) Timeline → (11c) Weekly review.

## 1. 아키텍처 결정 (대안 포함)

- **A. Today는 새 전용 뷰**(`view: "today"`)다. 캡처 보드의 우측 Today 레일(curate/decide)은 그대로 두고,
  새 Today 뷰는 execute/overview 콕핏. 둘은 `list_today`/`toggle_today_done` 데이터를 공유(로직 중복 없음).
  PLAN.md:97 "전체 Today 운영 뷰는 Phase 11" 근거. (대안: 보드에 욱여넣기 → 5영역 이미 과밀, 기각.)
- **B. 부채 추세는 신규 테이블 필요(migration 0007 `debt_snapshots`).** 현재 DB는 *현재 상태*만 보관하고
  `updated_at`이 덮여서 일별 부채를 재구성할 수 없다. → `debt_snapshots(date PK, …)`를 **하루 1회 멱등 upsert**
  (INVARIANT #3 upsert-not-append)로 Today 뷰 진입 시 기록. 추세는 *전진 누적*(첫 주는 sparse, 백필 없음).
  11a에서 도입(Work Debt 카운트는 어차피 11a에서 계산) → 11c가 읽는다.
  (대안: flow에서 추세 유도 → 정확 재구성 불가, 기각. 대안: 현재 상태만, 추세 없음 → 선택한 지표 누락, 기각.)

## 2. PR 11a — Today 운영 뷰 + Work Debt

### Backend
- 신규 커맨드 `today_overview(date) -> TodayOverview`:
  `{ work_debt{unclassified,q1_overdue,stale_backlog,cleanup_needed}, q1_items: Vec<SignalView>, pr_attention: Vec<SignalView>, unclassified_count }`.
  Today 레일/루틴/캘린더는 프런트가 기존 훅(`useToday`, `useTodayRoutines`, `fetchCalendarEvents`)으로 합성.
- **임계치(문서화 상수):** `Q1_OVERDUE_DAYS = 1`(q1_do_now open & 생성 ≥ 1일 경과),
  `STALE_DAYS = 14`(open & 생성 ≥ 14일, today 레일/done/archived 제외), cleanup = `type='cleanup'` open.
- **migration 0007 `debt_snapshots`** + Today=오늘일 때만 멱등 daily 스냅샷 write
  (`ON CONFLICT(date) DO UPDATE` 최신값으로). 과거 날짜 조회는 스냅샷 쓰지 않음.
- specta: 카운트는 `i32`/`u32`(i64 금지).

### Frontend
- `store.ts` View += `"today"`. 신규 `TodayView.tsx`. 섹션(위→아래):
  **Work Debt 스트립(4 타일, 클릭 시 소스로 점프)** → 캘린더 오늘 이벤트(미연결 graceful degrade)
  → Q1 리스트 → Today 레일(focus, 완료 토글) → PR attention → 루틴.
- `query.ts` `useTodayOverview(date)`. CommandPalette "Today (운영)로" + App 렌더 + Esc + `.today-*` styles.
- Today = 오늘 고정(날짜 피커 없음 — 날짜 네비는 11b Timeline).

### Done-criteria
- [ ] Today가 Q1 / 캘린더 오늘 이벤트 / PR attention / 미분류 수를 정확히 집계
- [ ] Work Debt 4지표(미분류·Q1 overdue·stale backlog·cleanup needed) 표시

## 3. PR 11b — Timeline (오늘 시간축 아젠다)

### 구현 (주로 프런트)
- `fetchCalendarEvents(null, date)`(신규 `useCalendarEvents(date)` 쿼리 훅으로 래핑) + `list_today(date)` +
  Q1 항목 합성. 세로 시간 그리드, 타임드 이벤트=블록, **all-day + Today 레일 + Q1 = 상단 untimed 밴드.**
  날짜 피커(이전/오늘/다음). 이벤트 클릭→htmlLink, Today 항목 클릭→토글/점프.
- **주의:** 비-오늘 날짜는 `today_window(date, now-offset)` 사용 → Phase 10b DST 경계 MINOR 승계(허용).
- `store.ts` View += `"timeline"`, CommandPalette/App/Esc/`.timeline-*`.

### Done-criteria
- [ ] 이벤트가 시간축에 렌더, 날짜 피커 동작, all-day 밴드, Today/Q1 병합

## 4. PR 11c — Weekly review

### Backend
- 신규 커맨드 `weekly_review(week_start?) -> WeeklyReview` (지난 7일):
  - `throughput{captured,completed,promoted}` — 기존 타임스탬프에서 **live 유도**
    (`signals.created_at`, `today_done_at`, acceptances/promotions `created_at`).
  - `pr_activity` — **유도 가능분만(정직).** PR Radar는 ambient(머지 히스토리 미영속) → 범위 내 신규
    PR-attention 신호(`source='github_pr'` created_at) + 현재 merged-cleanup 버킷(point-in-time).
    실 머지 로그는 범위 밖(Phase 4 변경 필요) — 문서화된 한계.
  - `routine_adherence` — `routine_checks` 완료 vs freq/weekdays로 계산한 해당일 수.
  - `debt_trend` — `debt_snapshots` 최근 7일(11a부터 누적). 7일 미만이면 있는 만큼.
- specta i32/u32.

### Frontend
- `store.ts` View += `"weekly"`. `WeeklyView.tsx`: 처리량 카드 / PR 활동 / 루틴 이행률 % /
  부채 추세 스파크라인 + 완료 항목 하이라이트. `query.ts` `useWeeklyReview()`. CommandPalette/App/Esc/`.weekly-*`.

### Done-criteria
- [ ] 주간 4종(처리량·PR 활동·루틴 이행률·부채 추세)을 7일 범위로 집계

## 5. INVARIANTS 적합성

세 뷰 모두 **read 집계 + 기존 사람 액션 재사용**. 자동 분류 없음(#1), 외부 mutate 0(#2 전부 로컬/read),
`debt_snapshots` 멱등 upsert(#3)·로컬 상태 SSOT(#7), 캘린더는 ambient 미영속(#4), 에이전트 잡 없음(#5/#6 N/A).
토큰/외부호출 변화 없음. specta 카운트 i32/u32.

## 6. 검증 계획

- Rust: 임계치 쿼리·스냅샷 upsert 멱등·weekly 집계 순수 로직 `cargo test`. clippy -D warnings, fmt --check.
- 프런트: pnpm typecheck/build. bindings 재생성(cargo test export).
- 실 캘린더 fetch·실 GUI 렌더·다일 누적 추세는 사용자 관찰(`pnpm tauri dev`).
- 각 PR 종료 시 INVARIANTS reviewer 패스(self-approve 금지) → decisions.md 한 줄.
