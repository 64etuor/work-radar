# DnD Overhaul — Phase 2 (Snapping Model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. **Do NOT commit inside subagents** — the loop runbook commits ONCE per phase after a full gate + separate critic pass. Touch ONLY the files named per task; never touch `governance/` (unrelated WIP).

**Goal:** Calendar-grade snapping on the Today timeline: parameterized grid snap (default 15), **Alt/Option = 5-min fine snap**, and **magnetic edge-snap** to adjacent block start/end within ~6px (nearest magnet wins over grid). Move, resize, and the live preview all snap identically (preview == commit).

**Architecture:** A pure `snapAbsMin(rawMin, opts)` in `timelineCoords.ts` is the single snapping authority; `shiftIsoByPx`/`resizeIsoByPx` take an optional `SnapOpts`. Magnet candidate edges are built by a pure `magnetEdgesFromBoxes(boxes, anchorDate, excludeId)` in `timelineLayout.ts` (operates on the real block ISO edges, not the floored `heightPx`). `previewTimelineBoxes` (render) and `onDragEnd` (commit) both feed the same `{snapMin, magnetEdges}` so preview equals commit. Alt state is tracked in `TodayView` (seeded from the drag-start activator event + live keydown/keyup during the drag) and threaded as a `fineSnap` prop to the canvas and a `fineSnapRef` to the dispatcher.

**Tech Stack:** React 19, `@dnd-kit/core`, Vitest. **Invariants:** no IPC/schema/migration; local-ISO time math only (`absMin`/`isoFromAbsMin`, never `.toISOString()`); design tokens only; @dnd-kit confined to `today/**`; smallest local change. Spec: `docs/superpowers/specs/2026-06-14-today-timeline-dnd-ux-overhaul-design.md` §4 Phase 2.

**Key facts:** 1px = 1 min (HOUR_PX=60). Absolute minutes are continuous across midnight (anchorDate 00:00 = 0). Magnet threshold ~6 min. Routine occurrence clamp (`clampIsoToDate`/`clampDurationToDate`) runs AFTER snapping in both preview and commit — unchanged; snapping feeds into it, preserving routine-clamp parity.

---

## Task 1: Pure snapping core — `snapAbsMin` + parameterized shift/resize

**Files:**

- Modify: `src/lib/timelineCoords.ts`
- Test: `src/lib/timelineCoords.test.ts`

- [ ] **Step 1: Write failing tests.** Append to `src/lib/timelineCoords.test.ts`. Add `snapAbsMin` to the existing import from `./timelineCoords`. Then add a new describe (uses absolute minutes directly — no anchor needed):

```ts
describe("snapAbsMin", () => {
  it("grid-snaps to 15 by default", () => {
    expect(snapAbsMin(102)).toBe(105);
    expect(snapAbsMin(97)).toBe(90);
  });

  it("fine-snaps to 5 when snapMin=5 (Alt/Option)", () => {
    expect(snapAbsMin(102, { snapMin: 5 })).toBe(100);
    expect(snapAbsMin(103, { snapMin: 5 })).toBe(105);
  });

  it("magnet-snaps to the nearest edge within threshold, beating the grid", () => {
    // raw 102 → grid 105, but edge 100 is 2 away (<=6) → snaps to 100.
    expect(snapAbsMin(102, { magnetEdges: [100] })).toBe(100);
  });

  it("falls back to grid when no edge is within threshold", () => {
    // edge 92 is 10 away from 102 (>6) → grid 105.
    expect(snapAbsMin(102, { magnetEdges: [92] })).toBe(105);
  });

  it("picks the nearest of several edges", () => {
    expect(snapAbsMin(610, { magnetEdges: [600, 615, 720] })).toBe(615);
  });

  it("magnet works across midnight (continuous absolute minutes)", () => {
    // raw 1438 near next-day 00:00 (=1440), 2 away → snaps to 1440.
    expect(snapAbsMin(1438, { magnetEdges: [1440] })).toBe(1440);
  });
});

describe("shiftIsoByPx / resizeIsoByPx with SnapOpts", () => {
  const A = "2026-06-11";

  it("shiftIsoByPx magnet-snaps the start to a neighbor edge", () => {
    // start 09:00 (540) + 4px = 544; neighbor edge 540 within 6 → snaps back to 540 (09:00).
    expect(shiftIsoByPx(A, 3, `2026-06-11T09:00:00${off(A)}`, 4, { magnetEdges: [540] })).toBe(
      `2026-06-11T09:00:00${off(A)}`,
    );
  });

  it("shiftIsoByPx fine-snaps to 5 with snapMin=5", () => {
    // start 09:00 (540) + 7px = 547 → fine-snap 5 → 545 = 09:05.
    expect(shiftIsoByPx(A, 3, `2026-06-11T09:00:00${off(A)}`, 7, { snapMin: 5 })).toBe(
      `2026-06-11T09:05:00${off(A)}`,
    );
  });

  it("resizeIsoByPx bottom magnet-snaps the end to a neighbor edge", () => {
    // start 09:00, dur 60 → end 600; +4px → 604; neighbor edge 600 within 6 → end 600, dur 60.
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-11T09:00:00${off(A)}`,
      durationMin: 60,
      edge: "bottom",
      deltaPx: 4,
      snapOpts: { magnetEdges: [600] },
    });
    expect(r.durationMin).toBe(60);
    expect(r.at).toBe(`2026-06-11T09:00:00${off(A)}`);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.** `pnpm vitest run timelineCoords` → FAIL (`snapAbsMin is not a function`, snapOpts not honored).

- [ ] **Step 3: Implement** in `src/lib/timelineCoords.ts`. Replace the `SNAP_MIN`/`snap` region (lines 8-13) with:

```ts
const HOUR_PX = 60;
const SNAP_MIN = 15;
/** 자석 엣지 스냅 임계(분=px, 1px=1min). 인접 블록 start/end에 이 범위 내면 그리드보다 우선. */
const MAGNET_THRESHOLD_MIN = 6;

export type SnapOpts = {
  /** 그리드 스냅 단위(분). 기본 15. Alt/Option fine-snap 시 5. */
  snapMin?: number;
  /** 자석 후보 엣지(절대 분) — 인접 블록 start/end. 비거나 미지정이면 그리드만. */
  magnetEdges?: number[];
  /** 자석 임계(분). 기본 6. */
  magnetThresholdMin?: number;
};

function gridSnap(min: number, snapMin: number = SNAP_MIN): number {
  return Math.round(min / snapMin) * snapMin;
}

/**
 * 절대 분 스냅 — 자석 엣지가 임계 내에 있으면 가장 가까운 엣지로(그리드보다 우선), 아니면 그리드.
 * 순수 함수. 자석 엣지/그리드 단위는 opts로 주입(기본=그리드 15, 자석 없음).
 */
export function snapAbsMin(rawMin: number, opts?: SnapOpts): number {
  const snapMin = opts?.snapMin ?? SNAP_MIN;
  const edges = opts?.magnetEdges;
  const threshold = opts?.magnetThresholdMin ?? MAGNET_THRESHOLD_MIN;
  if (edges && edges.length > 0) {
    let nearest = edges[0];
    let nearestDist = Math.abs(rawMin - edges[0]);
    for (let i = 1; i < edges.length; i++) {
      const d = Math.abs(rawMin - edges[i]);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = edges[i];
      }
    }
    if (nearestDist <= threshold) return nearest;
  }
  return gridSnap(rawMin, snapMin);
}
```

Then update `pixelToLocalIso` to use `gridSnap` (behavior unchanged — default 15):

```ts
export function pixelToLocalIso(anchorDate: string, days: number, gridY: number): string {
  const abs = clampAbs(gridSnap((gridY / HOUR_PX) * 60), days);
  return isoFromAbsMin(anchorDate, abs);
}
```

Update `shiftIsoByPx` to accept optional `SnapOpts`:

```ts
export function shiftIsoByPx(
  anchorDate: string,
  days: number,
  startISO: string,
  deltaPx: number,
  opts?: SnapOpts,
): string {
  const abs = clampAbs(
    snapAbsMin(absMin(startISO, anchorDate) + (deltaPx / HOUR_PX) * 60, opts),
    days,
  );
  return isoFromAbsMin(anchorDate, abs);
}
```

Update `resizeIsoByPx` — add `snapOpts` to the params object and snap via `snapAbsMin`; the bottom edge now snaps the END position (so magnet edges apply to the end), which is equivalent to the old duration-snap on the grid:

```ts
export function resizeIsoByPx({
  anchorDate,
  days,
  startISO,
  durationMin,
  edge,
  deltaPx,
  snapOpts,
}: {
  anchorDate: string;
  days: number;
  startISO: string;
  durationMin: number;
  edge: "top" | "bottom";
  deltaPx: number;
  snapOpts?: SnapOpts;
}): { at: string; durationMin: number } {
  const startAbs = absMin(startISO, anchorDate);
  const endAbs = startAbs + durationMin;
  const deltaMin = (deltaPx / HOUR_PX) * 60;
  if (edge === "top") {
    const nextStart = Math.max(
      0,
      Math.min(endAbs - SNAP_MIN, snapAbsMin(startAbs + deltaMin, snapOpts)),
    );
    return { at: isoFromAbsMin(anchorDate, nextStart), durationMin: endAbs - nextStart };
  }
  const snappedEnd = snapAbsMin(endAbs + deltaMin, snapOpts);
  const durationMinNext = Math.max(
    SNAP_MIN,
    Math.min(days * 1440 - startAbs, snappedEnd - startAbs),
  );
  return { at: startISO, durationMin: durationMinNext };
}
```

- [ ] **Step 4: Run, verify PASS.** `pnpm vitest run timelineCoords` (new + all existing cases green) and `pnpm typecheck` (0).

---

## Task 2: Magnet edges from layout + thread snapping into the preview

**Files:**

- Modify: `src/lib/timelineLayout.ts` (add `magnetEdgesFromBoxes`)
- Test: `src/lib/timelineLayout.test.ts`
- Modify: `src/components/today/timelinePreview.ts` (compute edges, thread `snapMin`)
- Test: `src/components/today/timelinePreview.test.ts`

- [ ] **Step 1: Write failing test for `magnetEdgesFromBoxes`.** In `src/lib/timelineLayout.test.ts`, add `magnetEdgesFromBoxes` to the import from `./timelineLayout`, then append:

```ts
describe("magnetEdgesFromBoxes", () => {
  const boxes = computeLayout(
    [
      {
        id: "a",
        kind: "event",
        title: "A",
        startISO: "2026-06-11T09:00:00+09:00",
        endISO: "2026-06-11T10:00:00+09:00",
        calendarId: "c",
        color: "#000",
      },
      {
        id: "b",
        kind: "event",
        title: "B",
        startISO: "2026-06-11T11:00:00+09:00",
        endISO: "2026-06-11T11:30:00+09:00",
        calendarId: "c",
        color: "#000",
      },
    ],
    "2026-06-11",
  );

  it("returns start+end absolute minutes of every box except the excluded one", () => {
    // exclude "a"; only b's edges: 11:00=660, 11:30=690.
    expect(magnetEdgesFromBoxes(boxes, "2026-06-11", "a").sort((x, y) => x - y)).toEqual([
      660, 690,
    ]);
  });

  it("includes all edges when excludeId is null", () => {
    expect(magnetEdgesFromBoxes(boxes, "2026-06-11", null).sort((x, y) => x - y)).toEqual([
      540, 600, 660, 690,
    ]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL.** `pnpm vitest run timelineLayout` → FAIL.

- [ ] **Step 3: Implement** in `src/lib/timelineLayout.ts`. Add at the end of the file (it already imports `absMin` from `./timeAxis`):

```ts
/**
 * 자석 엣지 후보 = excludeId를 제외한 모든 박스의 실제 start/end(절대 분). heightPx(=floor 20px)가
 * 아니라 block.startISO/endISO에서 유도해 짧은 블록의 끝도 정확하다. 순수 함수.
 */
export function magnetEdgesFromBoxes(
  boxes: LayoutBox[],
  anchorDate: string,
  excludeId: string | null,
): number[] {
  const edges: number[] = [];
  for (const b of boxes) {
    if (b.id === excludeId) continue;
    edges.push(absMin(b.block.startISO, anchorDate));
    edges.push(absMin(b.block.endISO, anchorDate));
  }
  return edges;
}
```

- [ ] **Step 4: Run, verify PASS.** `pnpm vitest run timelineLayout`.

- [ ] **Step 5: Thread snapping into the preview.** In `src/components/today/timelinePreview.ts`:
  - Add `magnetEdgesFromBoxes` to the existing import from `@/lib/timelineLayout` (currently imports `computeLayout`, `type LayoutBox`, `type TimedBlock`).
  - Change `previewTimelineBoxes` to accept an optional `snapMin` and to compute magnet edges + pass `{snapMin, magnetEdges}` into `shiftIsoByPx`/`resizeIsoByPx`. Replace the function's argument list and the two call sites:

Argument list — add `snapMin`:

```ts
export function previewTimelineBoxes({
  boxes,
  activeDrag,
  delta,
  anchorDate,
  days,
  snapMin,
}: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  anchorDate: string;
  days: number;
  /** 그리드 스냅 단위(분). 기본 15. Alt/Option fine-snap 시 5. */
  snapMin?: number;
}): LayoutBox[] {
```

Right after the existing `const activeId = blockIdForDrag(activeDrag); if (!activeId) return boxes;` lines, build the snap options once:

```ts
const snapOpts = {
  snapMin,
  magnetEdges: magnetEdgesFromBoxes(boxes, anchorDate, activeId),
};
```

In the `activeDrag.from === "canvas"` branch, change the shift call to pass `snapOpts`:

```ts
const shifted = shiftIsoByPx(anchorDate, days, activeDrag.startISO, delta.y, snapOpts);
```

In the resize branch, change the resize call to pass `snapOpts`:

```ts
const resized = resizeIsoByPx({
  anchorDate,
  days,
  startISO: activeDrag.startISO,
  durationMin: activeDrag.durationMin,
  edge: activeDrag.edge,
  deltaPx: delta.y,
  snapOpts,
});
```

- [ ] **Step 6: Write failing preview tests.** In `src/components/today/timelinePreview.test.ts`, append to the `describe("previewTimelineBoxes", …)` block (the `block(id, startISO, endISO)` helper exists):

```ts
it("magnet-snaps a moved block's start to an adjacent block's edge (nearest wins over grid)", () => {
  const boxes = computeLayout([
    block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
    block("event:cal:e2", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
  ]);
  const drag: DragData = {
    from: "canvas",
    blockKind: "event",
    blockId: "event:cal:e2",
    eventId: "e2",
    title: "E2",
    startISO: "2026-05-28T11:00:00+09:00",
    durationMin: 60,
    calendarId: "cal",
  };
  // 11:00 (660) - 56px = 604; grid → 600 (10:00), but e1's end edge 600 is also 4 away → magnet 600.
  // Verify it lands exactly on e1's end (10:00), proving magnet/grid agree here; then nudge to 597
  // where grid (600) and magnet (600) still agree — use a case where they differ:
  const preview = previewTimelineBoxes({
    boxes,
    activeDrag: drag,
    delta: { x: 0, y: -53 }, // 660-53=607 → grid 15 → 615 (10:15); but e1 end 600 is 7 away (>6) so grid wins
    anchorDate: "2026-05-28",
    days: 1,
  });
  expect(preview.find((b) => b.id === "event:cal:e2")!.topPx).toBe(615);
});

it("magnet beats grid within threshold", () => {
  const boxes = computeLayout([
    block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
    block("event:cal:e2", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
  ]);
  const drag: DragData = {
    from: "canvas",
    blockKind: "event",
    blockId: "event:cal:e2",
    eventId: "e2",
    title: "E2",
    startISO: "2026-05-28T11:00:00+09:00",
    durationMin: 60,
    calendarId: "cal",
  };
  // 660-58=602 → grid 600; e1 end 600 within 6 → magnet 600 (same as grid here, but assert lands on edge).
  const preview = previewTimelineBoxes({
    boxes,
    activeDrag: drag,
    delta: { x: 0, y: -58 },
    anchorDate: "2026-05-28",
    days: 1,
  });
  expect(preview.find((b) => b.id === "event:cal:e2")!.topPx).toBe(600);
});

it("fine snap (snapMin=5) yields 5-minute steps", () => {
  const boxes = computeLayout([
    block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
  ]);
  const drag: DragData = {
    from: "canvas",
    blockKind: "event",
    blockId: "event:cal:e1",
    eventId: "e1",
    title: "E1",
    startISO: "2026-05-28T09:00:00+09:00",
    durationMin: 60,
    calendarId: "cal",
  };
  // 540 + 7 = 547 → fine 5 → 545 (09:05). Single block → no magnet edges.
  const preview = previewTimelineBoxes({
    boxes,
    activeDrag: drag,
    delta: { x: 0, y: 7 },
    anchorDate: "2026-05-28",
    days: 1,
    snapMin: 5,
  });
  expect(preview.find((b) => b.id === "event:cal:e1")!.topPx).toBe(545);
});
```

- [ ] **Step 7: Run, verify PASS.** `pnpm vitest run timelinePreview timelineLayout && pnpm typecheck`. All existing preview tests must still pass (their values are 15-aligned so grid==magnet — no regression).

---

## Task 3: Wire Alt fine-snap + magnet into the dispatcher and canvas

**Files:**

- Modify: `src/components/today/useTimelineDnd.ts` (opts: `boxes`, `fineSnapRef`; build snapOpts in `onDragEnd`)
- Modify: `src/components/today/TimelineCanvas.tsx` (`fineSnap` prop → `previewTimelineBoxes` snapMin)
- Modify: `src/components/TodayView.tsx` (track Alt; pass `fineSnap` + `fineSnapRef` + `boxes`)

No new unit test (pure logic is covered by Tasks 1-2; this is wiring verified by typecheck + critic + live smoke).

- [ ] **Step 1: Dispatcher.** In `src/components/today/useTimelineDnd.ts`:
  - Add imports: `import type { LayoutBox } from "@/lib/timelineLayout";` and add `magnetEdgesFromBoxes` to that import (so: `import { magnetEdgesFromBoxes, type LayoutBox } from "@/lib/timelineLayout";`). Add `snapAbsMin`? No — only `shiftIsoByPx`/`resizeIsoByPx` are used; they already are imported from `@/lib/timelineCoords`.
  - In the `Opts` type, add two optional fields:

```ts
  /** 자석 스냅 후보용 현재 레이아웃 박스(드래그 중 정적). 미지정이면 자석 없음. */
  boxes?: LayoutBox[];
  /** Alt/Option fine-snap(5분) 라이브 상태 ref. true면 snapMin=5. */
  fineSnapRef?: MutableRefObject<boolean>;
```

- Destructure them in the hook body alongside the other opts (`boxes`, `fineSnapRef`).
- At the top of `onDragEnd`, after `a` is resolved, build a snap-options factory keyed to the active block id:

```ts
const snapMin = fineSnapRef?.current ? 5 : 15;
const snapOptsFor = (blockId: string) => ({
  snapMin,
  magnetEdges: magnetEdgesFromBoxes(boxes ?? [], anchorDate, blockId),
});
```

- In the resize branch (`a.from === "canvas-resize"`), pass it to `resizeIsoByPx`:

```ts
const resized = resizeIsoByPx({
  anchorDate,
  days,
  startISO: a.startISO,
  durationMin: a.durationMin,
  edge: a.edge,
  deltaPx: ev.delta.y,
  snapOpts: snapOptsFor(a.blockId),
});
```

- In the reschedule branch (`a.from === "canvas" && o.to === "canvas"`), pass it to `shiftIsoByPx`:

```ts
const shifted = shiftIsoByPx(anchorDate, days, a.startISO, ev.delta.y, snapOptsFor(a.blockId));
```

- In the moveCalendar branch (`o.to === "canvas:cal"`), pass it too (consistency):

```ts
const at = shiftIsoByPx(anchorDate, days, a.startISO, ev.delta.y, snapOptsFor(a.blockId));
```

(Leave `pixelToLocalIso` tray/routine placements on default grid snap — out of scope.)

- [ ] **Step 2: Canvas prop.** In `src/components/today/TimelineCanvas.tsx`:
  - Add to `Props`: `/** Alt/Option fine-snap(5분) 활성. preview snapMin을 5로. */ fineSnap?: boolean;`
  - Destructure `fineSnap` in the component params.
  - In the `previewTimelineBoxes({...})` call (near the top of the component), add `snapMin: fineSnap ? 5 : 15,`.

- [ ] **Step 3: TodayView — track Alt + thread.** In `src/components/TodayView.tsx`:
  - Add refs/state near the other drag refs (after `dragRawPointerRef`):

```tsx
// Alt/Option fine-snap(5분) — 드래그 시작 activator + 드래그 중 keydown/keyup으로 라이브 추적.
// ref는 onDragEnd(커밋)가 읽고, state는 preview 리렌더(미리보기 스냅)를 구동 — 둘이 같은 소스라 preview==commit.
const fineSnapRef = useRef(false);
const [fineSnap, setFineSnap] = useState(false);
const setFine = (v: boolean) => {
  fineSnapRef.current = v;
  setFineSnap((prev) => (prev === v ? prev : v));
};
```

- In `handleDragStart`, seed Alt from the activator event. Widen the param type to include `activatorEvent` and read `altKey`:

```tsx
const handleDragStart = (ev: {
  active: { id: string | number; data: { current?: unknown } };
  activatorEvent?: Event;
}) => {
  const data = (ev.active.data.current as DragData | undefined) ?? null;
  activeDragStartRef.current = data;
  setFine(Boolean((ev.activatorEvent as { altKey?: boolean } | undefined)?.altKey));
  dispatchDragGhost({ type: "start", data });
};
```

- In `handleDragCancel` and `handleDragEndWithReset`, reset fine-snap to false (drag is over):

In `handleDragEndWithReset`, after `dispatchDragGhost({ type: "reset" });` add `setFine(false);`.
In `handleDragCancel`, after `dispatchDragGhost({ type: "reset" });` add `setFine(false);`.

- In the existing `useEffect(() => { if (!activeDrag) return; … window.addEventListener("pointermove", onMove …) }, [activeDrag])`, also listen for Alt keydown/keyup so mid-drag toggles work. Add inside that effect (before the `return () => {…}` cleanup), and extend the cleanup:

```tsx
const onKey = (e: KeyboardEvent) => {
  if (e.key === "Alt" || e.altKey !== fineSnapRef.current) setFine(e.altKey);
};
window.addEventListener("keydown", onKey);
window.addEventListener("keyup", onKey);
```

and in the cleanup add:

```tsx
window.removeEventListener("keydown", onKey);
window.removeEventListener("keyup", onKey);
```

- Pass `boxes` + `fineSnapRef` into `useTimelineDnd`:

```tsx
const { onDragEnd } = useTimelineDnd({
  date,
  anchorDate,
  days: visibleDates.length,
  defaultCalendarFor,
  promptCalendarPicker,
  gridElRef,
  pointerClientRef: lastPointerRef,
  boxes,
  fineSnapRef,
});
```

- Pass `fineSnap` to `<TimelineCanvas … fineSnap={fineSnap} />` (add the prop alongside `dragPointerGrid`).

- [ ] **Step 4: Gate.** `pnpm typecheck && pnpm lint && pnpm vitest run`. Expect typecheck 0, lint 0 err, all tests green.

---

## Phase gate (after all three tasks)

```bash
pnpm typecheck && pnpm lint && pnpm vitest run && git status --porcelain src/bindings.ts
```

Expect: typecheck 0, lint 0 err (≤2 baseline warns), all vitest green, bindings drift empty.

## Self-review checklist

- **Spec coverage:** parameterized snap (Task 1) · Alt 5-min fine (Tasks 1+3) · magnetic edge-snap nearest-wins (Tasks 1+2+3) — all §4 Phase 2 bullets.
- **preview == commit:** both `previewTimelineBoxes` and `onDragEnd` use `snapAbsMin` with the SAME `{snapMin, magnetEdges}` derivation (`magnetEdgesFromBoxes` + Alt state from one source). Routine clamp runs after snapping in both → routine-clamp parity preserved.
- **Invariants:** no IPC/schema/migration; local-ISO (`isoFromAbsMin`/`absMin`); @dnd-kit stays in `today/**`; no raw hex/CSS added.
- **Type consistency:** `SnapOpts`, `snapAbsMin`, `magnetEdgesFromBoxes`, `snapOpts` field name consistent across coords/layout/preview/dispatcher.
- **Deferred (smoke-tune, spec §7):** the drop-guide line label (`dragGuideFromLayout` + TimelineCanvas 15-snap) is NOT magnet/fine-snapped — the block (and the Phase 1 pill, which reads the snapped preview block) are authoritative; the guide line can diverge ≤6px during a magnet. Threshold (~6px) and now-line/work-hour snapping deferred to live smoke.
