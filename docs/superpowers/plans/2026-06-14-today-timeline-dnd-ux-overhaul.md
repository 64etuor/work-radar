# Today × Timeline DnD / Time-block UX Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grabbing the timeline resize handles reliable at every block height and at adjacent boundaries (Phase 0, the reported bug), then raise move/placement/resize UX to calendar-grade across four follow-on phases.

**Architecture:** Approach A from the spec — enlarge the resize hitbox (8px floor), render a single bottom handle on short blocks so the body stays grabbable for move, de-conflict the abutting-block seam with a 1px inset, and move the wrap z-index from inline style into CSS so a hover/focus lift can win. No IPC, no schema changes.

**Tech Stack:** React + TypeScript, `@dnd-kit/core`, Vitest, Tauri (desktop WKWebView). Pure-CSS + one TS module for Phase 0.

**Spec:** `docs/superpowers/specs/2026-06-14-today-timeline-dnd-ux-overhaul-design.md`

**Scope (user-approved):** full overhaul · routine length = message-only (no migration) · snapping = modifier + magnetic · desktop-only (touch deferred). Tiny-block (20–27px) top-edge mouse-resize is intentionally deferred to Phase 3 keyboard (accepted tradeoff).

**Commit/verify norms (repo):** Conventional Commits; `export PATH="$HOME/.cargo/bin:$PATH"` before any `git commit` (husky runs cargo fmt) and before any `cargo`. Push to `dev` only on explicit user request — this plan never pushes. Each phase = one PR = one concern. Live GUI smoke is user/cmux (the agent cannot drive the native WKWebView). A separate reviewer/critic pass approves each phase — never self-approve.

---

## File Structure (Phase 0)

- **Modify** `src/components/today/timelineBlockStyle.ts` — replace `resizeHandleHeightPx` with a steady 8px hitbox; add `TWO_HANDLE_MIN_PX` + `showTopHandle()`; drop the inline `zIndex` from `timelineBlockPlacementStyle`.
- **Modify** `src/components/today/TimelineBlock.tsx` — call `resizeHandleHeightPx()` with no arg; render the `edge="top"` handle only when `showTopHandle(heightPx)`.
- **Modify** `src/components/TodayView.css` — base wrap `z-index` into CSS + `[data-dragging]` lift + `:hover/:focus-within` lift; 1px seam inset on top/bottom handles; drop `scale(1.02)` from `.tl-block:active` (shadow-only press).
- **Modify (tests)** `src/components/today/TimelineBlock.test.ts` — rewrite the `resizeHandleHeightPx` block (old assertions `20→3, 30→5` WILL fail by design); add a `showTopHandle` block.

---

## Phase 0 — Handle reliability (the bug)

### Task 1: Steady 8px hitbox + single-handle threshold (pure functions, TDD)

**Files:**

- Modify: `src/components/today/timelineBlockStyle.ts`
- Test: `src/components/today/TimelineBlock.test.ts:52-69` (rewrite the `resizeHandleHeightPx` describe block)

- [ ] **Step 1: Rewrite the failing tests**

Replace the entire `describe("resizeHandleHeightPx", …)` block (current lines 52-69) with:

```ts
describe("resizeHandleHeightPx", () => {
  it("returns a steady 8px hitbox (Bug fix 2026-06-14: the old 3px floor was ungrabbable)", () => {
    // timelineLayout floors block heights to MIN_BLOCK_PX=20; short blocks drop the TOP
    // handle (showTopHandle) instead of shrinking the band, so 8px never eats the move band.
    expect(resizeHandleHeightPx()).toBe(8);
  });
});

describe("showTopHandle", () => {
  it("renders both handles only when a usable move band fits (>=28px)", () => {
    expect(showTopHandle(28)).toBe(true);
    expect(showTopHandle(36)).toBe(true);
    expect(showTopHandle(60)).toBe(true);
  });

  it("drops the top handle on short blocks so the whole body stays grabbable for move", () => {
    // 8px handle + 8px handle + >=12px move band = 28px. Below that => single bottom handle.
    // timelineLayout floors heights to 20px, so 20..27px is the real single-handle range.
    expect(showTopHandle(27)).toBe(false);
    expect(showTopHandle(20)).toBe(false);
  });
});
```

Update the import on line 3 to pull in `showTopHandle`:

```ts
import {
  resizeHandleHeightPx,
  showTopHandle,
  timelineBlockPlacementStyle,
} from "./timelineBlockStyle";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/components/today/TimelineBlock.test.ts`
Expected: FAIL — `showTopHandle` is not exported (TS/import error) and/or `resizeHandleHeightPx()` arity mismatch.

- [ ] **Step 3: Implement the minimal change**

In `src/components/today/timelineBlockStyle.ts`, replace the current `resizeHandleHeightPx` (lines 9-11) with:

```ts
/** 리사이즈 핸들 hitbox 높이(px) — 항상 8px. 예전 3px 바닥은 마우스로 잡기 불가능했다(Bug, 2026-06-14).
 *  짧은 블록은 핸들을 줄이는 대신 `showTopHandle`로 상단 핸들을 떼서 move 밴드를 확보하므로,
 *  핸들 자체는 모든 높이에서 8px로 유지한다. */
export function resizeHandleHeightPx(): number {
  return 8;
}

/** 상/하 2-핸들을 렌더할 최소 블록 높이(px). 8px 핸들 2개(16px) + 최소 12px move 밴드 = 28px.
 *  그보다 짧으면(20–27px; timelineLayout이 20px로 floor) 하단 단일 핸들 + 전체 body=move. */
export const TWO_HANDLE_MIN_PX = 28;

/** 짧은 블록(<28px)은 상단 핸들을 떼고 전체 body를 move로 둔다 — 8px×2가 move 밴드를 0으로 만들기 때문. */
export function showTopHandle(heightPx: number): boolean {
  return heightPx >= TWO_HANDLE_MIN_PX;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/components/today/TimelineBlock.test.ts`
Expected: PASS (both `resizeHandleHeightPx` and `showTopHandle` describes green). The `timelineBlockPlacementStyle` describe stays green (unchanged).

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/components/today/timelineBlockStyle.ts src/components/today/TimelineBlock.test.ts
git commit -m "fix(today): steady 8px resize hitbox + short-block single-handle threshold"
```

---

### Task 2: Wire TimelineBlock to the new hitbox + conditional top handle

**Files:**

- Modify: `src/components/today/TimelineBlock.tsx` (import line ~5-8; `--tl-resize-h` injection line ~230; handle render lines 283-284)

- [ ] **Step 1: Update the import**

Change the import from `timelineBlockStyle` (currently lines 5-8) to add `showTopHandle`:

```tsx
import {
  resizeHandleHeightPx,
  showTopHandle,
  timelineBlockPlacementStyle,
} from "@/components/today/timelineBlockStyle";
```

- [ ] **Step 2: Update the CSS var injection (no-arg call)**

In the wrap `style` object, change the `--tl-resize-h` line (currently `` `${resizeHandleHeightPx(heightPx)}px` ``, ~line 230) to:

```tsx
          // 높이별 리사이즈 핸들 hitbox(CSS var) — 이제 상수 8px(Bug fix 2026-06-14). 짧은 블록은
          // showTopHandle로 상단 핸들을 떼서 move 밴드를 확보한다.
          "--tl-resize-h": `${resizeHandleHeightPx()}px`,
```

- [ ] **Step 3: Make the top handle conditional**

Replace the two handle lines (currently 283-284):

```tsx
      <ResizeHandle edge="top" box={box} durationMin={durationMin} />
      <ResizeHandle edge="bottom" box={box} durationMin={durationMin} />
```

with the following (the `<>…</>` fragment is only to show valid JSX context — paste the two inner
lines in place of the originals; do **not** add an actual fragment wrapper):

```tsx
<>
  {/* 짧은 블록(<28px)은 상단 핸들 생략 — 전체 body가 move로 잡혀야 하기 때문(Bug fix 2026-06-14).
      상단 시각 조정은 Phase 3 키보드로 보완. 하단 핸들은 항상 렌더. */}
  {showTopHandle(heightPx) && <ResizeHandle edge="top" box={box} durationMin={durationMin} />}
  <ResizeHandle edge="bottom" box={box} durationMin={durationMin} />
</>;
```

(`heightPx` is already destructured from `box` at line 172.)

- [ ] **Step 4: Verify no other call site passed an arg to `resizeHandleHeightPx`**

Run: `grep -rn "resizeHandleHeightPx" src`
Expected: only `timelineBlockStyle.ts` (definition), `TimelineBlock.tsx` (no-arg call), and `TimelineBlock.test.ts` (no-arg call). If any other call passes `(heightPx)`, update it to `()`.

- [ ] **Step 5: Typecheck + tests**

Run: `pnpm typecheck && pnpm vitest run src/components/today/TimelineBlock.test.ts`
Expected: PASS, zero type errors.

- [ ] **Step 6: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/components/today/TimelineBlock.tsx
git commit -m "fix(today): drop top resize handle on short blocks, body stays move-grabbable"
```

---

### Task 3: CSS — z-index migration, seam inset, shadow-only press

**Files:**

- Modify: `src/components/today/timelineBlockStyle.ts` (`timelineBlockPlacementStyle`, drop inline `zIndex`)
- Modify: `src/components/TodayView.css` (`.tl-block-wrap` z-index, `[data-dragging]`, new hover/focus rule, `.tl-block-resize-top/bottom` inset, `.tl-block:active`)

- [ ] **Step 1: Drop the inline z-index from `timelineBlockPlacementStyle`**

In `src/components/today/timelineBlockStyle.ts`, remove the `zIndex` line from the returned object (currently `zIndex: dragging ? 10 : 2,`). The `dragging` param stays (still used for `opacity`). The base/hover/dragging z-index now lives in CSS so a stylesheet `:hover` rule can win (an inline z-index would always beat it).

The returned object becomes (z-index line gone):

```ts
return {
  position: "absolute",
  top: `${topPx}px`,
  height: `${heightPx}px`,
  left: `${leftPct}%`,
  width: `calc(${widthPct}% - 4px)`,
  opacity: dragging ? 0.4 : 1,
  transition: disableLayoutTransition ? "none" : undefined,
  willChange: disableLayoutTransition ? "auto" : undefined,
  transform: translate ? `translate3d(${translate.x}px, ${translate.y}px, 0)` : undefined,
};
```

- [ ] **Step 2: Verify the placement-style tests still pass (they don't assert zIndex)**

Run: `pnpm vitest run src/components/today/TimelineBlock.test.ts`
Expected: PASS — the `timelineBlockPlacementStyle` tests assert `left`/`width`/`transform`/`height`/`transition`/`willChange` only, never `zIndex`.

- [ ] **Step 3: Add base + dragging + hover/focus z-index in CSS**

In `src/components/TodayView.css`, the `.tl-block-wrap` rule (currently ~548-555) gains `z-index: 2;`:

```css
.tl-block-wrap {
  z-index: 2; /* 기본 — 인라인에서 CSS로 이전(2026-06-14)해 :hover lift가 인라인 스타일을 이길 수 있게. */
  transition:
    left var(--wr-motion-base, 220ms) var(--wr-ease-out, cubic-bezier(0.2, 0, 0, 1)),
    width var(--wr-motion-base, 220ms) var(--wr-ease-out, cubic-bezier(0.2, 0, 0, 1)),
    top var(--wr-motion-base, 220ms) var(--wr-ease-out, cubic-bezier(0.2, 0, 0, 1)),
    height var(--wr-motion-base, 220ms) var(--wr-ease-out, cubic-bezier(0.2, 0, 0, 1));
  will-change: left, width, top, height;
}
```

The `.tl-block-wrap[data-dragging]` rule (currently ~557-559) gains the dragging lift:

```css
.tl-block-wrap[data-dragging] {
  z-index: 10; /* 드래그 중 다른 블록 위로(인라인 zIndex:10에서 이전). */
  transition: none;
}
```

Add a new rule immediately after it:

```css
/*
 * 호버/포커스 시 블록을 이웃 위로 살짝 띄운다(z 6 > 이웃 2). 핸들 band 자체는 가려지지 않지만
 * (스펙 §3.1) abutting 블록의 1px seam + scale 잔여 sub-pixel 경합을 굳힌다.
 * ⚠ 반드시 아래 seam inset(.tl-block-resize-top/bottom의 1px)과 함께 적용 — lift만 적용하면
 * 띄워진 위 블록 body가 아래 블록의 상단 핸들을 seam에서 덮어 역-occlusion이 생긴다(스펙 §3.2 coupling).
 */
.tl-block-wrap:hover,
.tl-block-wrap:focus-within {
  z-index: 6;
}
```

- [ ] **Step 4: Inset the handles 1px off the abutting seam**

Change `.tl-block-resize-top` (currently `top: 0; bottom: auto;`, ~733-736) and `.tl-block-resize-bottom` (currently `top: auto; bottom: 0;`, ~738-741):

```css
.tl-block-resize-top {
  top: 1px; /* seam inset — abutting 위 블록의 하단 핸들과 정확한 경계행을 공유하지 않게(스펙 §3.2). */
  bottom: auto;
}

.tl-block-resize-bottom {
  top: auto;
  bottom: 1px; /* seam inset — abutting 아래 블록의 상단 핸들과 경계행 공유 회피. */
}
```

- [ ] **Step 5: Make the press feedback shadow-only (drop scale)**

Change `.tl-block:active` (currently ~596-600) to remove `transform: scale(1.02);`:

```css
.tl-block:active {
  cursor: grabbing;
  /* scale(1.02) 제거(2026-06-14) — 누르는 순간 아래로 0.4–1px 자라 핸들 정밀도를 떨어뜨렸다(스펙 §1.1.3). */
  box-shadow: var(--wr-shadow-sm);
}
```

- [ ] **Step 6: Typecheck + full front-end gate**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: PASS — zero type errors, lint clean (0 errors; 2 known baseline warnings allowed per repo), all vitest green.

- [ ] **Step 7: Commit**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add src/components/today/timelineBlockStyle.ts src/components/TodayView.css
git commit -m "fix(today): hover z-lift + 1px handle seam inset + shadow-only press"
```

---

### Task 4: Phase 0 verification + reviewer pass

- [ ] **Step 1: Run the full front-end gate one more time**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: all green. Capture the output as evidence (checkbox = observed result, not prose).

- [ ] **Step 2: Confirm bindings did not drift (no IPC changed, but verify)**

Run: `git status --porcelain src/bindings.ts`
Expected: empty (Phase 0 touches no IPC). If `bindings.ts` shows changes, something unintended happened — stop and investigate.

- [ ] **Step 3: Separate reviewer pass (no self-approve)**

Dispatch `oh-my-claudecode:critic` (or codex after `codex login`) read-only on the Phase 0 diff (`git diff main...HEAD -- src/components/today src/components/TodayView.css`). Require it to verify: (a) no handle extends past the block border (8px + 1px inset = 9px ≤ 20px min body); (b) the z-lift and seam inset shipped together; (c) the `:active` scale is fully removed; (d) no reverse-occlusion reasoning gap. Fold any BLOCKER/MAJOR before declaring done.

- [ ] **Step 4: Live grab-smoke (USER / cmux — agent cannot run the WKWebView)**

Hand the build to the user with this checklist (record results; do NOT claim "passed" from the agent side):

- (a) Grab the visible grip pixel of a block stacked directly above another → a **resize of the upper block** starts, not a move of the lower.
- (b) A 15-min (20px) block is movable by its body and resizable by its single bottom handle; no top handle is present.
- (c) Grabbing near the **top edge of the lower** abutting block does not trigger the upper block's resize (no reverse conflict).
- (d) Normal/tall blocks resize from both top and bottom as before.
- (e) Pressing a block shows shadow feedback with no visible scale jump.

- [ ] **Step 5: Update the breadcrumb**

Add one line to `docs/decisions.md` recording the Phase 0 handle-reliability fix and the accepted tiny-block top-resize tradeoff. Commit:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add docs/decisions.md
git commit -m "docs(today): record Phase 0 DnD handle-reliability decision"
```

---

## Phases 1–4 — Roadmap (each expands into its own plan + PR)

Each phase below is a separate concern/PR. When a phase becomes the active target, run `superpowers:writing-plans` against the matching spec section to expand it into full bite-sized TDD tasks informed by the state after the prior phase lands. The task seeds here are concrete enough to start from; they are intentionally not yet expanded to per-step code because they touch behavior that benefits from re-reading the code after Phase 0.

### Phase 1 — Drag/resize feel (spec §4 Phase 1)

- **Overlap-conflict tint:** derive a "would overlap" boolean from `computeLayout` cluster size; apply a preview-only CSS class. Files: `src/components/today/timelinePreview.ts`, `TimelineCanvas.tsx`, `TodayView.css`. Tests: `timelinePreview.test.ts`.
- **Duration pill:** floating `HH:MM–HH:MM · 1h15m` on the active resize edge; start-time on move. Files: `TimelineCanvas.tsx` (guide render ~218-268), CSS.
- **Suppress redundant ghost:** no `DragOverlay` ghost for `from:"canvas"`/`"canvas-resize"` (preview is authoritative); keep for tray/routine. Files: `TodayView.tsx:375-377`.
- **Outside-grid release:** thread pointer-at-release (from `pointerClientRef` + fresh grid rect, available in `onDragEnd`) into `normalizeDropDataForDragEnd` so "over grid → re-resolve from pointer" vs "off grid → snap back + toast" are distinguishable (today it commits lost-droppable to `gridY:0` = grid top). Files: `useTimelineDnd.ts:150-160, 475`. Tests: `useTimelineDnd.test.ts`.

### Phase 2 — Snapping model (spec §4 Phase 2)

- Parameterize `snap` in `timelineCoords.ts` (default 15); Alt/Option = 5-min fine snap read from `ev.activatorEvent`; magnetic edge-snap to adjacent block start/end within ~6px (candidate edges from rendered boxes, nearest wins over grid). Files: `timelineCoords.ts`, `timelinePreview.ts`, `useTimelineDnd.ts`. Tests: snap-priority (magnetic > grid within threshold), cross-midnight parity, routine-clamp parity in `timelineCoords.test.ts` / `timelinePreview.test.ts`.

### Phase 3 — Keyboard / a11y (spec §4 Phase 3; closes documented v2 gap)

- Custom `coordinateGetter` for 15-min keyboard steps (Shift = 1h); **top-edge keyboard resize for sub-28px blocks** (closes the Phase 0 accepted gap); visible focus ring on handles + `aria-keyshortcuts`; live-region time announcements. Files: `TimelineBlock.tsx`, `useTimelineDnd.ts`, CSS. Update `docs/areas/today-timeline.md` to retire the v2 keyboard items. Tests: keyboard step math + announcement wiring.

### Phase 4 — Failure & edge UX (spec §4 Phase 4)

- Unify all stage-IPC failures → toast + rollback (schedule/reschedule/resize/moveCalendar/routineSchedule), matching the existing cross-calendar path. Routine midnight-clamp affordance (cursor/tick cue before the silent stick). Routine fixed-length tooltip (message-only decision). Files: `useTimelineDnd.ts:360-639`. Tests: failure-path rollback assertions in `useTimelineDnd.test.ts`.

---

## Self-Review (plan vs spec)

- **Spec coverage:** §1.1 bug causes A/2/3 → Phase 0 Tasks 1–3 (hitbox, single-handle, seam inset, z-lift, shadow-only). §1.2 UX gaps → Phases 1–4 roadmap (each gap mapped). §3.1/§3.2 architecture → Phase 0 tasks. §4 phases → Phase 0 full + Phases 1–4 roadmap. §5 invariants → commit/verify norms + Task 4 (no-IPC check, separate reviewer, live-smoke-is-user, push policy). ✓
- **Placeholder scan:** Phase 0 steps contain exact code + exact commands + expected output. Phases 1–4 are explicitly a roadmap (separate PRs), not placeholder tasks within an active phase. ✓
- **Type/name consistency:** `resizeHandleHeightPx()` (no arg), `showTopHandle(heightPx)`, `TWO_HANDLE_MIN_PX`, `timelineBlockPlacementStyle` used identically across Tasks 1–3 and the test file. ✓
