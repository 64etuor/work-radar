# DnD Overhaul — Phase 3 (Keyboard / a11y) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **Do NOT commit inside subagents** — the loop runbook commits ONCE per phase after a full gate + separate critic. Touch ONLY the files named per task; never touch `governance/`.

**Goal:** Close the documented keyboard/a11y v2 gap on the Today timeline: a custom `coordinateGetter` for 15-min keyboard steps (Shift = 1h), a visible focus ring + `aria-keyshortcuts` on blocks and resize handles, and a polite live-region announcing the new time during keyboard move/resize. Plus the render-level test deferred from Phase 0 (both resize handles render).

**Architecture:** The keyboard step math is a pure `timelineKeyboardCoordinates` (`KeyboardCoordinateGetter`) wired into the existing `KeyboardSensor`; arrow deltas (15px=15min, Shift=60px) flow through the same snap/commit path as pointer drags (Phase 2). The announcement reuses `activeDragLabel` (Phase 1) to format the snapped time, updated only on keyboard drags. The deferred handle-render test uses the repo's happy-dom + `react-dom/client` DOM-test pattern (no RTL).

**Tech Stack:** React 19, `@dnd-kit/core` 6.3.1, Vitest (node + per-file `happy-dom`). **Invariants:** no IPC/schema/migration; local-ISO only; design tokens only; @dnd-kit in `today/**`; smallest change. Spec §4 Phase 3.

**Key facts:** 1px = 1min. Pointer-drag off-grid snapback (Phase 1) already excludes keyboard drags (`release=undefined`). KeyboardSensor handles Space/Enter (pick up/drop) and Esc (cancel) itself — the coordinateGetter only maps arrow keys to coordinate deltas.

---

## Task A: Keyboard coordinateGetter (15-min steps, Shift=1h) + sensor wiring

**Files:**

- Modify: `src/components/today/useTimelineDnd.ts`
- Test: `src/components/today/useTimelineDnd.test.ts`

- [ ] **Step 1: Failing test.** Add `timelineKeyboardCoordinates` to the import from `./useTimelineDnd`. Append:

```ts
describe("timelineKeyboardCoordinates", () => {
  const call = (code: string, shiftKey: boolean, y: number) =>
    timelineKeyboardCoordinates(
      { code, shiftKey, preventDefault() {} } as unknown as KeyboardEvent,
      { currentCoordinates: { x: 10, y } } as never,
    );

  it("steps 15px (15 min) per ArrowDown/ArrowUp", () => {
    expect(call("ArrowDown", false, 100)).toEqual({ x: 10, y: 115 });
    expect(call("ArrowUp", false, 100)).toEqual({ x: 10, y: 85 });
  });

  it("steps 60px (1h) with Shift", () => {
    expect(call("ArrowDown", true, 100)).toEqual({ x: 10, y: 160 });
    expect(call("ArrowUp", true, 100)).toEqual({ x: 10, y: 40 });
  });

  it("ignores horizontal arrows (vertical timeline)", () => {
    expect(call("ArrowLeft", false, 100)).toBeUndefined();
    expect(call("ArrowRight", false, 100)).toBeUndefined();
  });
});
```

Add `import type { KeyboardEvent } from ...`? No — `KeyboardEvent` is a global DOM type; just reference it. (The test file is node-env but only uses the type at compile time and a plain object at runtime.)

- [ ] **Step 2: Run, FAIL.** `pnpm vitest run useTimelineDnd`.

- [ ] **Step 3: Implement.** In `src/components/today/useTimelineDnd.ts`, add `KeyboardCoordinateGetter` to the `@dnd-kit/core` import. Add the getter near `useTodayDndSensors`:

```ts
/**
 * 키보드 드래그 좌표 스텝 — 세로 타임라인이라 ArrowUp/Down만 처리(1px=1min): 기본 15분, Shift=1h.
 * 좌우 화살표는 무시(undefined → dnd-kit 무이동). Space/Enter(집기/놓기)·Esc(취소)는 KeyboardSensor가 처리.
 */
export const timelineKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates },
) => {
  const step = event.shiftKey ? 60 : 15;
  if (event.code === "ArrowDown") {
    event.preventDefault();
    return { ...currentCoordinates, y: currentCoordinates.y + step };
  }
  if (event.code === "ArrowUp") {
    event.preventDefault();
    return { ...currentCoordinates, y: currentCoordinates.y - step };
  }
  return undefined;
};
```

Wire it into the existing `useTodayDndSensors` KeyboardSensor:

```ts
    useSensor(KeyboardSensor, { coordinateGetter: timelineKeyboardCoordinates }),
```

- [ ] **Step 4: Run, PASS.** `pnpm vitest run useTimelineDnd && pnpm typecheck`.

---

## Task B: a11y attributes + focus ring + live-region announcement

**Files:**

- Modify: `src/components/today/TimelineBlock.tsx` (aria-keyshortcuts on block + handles)
- Modify: `src/components/TodayView.css` (visible focus ring on handles/block)
- Modify: `src/components/TodayView.tsx` (sr-only live region; announce on keyboard drag)

- [ ] **Step 1: aria-keyshortcuts in TimelineBlock.** In `ResizeHandle`'s returned `<div>`, add `aria-keyshortcuts="ArrowUp ArrowDown Shift+ArrowUp Shift+ArrowDown"`. On the block `<button>`, add the same `aria-keyshortcuts`. (These are supplementary to dnd-kit's `attributes`; place them before `{...attributes}`/`{...listeners}` so the spread can't override — though they don't collide.)

- [ ] **Step 2: Focus-ring CSS.** In `src/components/TodayView.css`, add (tokens only) near the existing handle rules:

```css
/* 키보드 포커스 — 6px 핸들도 분명히 보이게(focus indicator v2 gap 해소, Phase 3). */
.tl-block-resize:focus-visible {
  outline: 2px solid var(--color-today-signal);
  outline-offset: 1px;
  background: color-mix(in srgb, var(--color-today-signal) 45%, transparent);
  z-index: 7;
}
.tl-block:focus-visible {
  outline: 2px solid var(--color-today-signal);
  outline-offset: 1px;
}
```

(If a `.tl-block:focus-visible` rule already exists, merge rather than duplicate — keep the stronger outline.)

- [ ] **Step 3: Live-region in TodayView.** Add `activeDragLabel` to the existing import from `@/components/today/timelinePreview` (currently `clientPointToGridGuide`). Add state near the other drag state: `const [announce, setAnnounce] = useState("");`. In `handleDragMove`, after the existing `dispatchDragGhost(...)` line, append:

```tsx
// 키보드 드래그만 라이브 리전으로 새 시각을 알린다(포인터 드래그는 pill이 시각 피드백).
if (ev.activatorEvent instanceof KeyboardEvent) {
  const label = activeDragLabel({
    boxes,
    activeDrag: activeDragStartRef.current,
    delta: ev.delta,
    anchorDate,
    days: visibleDates.length,
  });
  if (label) {
    setAnnounce(
      label.kind === "resize"
        ? `${label.startHHMM}부터 ${label.endHHMM}까지, ${label.durationLabel}`
        : `${label.startHHMM}로 이동`,
    );
  }
}
```

In `handleDragEndWithReset` (after `await onDragEnd(...)`) and `handleDragCancel`, add `setAnnounce("");`. Render the region just inside the `<div className="today" …>` (first child):

```tsx
<div className="sr-only" role="status" aria-live="polite">
  {announce}
</div>
```

- [ ] **Step 4: Gate.** `pnpm typecheck && pnpm lint && node scripts/check-frontend-ownership.mjs`. TodayView must stay under 420 lines (it is ~400 after the Phase-2 DragGhost extraction; this adds ~8 lines → ~408). If it would exceed 420, STOP and report (do not extract anything without instruction).

---

## Task C: Render-level test — both resize handles render (deferred from Phase 0)

**Files:**

- Create: `src/components/today/TimelineBlock.dom.test.tsx`

Uses the repo DOM-test pattern (happy-dom + `react-dom/client`, no RTL). TimelineBlock uses `useDraggable`, so wrap it in a `<DndContext>`.

- [ ] **Step 1: Write the test.**

```tsx
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DndContext } from "@dnd-kit/core";

import { TimelineBlock } from "./TimelineBlock";
import type { LayoutBox } from "@/lib/timelineLayout";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function box(): LayoutBox {
  return {
    id: "signal:s1",
    topPx: 540,
    heightPx: 60,
    leftPct: 0,
    widthPct: 100,
    block: {
      id: "signal:s1",
      kind: "signal",
      title: "Test",
      startISO: "2026-05-28T09:00:00+09:00",
      endISO: "2026-05-28T10:00:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      signalId: "s1",
    },
  };
}

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container!;
}

describe("TimelineBlock keyboard/a11y", () => {
  it("renders both resize handles (top + bottom) on every block", () => {
    const el = render(
      <DndContext>
        <TimelineBlock box={box()} onClick={() => {}} />
      </DndContext>,
    );
    expect(el.querySelectorAll(".tl-block-resize").length).toBe(2);
    expect(el.querySelector(".tl-block-resize-top")).not.toBeNull();
    expect(el.querySelector(".tl-block-resize-bottom")).not.toBeNull();
  });

  it("exposes aria-keyshortcuts on the block and handles", () => {
    const el = render(
      <DndContext>
        <TimelineBlock box={box()} onClick={() => {}} />
      </DndContext>,
    );
    expect(el.querySelector(".tl-block")?.getAttribute("aria-keyshortcuts")).toContain("ArrowUp");
    expect(
      el.querySelector(".tl-block-resize-bottom")?.getAttribute("aria-keyshortcuts"),
    ).toContain("ArrowDown");
  });
});
```

- [ ] **Step 2: Run, PASS.** `pnpm vitest run TimelineBlock` (and confirm full `pnpm vitest run` still green). If `happy-dom` import or `createRoot` errors, report the exact error (do not add new deps without instruction — happy-dom is already used by `RoutinesPanel.dom.test.tsx`).

---

## Phase gate (after Tasks A–C)

```bash
pnpm typecheck && pnpm lint && node scripts/check-frontend-ownership.mjs && pnpm vitest run && git status --porcelain src/bindings.ts
```

Expect typecheck 0, lint 0 err, ownership pass, all vitest green, bindings drift empty.

## Docs (controller does directly): retire v2 keyboard items

In `docs/areas/today-timeline.md` "v2 follow-ups", retire the two now-implemented bullets ("키보드 only 블록 이동" and "키보드 only 블록 resize") — replace with a one-line "implemented in Phase 3 (2026-06-14): 15-min arrow steps, Shift=1h, focus ring + aria-keyshortcuts, live-region" note.

## Self-review checklist

- **Spec coverage:** coordinateGetter 15-min/Shift=1h (A) · focus ring + aria-keyshortcuts (B) · live-region (B) · render-level both-handles test (C) · v2-doc retire (docs).
- **Keyboard path reuses Phase 2 snapping:** arrow deltas (15px) flow through `onDragEnd` → `snapAbsMin` (snapMin 15, magnet edges) exactly like pointer drags; off-grid snapback already excludes keyboard.
- **Invariants:** no IPC/schema; tokens only; @dnd-kit in `today/**`; TodayView stays < 420 lines.
- **a11y smoke (user):** Tab → block → Space → ↑/↓ moves in 15-min steps (Shift = 1h) → Space drops; Tab to a handle → Space → ↑/↓ resizes; Esc cancels; SR announces the new time.
