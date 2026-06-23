# Timeline DnD — Single Planner + Hit-Geometry Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** End the recurring Today-timeline drag/resize bug class (resize freeze, handle grab-position offset, delta drift, crosshair/short-block misfire) by (P5) deriving handle hit-rects from the semantic time edge instead of the floored/clamped visual box, and (P4) making @dnd-kit's `ev.delta` the single authoritative operation delta consumed by one `planTimelineDrag` that both preview and commit call.

**Architecture:** Spec `docs/superpowers/specs/2026-06-20-today-timeline-coordinate-time-ssot-design.md` §3.3/§3.4, design-reviewed independently by Codex (converged). Root cause (confirmed by runtime instrumentation + code): a hand-rolled pointer/coordinate/hit layer (`useTimelinePointerDelta` raw-window-pointer delta + handles rendered inside the floored visual box) drifts from dnd-kit's authoritative delta and from the semantic time edge. Fix collapses the dual tracking: one geometry contract (`LayoutBox.{semantic,visual,hit}`), one operation delta (`ev.delta`), one planner.

**Tech Stack:** TypeScript, React, @dnd-kit/core, Vitest. Pure functions for layout/plan (no DOM, no Date.now).

## Global Constraints

- **INVARIANT #7:** local-offset ISO only; time math via `timeAxis` string slicing. No `.toISOString()`/`new Date(iso).getHours()` in positioning.
- **ADR-0004:** `@dnd-kit` imports confined to `src/components/today/**`. The new planner (`src/lib/timelineDragPlan.ts`) and `timelineLayout`/`timelineAxis` MUST NOT import @dnd-kit.
- **timelineAxis is the time↔pixel SSOT** (`HOUR_PX`/`DAY_PX`/`SNAP_MIN`/`MIN_PER_DAY`/`totalPxForDays`/`clientToGrid`). No new local pixel constants (guarded by `check:timeline-axis`).
- **preview == commit:** the same `planTimelineDrag` output drives both; `useTimelineDnd` stages `plan.commit` and MUST NOT call `shiftIsoByPx`/`resizeIsoByPx` directly (lint-enforced).
- **Behavior parity except the bugs:** resize/move/snap/magnet/routine-occurrence-clamp/off-grid semantics unchanged; only the drift/freeze/handle-offset are fixed. Existing today suites must stay green.
- **Raw window pointer = display + release classification only**, never an operation (start/duration) delta source.
- **Axis frozen during drag:** lazy-extend/anchor changes must not alter `anchorDate` under an active drag (`useTimelineScroll`). Snapshot or pause extend on drag.
- **Verification:** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm vitest run` green (+ new suites), `pnpm check:timeline-axis` ok, `bindings.ts` drift 0 (no Rust). Live native WKWebView smoke = user.
- **Commits:** Conventional Commits; body ends `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push. Stage only each task's files; never `src-tauri/src/lib.rs` (unrelated WIP).

---

## File Structure

- **Modify** `src/lib/timelineLayout.ts` — `LayoutBox` → `{ id, block, semantic, visual, hit }`; `computeLayout` derives `semantic` from `absMin`, `visual` keeps `MIN_BLOCK_PX` floor + Bug-4 overlap clamp, `hit` derives handle/move rects from semantic edges (half-open).
- **Modify** `src/components/today/timelineBlockStyle.ts` — placement style reads `box.visual`; add hit-rect style helper.
- **Modify** `src/components/today/TimelineBlock.tsx` — card renders from `visual`; the two `ResizeHandle` draggables position from `box.hit.topHandle`/`bottomHandle` (not `bottom:0`/`top:0` of the visual wrapper).
- **Modify** `src/components/today/TimelineCanvas.tsx`, `timelinePreview.ts`, `useTimelineDnd.ts`, `useKeyboardDragAnnounce.ts`, `EventPopover.tsx`, `useTimelineScheduleActions.ts`, `timelineDragData.ts` — read `.visual.*`/`.semantic.*` instead of flat `.topPx` etc. (mechanical; each is a `LayoutBox` consumer).
- **Create** `src/lib/timelineDragPlan.ts` — `planTimelineDrag(input) -> { previewBoxes, guide, commit }` (no @dnd-kit import); owns resize/shift/snap/magnet/routine-clamp/off-grid rules ONCE.
- **Create** `src/components/today/resolveTimelineDragFrame.ts` — the ONE adapter turning `ev.delta` (+ scroll) into the operation delta; characterized by tests.
- **Modify** `eslint.config.*` — `no-restricted-imports` banning `shiftIsoByPx`/`resizeIsoByPx` outside `timelineDragPlan.ts` + tests.
- **Tests:** `timelineLayout.test.ts` (hit geometry), `timelineDragPlan.test.ts` (new), `timelinePreview.test.ts`/`useTimelineDnd.test.ts` (updated).

---

## PHASE 5 — Hit geometry (do FIRST; fixes the acute handle-offset, gives the planner a clean geometry contract)

### Task 5.1: Split `LayoutBox` into semantic/visual/hit in `computeLayout`

**Files:** Modify `src/lib/timelineLayout.ts`. Test: `src/lib/timelineLayout.test.ts`.

**Interfaces — Produces:**

```ts
export type TimelineHitRect = { topPx: number; heightPx: number };
export type LayoutBox = {
  id: string;
  block: TimedBlock;
  semantic: { startAbs: number; endAbs: number; durationMin: number }; // absolute minutes (== px since 1px==1min)
  visual: { topPx: number; heightPx: number; leftPct: number; widthPct: number };
  hit: {
    topHandle: TimelineHitRect;
    bottomHandle: TimelineHitRect;
    moveBand: TimelineHitRect | null;
  };
};
export const RESIZE_HANDLE_PX = 6; // single source; was resizeHandleHeightPx()
```

- [ ] **Step 1: Failing tests** — in `timelineLayout.test.ts`, assert for a 15-min block (floored to 20px visual) and for two abutting 15-min blocks (9:00-9:15, 9:15-9:30):
  - `semantic.startAbs/endAbs` equal `absMin(start/end)` (true time edges; 60/75/etc.).
  - `visual.heightPx === max(20, durationMin)` and the Bug-4 overlap clamp still caps `visual` only.
  - `hit.bottomHandle.topPx === semantic.endAbs - RESIZE_HANDLE_PX` (NOT `visual.topPx + visual.heightPx`).
  - `hit.topHandle.topPx === semantic.startAbs`.
  - adjacent blocks: `A.hit.bottomHandle` does not overlap `B.hit.topHandle` (half-open: A bottom handle ends at B start).
- [ ] **Step 2: Run, expect fail** — `pnpm vitest run src/lib/timelineLayout.test.ts` (type/field errors).
- [ ] **Step 3: Implement** — in `computeLayout`, after computing `startMin`/`endMin` per box, build:
  ```ts
  const semantic = { startAbs: startMin, endAbs: endMin, durationMin: endMin - startMin };
  const visual = {
    topPx: startMin,
    heightPx: Math.max(MIN_BLOCK_PX, endMin - startMin),
    leftPct,
    widthPct,
  };
  ```
  Keep the existing overlap-clamp loop but apply it to `box.visual.heightPx` only. Then derive hit from semantic:
  ```ts
  const topHandle = { topPx: semantic.startAbs, heightPx: RESIZE_HANDLE_PX };
  const bottomHandle = { topPx: semantic.endAbs - RESIZE_HANDLE_PX, heightPx: RESIZE_HANDLE_PX };
  const moveTop = topHandle.topPx + RESIZE_HANDLE_PX;
  const moveH = bottomHandle.topPx - moveTop;
  const moveBand = moveH > 0 ? { topPx: moveTop, heightPx: moveH } : null;
  ```
  (1px==1min so semantic minutes are px.) `magnetEdgesFromBoxes` reads `b.block.startISO/endISO` already — unaffected.
- [ ] **Step 4: Run, expect pass.** `pnpm vitest run src/lib/timelineLayout.test.ts`.
- [ ] **Step 5: Commit** (`refactor(today): LayoutBox semantic/visual/hit split in computeLayout`).

### Task 5.2: Migrate `LayoutBox` consumers to `.visual`/`.semantic`

**Files:** Modify (each reads the old flat fields): `timelineBlockStyle.ts`, `TimelineBlock.tsx`, `TimelineCanvas.tsx`, `timelinePreview.ts`, `useTimelineDnd.ts`, `useKeyboardDragAnnounce.ts`, `EventPopover.tsx`, `useTimelineScheduleActions.ts`, `timelineDragData.ts`. Test: existing today suites.

**Interfaces — Consumes:** `LayoutBox.visual.{topPx,heightPx,leftPct,widthPct}` (was flat), `LayoutBox.semantic` (for any code computing duration from topPx/heightPx — use `semantic.durationMin`).

- [ ] **Step 1: Confirm green baseline** — `pnpm vitest run src/components/today src/lib/timelineLayout.test.ts`.
- [ ] **Step 2: Mechanical migration** — for each file, replace `box.topPx`→`box.visual.topPx` etc. and destructures `const { topPx, heightPx, leftPct, widthPct } = box` → `const { topPx, heightPx, leftPct, widthPct } = box.visual`. Where code derived duration from `heightPx` (e.g. `timelinePreview` guide), switch to `box.semantic.durationMin`. (`timelineBlockPlacementStyle` arg stays `{topPx,heightPx,leftPct,widthPct}` — pass `box.visual`.) Let `pnpm typecheck` drive completeness (it flags every stale field).
- [ ] **Step 3: typecheck + suites** — `pnpm typecheck && pnpm vitest run src/components/today src/lib`. Behavior unchanged (visual == old flat fields).
- [ ] **Step 4: Commit** (`refactor(today): consume LayoutBox.visual/.semantic across timeline`).

### Task 5.3: Render resize handles from `box.hit` (the acute fix)

**Files:** Modify `TimelineBlock.tsx`, `timelineBlockStyle.ts`, `src/components/TodayView.css`. Test: `TimelineBlock.dom.test.tsx`.

**Interfaces — Consumes:** `box.hit.topHandle/bottomHandle`.

- [ ] **Step 1: Failing dom test** — extend `TimelineBlock.dom.test.tsx`: for a short (floored) block, the bottom `.tl-block-resize-bottom` element's inline `top` corresponds to `hit.bottomHandle.topPx - visual.topPx` (i.e. anchored to the SEMANTIC end, which for a floored block is ABOVE the visual bottom), not the visual wrapper bottom.
- [ ] **Step 2: Run, expect fail.**
- [ ] **Step 3: Implement** — `ResizeHandle` positions absolutely from `box.hit` relative to the wrap (e.g. `style={{ top: hit.topHandle.topPx - box.visual.topPx }}` for top, similarly bottom), via a `hitHandleStyle(box, edge)` helper in `timelineBlockStyle.ts`. Remove the CSS `bottom:0`/`top:0` anchoring (`TodayView.css:~768`) in favor of the computed top. Card (`<button>`) still fills `visual`. `RESIZE_HANDLE_PX` from timelineLayout replaces `resizeHandleHeightPx()`.
- [ ] **Step 4: Run, expect pass** + `pnpm vitest run src/components/today`.
- [ ] **Step 5: Commit** (`fix(today): resize handle hit-rect tracks semantic time edge (grab-position offset)`).

(After Phase 5: handles grab where they're drawn = the true time edge, regardless of MIN_BLOCK_PX floor / Bug-4 clamp. Live smoke = user.)

---

## PHASE 4 — Single planner + authoritative delta (fixes drift + freeze)

### Task 4.1: `resolveTimelineDragFrame` — the one operation-delta adapter

**Files:** Create `src/components/today/resolveTimelineDragFrame.ts` + test. **Produces:** `resolveTimelineDragFrame({ evDelta, gridRect, scrollTop, startScrollTop }) -> { y: number; x: number }` — dnd-kit `ev.delta` adjusted for scroll exactly once (identity if dnd-kit already scroll-adjusts — characterize with a test; else add `scrollTop - startScrollTop`). No raw-pointer.

- [ ] Tests: stale-raw-pointer scenario is irrelevant (not used); increasing `evDelta.y` always yields increasing frame.y; scroll delta applied once.
- [ ] Implement + commit (`feat(today): resolveTimelineDragFrame single operation-delta adapter`).

### Task 4.2: `planTimelineDrag` pure planner

**Files:** Create `src/lib/timelineDragPlan.ts` + `timelineDragPlan.test.ts`. **Produces:** `planTimelineDrag({ axis, boxes, activeDrag, delta, pointer?, drop?, snapOpts }) -> { previewBoxes: LayoutBox[]; guide: TimelineGuide | null; commit: TimelineCommit | null }`. Owns ONCE: resize (`resizeIsoByPx`), move (`shiftIsoByPx`), snap/magnet, routine-occurrence clamp (`clampIsoToDate`/`clampDurationToDate`), duration correction, off-grid classification. `commit` carries final `at`/`durationMin`/ids + `kind` (reschedule/eventReschedule/routineReschedule/resize/eventResize/routineResize/schedule/routineSchedule/unschedule/moveCalendar) — NOT a delta.

- [ ] Tests (port from current preview+commit so parity is locked): move preview==commit for signal/event/routine-backed; top-resize keeps end fixed + occurrence clamp once; bottom-resize snap/magnet once; off-grid → `commit:null`; keyboard (no pointer) path.
- [ ] Implement (lift logic from `timelinePreview.ts` + `useTimelineDnd.ts` resize/reschedule branches) + commit.

### Task 4.3: Switch preview to the planner

**Files:** `TimelineCanvas.tsx`, retire `previewTimelineBoxes`/`dragGuideFromLayout`/`activeDragLabel` internals to thin wrappers over `planTimelineDrag`. Tests: `timelinePreview.test.ts` updated. Commit.

### Task 4.4: Switch commit to the planner + drop custom operation delta

**Files:** `useTimelineDnd.ts` (onDragEnd stages `plan.commit` only; remove `resolveCanvasDragDelta`/`resizeIsoByPx`/`shiftIsoByPx` calls), `TodayView.tsx` (`handleDragMove` feeds `resolveTimelineDragFrame(ev.delta,...)`; `useTimelinePointerDelta` reduced to raw cursor + release classification only). Tests: `useTimelineDnd.test.ts` updated (commit equals planner output). Commit.

### Task 4.5: Enforce + freeze axis during drag

**Files:** `eslint.config.*` (`no-restricted-imports` ban `shiftIsoByPx`/`resizeIsoByPx` outside `timelineDragPlan.ts`+tests); `useTimelineScroll.ts` (pause lazy-extend / freeze anchor while a drag is active). Tests + commit.

---

## Done-Criteria (evidence)

- [ ] Resize handle grabs at the drawn (semantic) edge for floored/clamped/abutting blocks (P5).
- [ ] Resize no longer freezes mid-drag; block follows `ev.delta` 1:1 (no custom-delta drift) (P4).
- [ ] preview == commit; `useTimelineDnd` contains no `shiftIsoByPx`/`resizeIsoByPx` (lint-enforced).
- [ ] `pnpm typecheck`/`lint`/`vitest`/`check:timeline-axis` green; `bindings.ts` drift 0.
- [ ] Live native WKWebView smoke (resize short & abutting blocks, long resize past viewport, keyboard resize, routine midnight clamp) = user/cmux.

## Risks

- dnd-kit auto-scroll vs `ev.delta` scroll semantics — characterize once in `resolveTimelineDragFrame` tests; no caller compensates independently.
- Routine occurrence clamp must be owned solely by the planner (was duplicated preview/commit).
- KeyboardSensor path has no pointer — planner must accept delta-only input.
- DragOverlay still needs the window pointer for crosshair display only.
