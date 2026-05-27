# Today×Timeline PR 7 — Polish: 반응형 · 모션 · 접근성 · ADR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 본 시리즈의 마무리 — 반응형 (720–1040 / <720) 검증, Esc 계약, 드래그 취소 키, 모션 토큰 적용, 접근성 패스, 그리고 spec §12의 ADR 3건 + area 문서 추가.

**Architecture:** UI 코드 변경 + 문서. 새 컴포넌트 거의 없음 — 기존 컴포넌트의 keyboard handling, aria-*, prefers-reduced-motion, CSS 미디어쿼리.

**Tech Stack:** React, Tailwind v4, ADR 마크다운.

**Spec:** §3 반응형, §8.5 overlay-stack, §11~13. **Depends on:** PR 1~6.

---

### Task 1: 720–1040px / <720px 반응형 검증

**Files:**
- Modify: `src/components/TodayView.css`

- [ ] **Step 1: CSS 미디어쿼리 정밀화**

```css
@media (max-width: 1040px) and (min-width: 720px) {
  .today-main { grid-template-columns: 1fr; grid-template-rows: minmax(120px, auto) 1fr; }
  .today-tray { border-right: 0; border-bottom: 1px solid var(--wr-border-light); max-height: 200px; }
  .today-tray-body { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 4px; }
}
@media (max-width: 720px) {
  .today-main { display: block; }
  .today-tray { border-bottom: 1px solid var(--wr-border-light); }
  .today-canvas-wrap { height: calc(100vh - 280px); }
  .today-debt-chips { flex-wrap: wrap; }
}
```

- [ ] **Step 2: 수동 확인**

```bash
pnpm tauri dev
# 윈도우 폭을 1100 → 900 → 600으로 줄이며 레이아웃 변화 검증.
# 시간축 가로 스크롤 발생 안 함.
```

- [ ] **Step 3: 커밋**

```bash
git add src/components/TodayView.css
git commit -m "polish(today): responsive at 720–1040 + <720 (PR 7/7)"
```

---

### Task 2: Esc 계약 + 드래그 취소

**Files:**
- Modify: `src/components/today/EventPopover.tsx`
- Modify: `src/components/today/CalendarPickerPopover.tsx`

shadcn Popover (radix)는 자동으로 overlay-stack에 등록되므로 App 셸의 Esc → window.hide()를 양보함. 확인만.

- [ ] **Step 1: cmux Esc 스모크**

```bash
pnpm tauri dev
# 1. 보드 → Today 이동 → 블록 클릭 → popover open → Esc 한 번 → popover 닫힘, 창은 그대로
# 2. 두 번 Esc → 창 hide
# 3. cmux에서 Esc로 인한 창 끔/안끔 확인
```
Expected: 1번/2번 모두 정상.

- [ ] **Step 2: 드래그 중 Esc → 취소**

`useTimelineDnd`에서:

```ts
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  useSensor(KeyboardSensor, { /* defaults */ }),
);
// onDragEnd는 ev.activatorEvent가 keyboard일 때 ESC 처리 자동 (dnd-kit 기본 동작)
```

확인: 드래그 중 Esc 누르면 onDragEnd가 over=null로 호출됨 → 우리 코드는 over 없으면 early return → 변경 없음. ✓

- [ ] **Step 3: 커밋 (변경 있을 때만)**

```bash
git add src/components/today/
git commit -m "polish(today): confirm Esc contract + dnd-kit keyboard sensor (PR 7/7)"
```

---

### Task 3: 모션 — prefers-reduced-motion + tokens

**Files:**
- Modify: `src/components/TodayView.css`, `src/styles/motion.css` (있으면)

- [ ] **Step 1: 모션 적용**

```css
.tl-block { transition: transform 120ms cubic-bezier(.4,0,.2,1), box-shadow 120ms; }
.tl-block:active { transform: scale(1.02); box-shadow: 0 4px 16px rgba(0,0,0,.08); }
.today-canvas-now { transition: top 60s linear; } /* 분 단위 부드러운 이동 */

@media (prefers-reduced-motion: reduce) {
  .tl-block, .today-canvas-now { transition: none; }
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/components/TodayView.css
git commit -m "polish(today): motion tokens with reduced-motion fallback (PR 7/7)"
```

---

### Task 4: 접근성 — aria, focus, role

**Files:**
- Modify: 모든 today/ 컴포넌트

- [ ] **Step 1: 체크리스트 적용**

- `<button>`이 아닌 div에 onClick 없도록 — TimelineBlock, debt chip, tray row 전부 `<button type="button">`.
- TimelineBlock에 `aria-label="${title} ${hhmm}–${hhmm} (${calendar})"`.
- 트레이 row에 `role="listitem"`, 트레이 컨테이너 `role="list"`.
- 드래그 핸들에 `aria-grabbed` (dnd-kit가 자동 부여).
- 색상만으로 정보 전달 X — 루틴은 ↻ 아이콘으로도 구분.
- 헤더의 debt 칩 hover/focus 시 outline visible.

- [ ] **Step 2: 키보드 nav 스모크**

Tab으로 헤더 → 트레이 첫 항목 → 시간축 첫 블록 → popover 안 버튼 → 닫기 (Esc).

- [ ] **Step 3: 커밋**

```bash
git add src/components/today/
git commit -m "polish(today): a11y pass — aria-label, role, button semantics (PR 7/7)"
```

---

### Task 5: ADR 3건 작성

**Files:**
- Create: `docs/adr/00XX-card-as-truth-google-as-mirror.md`
- Create: `docs/adr/00YY-pending-writes-queue.md`
- Create: `docs/adr/00ZZ-dnd-kit-adoption.md`

다음 ADR 번호 확인:

```bash
ls docs/adr/ | tail -3
```

- [ ] **Step 1: ADR 1 — 카드 정본**

```md
# ADR — work-radar 카드 정본, Google Calendar는 mirror

- Date: 2026-05-28
- Status: accepted

## Context
Today×Timeline 머지 (spec 2026-05-28)에서 카드를 시간축에 배치하는 행위가
Google Calendar에 이벤트로 저장된다. 카드와 Google 이벤트 둘 다 변경 가능.
누가 정본인가?

## Decision
**카드(work-radar signal)가 정본, Google 이벤트는 mirror.**
- 카드의 `scheduled_at`/`scheduled_duration`이 truth.
- 변경 시 `pending_calendar_writes` 큐를 통해 Google에 PATCH/POST/DELETE.
- Google 쪽 변경은 polling으로 감지 후 카드에 last-write-wins로 반영.
- 큐에 우리 쪽 pending이 있으면 우리 값이 이김.

## Consequences
- (+) work-radar 고유 정보(quadrant, area, today_for_date)와 정합 보장.
- (+) sync 워커 한 곳에서 외부 호출 → INVARIANT (외부 호출 = Rust) 보존.
- (-) Google 쪽 동시 편집이 잦은 사용자에겐 변경 손실 가능 (현재 사용자 패턴상 무시 가능).
- 충돌 명시 토스트는 의도적 deferred — 실제 사용 신호 보고 결정.

## Alternatives rejected
- Google이 정본: work-radar 고유 정보 비정합 위험.
- 느슨한 link + 명시 충돌 토스트: 마찰 과다.
```

- [ ] **Step 2: ADR 2 — pending writes 큐**

```md
# ADR — Pending Calendar Writes 큐 + 800ms 디바운스

- Date: 2026-05-28
- Status: accepted

## Context
드래그 인터랙션은 짧은 시간에 다수의 시간 변경을 발생시킨다.
매번 Google PATCH를 보내면 (a) 네트워크 낭비 (b) Google rate limit 위험
(c) 사용자가 ctrl+z 같은 빠른 되돌리기를 할 때 어색.

## Decision
- 모든 외부 mutation은 SQLite `pending_calendar_writes` 큐에 UPSERT.
- UNIQUE(target_kind, target_id, kind)으로 같은 카드의 후속 변경은 머지.
- `next_attempt_at = now + 800ms`. 같은 row가 800ms 안에 다시 update되면 timer 리셋 → 마지막 1회만 전송.
- 실패는 backoff [1s, 3s, 9s] 3회. terminal failure는 `last_error` 보존 + `CalendarSyncFailed` emit.
- Cross-cal 변경은 `payload_json.staged=true`로 큐 행에 보관, 워커가 skip. UI "적용" 버튼으로 staged 플래그 제거.

## Consequences
- (+) INVARIANT bounded retry 보존.
- (+) 앱 종료/오프라인 시 큐 행 보존 → 재부팅 후 자동 재시도.
- (+) optimistic UI와 자연스럽게 결합 (캐시 패치 → 큐 → flush).
- (-) 동기화 지연이 항상 800ms+ — UX 차원에서 명시 communicate 필요.
```

- [ ] **Step 3: ADR 3 — @dnd-kit 도입**

```md
# ADR — @dnd-kit/core 도입 (기존 useListReorder와 공존)

- Date: 2026-05-28
- Status: accepted

## Context
보드는 자작 `useListReorder`로 리스트 정렬 드래그를 처리해왔다.
새 Today 시간축은 (a) 픽셀 좌표 기반 드롭 (b) 리사이즈 (c) 여러 드롭존 (트레이/캔버스/cross-cal)
가 필요해 자작으로 확장하기 부담이 크다.

## Decision
- `@dnd-kit/core` + `@dnd-kit/utilities` 도입.
- 사용 범위: `src/components/today/**`만.
- 보드(`useListReorder`)는 변경 없이 유지 — YAGNI.

## Consequences
- (+) 키보드 sensor + a11y 기본 제공.
- (+) 픽셀 + 그리드 스냅을 표준 API로 처리.
- (-) 두 가지 드래그 패턴이 코드베이스에 공존 → 미래에 보드도 마이그할지 결정 필요 (현재는 No).
```

- [ ] **Step 4: 커밋**

```bash
git add docs/adr/
git commit -m "docs(adr): card-as-truth, pending-writes-queue, dnd-kit (PR 7/7)"
```

---

### Task 6: area 문서 + area-map 라우팅

**Files:**
- Create: `docs/areas/today-timeline.md`
- Modify: `docs/areas/area-map.md`

- [ ] **Step 1: today-timeline.md 작성**

```md
---
status: live
owner: repo-maintainers
last_reviewed: 2026-05-28
source_of_truth_scope: Today 표면 (트레이 + 시간축), calendar_sync 워커, ATracker 분할
---

# Area — Today × Timeline

Today 표면은 캡처 보드와 별개의 **운영(실행) 표면**이다. 결정은 보드에서, 실행은 여기서.
이전의 별도 `/timeline` 라우트는 본 area로 흡수됐다.

## Invariants

- 시간축 배치 = 결정 레일 아님 (INVARIANT #1 무관). `quadrant`/`area`는 자동 확정 0.
- 카드가 정본, Google은 mirror. ADR `card-as-truth-google-as-mirror` 참조.
- 모든 외부 mutation은 `pending_calendar_writes` 큐 경유. 직접 Google fetch 호출 금지.
- 디바운스 800ms + backoff [1s, 3s, 9s] 3회. 무한 retry 금지.
- Cross-calendar 이동만 명시 Acceptance ("적용" 버튼). within-cal 시간 nudge는 사람 손 = 암묵 통과 (INVARIANT #7).

## File globs

- `src/components/today/**` — 컴포넌트
- `src/lib/timelineLayout.ts` · `todayBlocks.ts` · `calendarSync.ts` · `optimisticSchedule.ts` — 순수/IPC 헬퍼
- `src/lib/query/calendarSync.ts` — pending writes 쿼리
- `src-tauri/src/calendar/sync.rs` · `pending_store.rs` — 워커 + 큐
- `src-tauri/src/commands/calendar_sync.rs` — IPC

## ATracker 분할 알고리즘 (timelineLayout.ts)

순수함수. 입력 `TimedBlock[]` → 출력 `LayoutBox[]`. 절차:
1. 시작시간 정렬 → 클러스터링 (활성 max end <= next start이면 클러스터 종료).
2. 클러스터 내 그리디 컬럼 배정 (가장 왼쪽 빈 컬럼).
3. `clusterCols = max(col)+1`, `widthPct = 100/clusterCols`, `leftPct = col * widthPct`.

테스트는 6개 케이스(단일/순차/2겹/3겹/cluster boundary/all-day 제외) 필수.

## Sync 워커 호출 패턴

프런트는 **항상** `commands.stageCalendarWrite`만 호출. 직접 `commands.createCalendarEvent` 등을 호출하지 않는다 (디바운스/큐 우회 = invariant 위반).

## Esc/overlay-stack

EventPopover · CalendarPickerPopover는 shadcn Popover (radix) — 자동 등록.
드래그 중 Esc는 dnd-kit이 onDragEnd(over=null) 호출 → 코드 early return.
```

- [ ] **Step 2: area-map.md에 라우팅 행 추가**

```md
| N | **Today × Timeline** | `src/components/today/**`, `src/lib/{timelineLayout,todayBlocks,calendarSync,optimisticSchedule}.ts`, `src/lib/query/calendarSync.ts`, `src-tauri/src/calendar/{sync,pending_store}.rs`, `src-tauri/src/commands/calendar_sync.rs` | `AGENTS.md`, `docs/areas/today-timeline.md`, `docs/areas/ipc-conventions.md` (외부 호출 시), `DESIGN.md` (시각 토큰) | shadcn-migration | `pnpm vitest run timelineLayout todayBlocks optimisticSchedule`, `cargo test pending_store sync` |
```

- [ ] **Step 3: 커밋**

```bash
git add docs/areas/today-timeline.md docs/areas/area-map.md
git commit -m "docs(area): today-timeline area + map routing (PR 7/7)"
```

---

### Task 7: decisions.md 한 줄 + 통합 검증 + push

**Files:**
- Modify: `docs/decisions.md`

- [ ] **Step 1: 한 줄 추가**

```md
- 2026-05-28 — Today×Timeline 머지 (PR 1~7, spec 2026-05-28). Timeline 라우트 제거, 카드 정본 + Google mirror + 800ms 디바운스 큐 + ATracker 분할. ADR 3건.
```

- [ ] **Step 2: 풀체크 + push**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check
cd .. && pnpm typecheck && pnpm lint && pnpm vitest run
git add docs/decisions.md
git commit -m "docs(decisions): Today×Timeline merge landed (PR 7/7)"
git push origin dev
```

## 자체 검증

- ✅ Spec §3 반응형 3단계
- ✅ Spec §11 PR 7건 분할 완료
- ✅ Spec §12 ADR 3건
- ✅ Spec §13 area 문서 + area-map 라우팅
- ✅ INVARIANT 7개 모두 보존
