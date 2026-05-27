---
status: live
owner: repo-maintainers
last_reviewed: 2026-05-28
source_of_truth_scope: Today 표면 (트레이 + 시간축), calendar_sync 워커, ATracker 분할
---

# Area — Today × Timeline

Today 표면은 캡처 보드와 별개의 **운영(실행) 표면**이다. 결정(quadrant, area
분류)은 보드에서 내리고, 실행(언제 할지, 캘린더 어디에 둘지)은 여기서 한다.
이전의 별도 `/timeline` 라우트는 본 area로 흡수됐다 (spec 2026-05-28 §D1).

## Invariants

1. 시간축 배치 = **결정 레일 아님** (INVARIANT #1 무관). `quadrant`/`area`는
   자동 확정 0건. 시간축에서 `quadrant`/`area`를 자동 갱신하면 안 된다.
2. **카드(signal)가 정본, Google은 mirror**. ADR-0002 참조. last-write-wins,
   단 큐에 우리 pending이 있으면 우리 값이 이긴다.
3. 모든 외부 mutation은 **`pending_calendar_writes` 큐 경유**. 프런트에서
   직접 `commands.createCalendarEvent`/`updateCalendarEvent` 등을 호출 금지.
4. **Google API sync 디바운스 + backoff `[1s, 3s, 9s]` 3회**. 무한 retry 금지.
   terminal failure는 `CalendarSyncFailed` 이벤트로 표면화 (ADR-0003).
5. **Cross-calendar 이동만 명시 Acceptance** ("적용" 버튼 = `commit_staged_writes`).
   within-cal 시간 nudge/리사이즈는 사람 손 = 암묵 통과(INVARIANT #7).
6. `@dnd-kit` import는 **`src/components/today/**`에만\*\* 등장 (ADR-0004).
7. **로컬 시각 ISO 보존** — 모든 시간 계산은 `YYYY-MM-DDTHH:MM:SS` 로컬 포맷.
   `.toISOString()` 사용 금지(UTC drift → 자정/DST 교차 시 블록 위치 깨짐).

## File globs

- `src/components/today/**` — 컴포넌트(TodayHeader, UnscheduledTray,
  TimelineCanvas, TimelineBlock, EventPopover, CalendarPickerPopover,
  StagedBadge, useTimelineDnd)
- `src/components/TodayView.{tsx,css}` — 셸 + 스타일
- `src/lib/timelineLayout.ts` · `todayBlocks.ts` · `calendarSync.ts` ·
  `calendarSyncEvents.ts` · `optimisticSchedule.ts` — 순수/IPC 헬퍼
- `src/lib/query/calendarSync.ts` — `usePendingWrites` 등
- `src-tauri/src/calendar/sync.rs` · `pending_store.rs` — 워커 + 큐
- `src-tauri/src/commands/calendar_sync.rs` — IPC 4종
- 마이그레이션: `0029_project_default_write_calendar.sql`,
  `0030_signal_scheduling.sql`, `0031_routine_check_time_override.sql`,
  `0032_pending_calendar_writes.sql`

## ATracker 분할 알고리즘 (`src/lib/timelineLayout.ts`)

순수함수. 입력 `TimedBlock[]` → 출력 `LayoutBox[]`. 절차:

1. 시작시간 정렬 → 클러스터링 (활성 max end <= next start이면 클러스터 종료).
2. 클러스터 내 그리디 컬럼 배정 (가장 왼쪽 빈 컬럼).
3. `clusterCols = max(col)+1`, `widthPct = 100/clusterCols`,
   `leftPct = col * widthPct`.

테스트는 6개 케이스 (`src/lib/timelineLayout.test.ts`):
단일/순차/2겹/3겹/cluster boundary/all-day 제외.

## Sync 워커 호출 패턴

프런트는 **항상** `commands.stageCalendarWrite`만 호출한다 (`src/lib/calendarSync.ts`의
`stage()` 헬퍼 경유). 직접 `commands.createCalendarEvent` 등을 호출하면
디바운스/큐가 우회돼 INVARIANT 위반.

```
UI 드래그 → useTimelineDnd.onDragEnd
        → stage({ kind: "...", ... })
        → commands.stageCalendarWrite (IPC)
        → calendar/pending_store::upsert_write (SQLite UPSERT)
        → tokio Notify wake
        → calendar/sync.rs worker (Google API debounce, backoff, staged skip)
        → Google Calendar API (PATCH/POST/DELETE)
        → 행 삭제 (성공) 또는 last_error + CalendarSyncFailed (terminal)
```

## Esc / overlay-stack

`EventPopover`, `CalendarPickerPopover`는 shadcn Popover(radix)다 — App 셸의
overlay-stack에 자동 등록되어 첫 Esc는 popover 닫음, 두 번째 Esc는 창
hide(Raycast 모델)로 양보된다. 별도 키 핸들러 불필요.

드래그 중 Esc는 `@dnd-kit`이 자동으로 `onDragEnd(over=null)` 호출 → 우리 코드는
`over` 없으면 early return(`useTimelineDnd.ts`). 추가 핸들러 불필요.

## 접근성

- 시간축 블록(`TimelineBlock`): `<button type="button">`,
  `aria-label="{title} {HH:MM}–{HH:MM} ({calendar})"`.
- 헤더 debt chip: `<button>`, `aria-label="{label} {count}"`.
- 트레이 row: `<div role="listitem">`, 트레이 body `role="list"`.
- 트레이 종일 섹션: `aria-expanded`로 펼침 상태 노출.
- 색만으로 의미 전달 금지 — 루틴은 ↻ 아이콘으로도 구분, 완료 루틴은
  취소선 + opacity 페이드.
- `prefers-reduced-motion: reduce`에서 `.tl-block` transition + now line
  60s 슬라이드 비활성화.

## v2 follow-ups (의도적 deferred)

다음 항목은 spec §10 / PR 5~7 검토에서 v2로 합의됨. PR을 새로 열 때 본 섹션을
업데이트.

- **빈 캔버스에 직접 그려 만들기(`createBlank`).** 현재 트레이→캔버스 schedule만.
  포인터 드래그로 새 시간 블록을 그리는 UX는 복잡(드래그 vs 클릭 vs 리사이즈와 충돌)
  → v2.
- **Per-calendar 드롭 밴드 (cross-cal `MoveCalendar`).** 현재 staged 자동, 캘린더
  선택은 popover. 캔버스에 캘린더별 드롭존을 시각화하는 UX는 별도 디자인 필요 → v2.
- **Google 딥링크 full eid base64 인코딩.** 현재는 `linkedEventId` 평문을 URL에
  붙임. 일부 이벤트에선 401/403. Rust-side resolver(`gcal:open_event`)로 처리
  예정 → v2.
- **멀티 일자(00:00 넘는) 이벤트.** v1은 same-day만. cross-day는 트레이 칩 +
  기존 모달 위임.
- **Week view.** Calendar Drawer가 담당. 시간축 자체에 week 그리드는 없음.
- **자동 스크롤(드래그 중 가장자리).**
- **키보드 only 블록 이동.** `@dnd-kit` KeyboardSensor 기본 동작은 지원되나,
  block-to-canvas 픽셀 이동의 UX 설계는 v2.
- **키보드 only 블록 resize.** resize handle은 KeyboardSensor attribute를 받지만
  6px 띠가 시각적으로 focus indicator를 표시하지 않아 실용 불가. 향후 더 큰 focus
  ring + `aria-keyshortcuts` 필요.
- **signal "더보기" → 보드 점프 시 해당 카드 스크롤/하이라이트.** 현재
  `goTo("board")`만 호출 — 어떤 카드 때문에 왔는지 시각적 단서 없음.
- **명시적 충돌 토스트** (silent last-write-wins 대신). 실제 사용 신호 보고 결정.

## 검증 명령

```bash
# 프런트(영역 단위)
pnpm vitest run timelineLayout todayBlocks optimisticSchedule

# Rust(워커/큐)
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test calendar::sync calendar::pending_store
```

`docs/reference/commands.md`가 전역 명령 인덱스 정본. 본 문서는 area-local 빠른
참조만.
