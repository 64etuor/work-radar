# DnD Overhaul — Phase 1 (Drag/Resize Feel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do NOT commit inside subagents** — the loop runbook commits ONCE per phase after a full gate + separate critic pass.

**Goal:** Raise the Today timeline drag/resize _feel_ to calendar-grade: overlap-conflict tint during preview, a floating duration/time pill on the active edge, suppression of the redundant resize ghost, and a true off-grid snap-back instead of a top-of-grid commit.

**Architecture:** All four changes are renderer-only (no IPC, no schema, no migration). Pure logic lands in `timelinePreview.ts` / `useTimelineDnd.ts` (unit-tested); wiring lands in `TimelineCanvas.tsx` / `TimelineBlock.tsx` / `TodayView.tsx`; visuals in `TodayView.css` using existing `@theme`/`var(--…)` tokens only (no raw hex). The preview layout (`previewTimelineBoxes`) is already the authoritative snapped position, so labels and overlap detection are _derived_ from it (DRY) rather than recomputing drag math.

**Tech Stack:** React 19, `@dnd-kit/core`, Vitest, Tailwind v4 `@theme` tokens.

**Source of truth:** spec `docs/superpowers/specs/2026-06-14-today-timeline-dnd-ux-overhaul-design.md` §4 Phase 1; runbook `docs/superpowers/plans/2026-06-14-dnd-overhaul-autonomous-loop-runbook.md`. Area rules: `docs/areas/today-timeline.md` (INVARIANT #7 local-ISO; @dnd-kit confined to `today/**`).

**Invariant guards for every task:** local-ISO time math only (`absMin`/`.slice(11,16)`, never `.toISOString()`); design tokens only; smallest local change; no unrelated refactors.

---

## Task 1: Off-grid canvas release → snap back + toast (spec §4 Phase 1 "Outside-grid release")

**Problem today:** `normalizeDropDataForDragEnd` maps a lost droppable (`over=null`) for a `canvas`/`canvas-resize` drag to `{to:"canvas", gridY:0}`, so the move/resize still commits (via `ev.delta.y`). A drag released _outside_ the grid is indistinguishable from a dnd-kit collision-miss while still over the grid. We thread the release pointer + fresh grid rect to tell them apart: inside grid → commit (re-resolve, today's behavior); truly outside → no commit (snap back) + toast.

**Files:**

- Modify: `src/components/today/useTimelineDnd.ts` (add `isOffGridCanvasRelease`; add optional `release` arg to `normalizeDropDataForDragEnd`; wire the off-grid early-return + toast into `onDragEnd`)
- Test: `src/components/today/useTimelineDnd.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/components/today/useTimelineDnd.test.ts`. First add `isOffGridCanvasRelease` to the existing import from `./useTimelineDnd`. Then add:

```ts
describe("isOffGridCanvasRelease", () => {
  const canvas: DragData = {
    from: "canvas",
    blockKind: "signal",
    blockId: "signal:sig1",
    signalId: "sig1",
    title: "Signal",
    startISO: "2026-05-28T09:00:00+09:00",
    durationMin: 60,
    calendarId: "cal1",
  };
  const rect = { left: 100, right: 400, top: 50, bottom: 600 };

  it("classifies a canvas release outside the grid rect as off-grid", () => {
    expect(isOffGridCanvasRelease(canvas, undefined, { point: { x: 50, y: 300 }, rect })).toBe(
      true,
    );
  });

  it("does not classify a canvas release inside the grid rect (collision-miss → still commit)", () => {
    expect(isOffGridCanvasRelease(canvas, undefined, { point: { x: 200, y: 300 }, rect })).toBe(
      false,
    );
  });

  it("never off-grid when a droppable was hit", () => {
    expect(
      isOffGridCanvasRelease(
        canvas,
        { to: "canvas", gridY: 0 },
        { point: { x: 50, y: 300 }, rect },
      ),
    ).toBe(false);
  });

  it("does not classify tray drags (they own a separate fallback)", () => {
    const tray: DragData = { from: "tray", signalId: "sig1", title: "Signal" };
    expect(isOffGridCanvasRelease(tray, undefined, { point: { x: 50, y: 300 }, rect })).toBe(false);
  });

  it("does not classify when pointer or rect is unknown (keyboard / no ref)", () => {
    expect(isOffGridCanvasRelease(canvas, undefined, { point: null, rect })).toBe(false);
    expect(
      isOffGridCanvasRelease(canvas, undefined, { point: { x: 50, y: 300 }, rect: null }),
    ).toBe(false);
  });
});

describe("normalizeDropDataForDragEnd with release", () => {
  const canvas: DragData = {
    from: "canvas",
    blockKind: "signal",
    blockId: "signal:sig1",
    signalId: "sig1",
    title: "Signal",
    startISO: "2026-05-28T09:00:00+09:00",
    durationMin: 60,
    calendarId: "cal1",
  };
  const rect = { left: 100, right: 400, top: 50, bottom: 600 };

  it("returns undefined (snap back) for an off-grid canvas release", () => {
    expect(
      normalizeDropDataForDragEnd(canvas, undefined, { point: { x: 50, y: 300 }, rect }),
    ).toBeUndefined();
  });

  it("returns a canvas self-drop for an on-grid lost droppable", () => {
    expect(
      normalizeDropDataForDragEnd(canvas, undefined, { point: { x: 200, y: 300 }, rect }),
    ).toEqual({ to: "canvas", gridY: 0 });
  });
});
```

- [ ] **Step 2: Run tests, verify they FAIL**

Run: `pnpm vitest run useTimelineDnd`
Expected: FAIL — `isOffGridCanvasRelease is not a function` and the release-overload assertions.

- [ ] **Step 3: Implement**

In `src/components/today/useTimelineDnd.ts`, add the predicate just below `isClientPointInsideRect` (it depends on it):

```ts
/** 릴리스 위치 분류용 입력 — 마지막 raw 포인터(viewport)와 드롭 시점 fresh 그리드 rect. */
export type ReleaseAt = {
  point: { x: number; y: number } | null | undefined;
  rect: { left: number; right: number; top: number; bottom: number } | null | undefined;
};

/**
 * canvas/canvas-resize 드래그가 droppable 없이(over 없음) 끝났는데 release 포인터가 그리드 rect
 * 밖이면 "그리드 밖 릴리스"로 분류한다 — 커밋하지 않고 스냅백 + 토스트. 포인터/rect를 모르면(키보드
 * 드래그/ref 미주입) 분류하지 않아 기존 delta 기반 커밋을 유지한다. dnd-kit collision-miss(포인터는
 * 그리드 안)는 off-grid가 아니다 — 그 경우 기존처럼 delta로 재해석한다.
 */
export function isOffGridCanvasRelease(
  active: DragData | undefined,
  over: DropData | undefined,
  release: ReleaseAt,
): boolean {
  if (over) return false;
  if (!active) return false;
  if (active.from !== "canvas" && active.from !== "canvas-resize") return false;
  if (!release.point || !release.rect) return false;
  return !isClientPointInsideRect(release.point, release.rect);
}
```

Then change `normalizeDropDataForDragEnd` to accept an optional `release` and snap back when off-grid:

```ts
export function normalizeDropDataForDragEnd(
  active: DragData | undefined,
  over: DropData | undefined,
  release?: ReleaseAt,
): DropData | undefined {
  if (over) return over;
  if (!active) return undefined;
  if (active.from === "canvas" || active.from === "canvas-resize") {
    if (release && isOffGridCanvasRelease(active, over, release)) return undefined;
    return { to: "canvas", gridY: 0 };
  }
  return undefined;
}
```

Now wire it into `onDragEnd`. Replace the current head of the function (the `const a = …` line through the existing `let o = …` and `const isPointerDrag = …` lines) so the release is computed once and the off-grid case returns early **before** normalize. The new head:

```ts
  const onDragEnd = async (ev: DragEndEvent, activeAtStart?: DragData | null) => {
    const a = resolveDragEndActiveData(
      activeAtStart,
      ev.active.data.current as DragData | undefined,
    );
    const overData = ev.over?.data.current as DropData | undefined;
    // 키보드 드래그(KeyboardSensor)는 last pointer가 사용자가 가리킨 곳이 아니므로 release 분류 제외.
    const isPointerDrag = !(ev.activatorEvent instanceof KeyboardEvent);
    const release: ReleaseAt | undefined = isPointerDrag
      ? { point: pointerClientRef?.current ?? null, rect: gridElRef?.current?.getBoundingClientRect() ?? null }
      : undefined;
    // canvas/canvas-resize를 그리드 밖에서 릴리스하면 커밋하지 않고 스냅백 + 토스트(이전엔 delta로
    // 그리드 상단에 커밋됐다). collision-miss(포인터는 그리드 안)는 off-grid가 아니라 그대로 커밋.
    if (release && isOffGridCanvasRelease(a, overData, release)) {
      useToastStore.getState().pushError("timeline.drop", "타임라인 영역 밖이라 되돌렸습니다");
      return;
    }
    let o = normalizeDropDataForDragEnd(a, overData, release);
    // tray/routine 드래그가 over 없이 끝났을 때: 마지막 포인터가 그리드 rect 안이면 canvas 배치로
    // 폴백(무음 noop 방지), 밖이면 토스트로 알린다.
    if (shouldSynthesizeCanvasDropFromPointer(a, o, isPointerDrag)) {
      const p = pointerClientRef?.current;
      const rect = gridElRef?.current?.getBoundingClientRect();
      if (p && rect && isClientPointInsideRect(p, rect)) {
        o = { to: "canvas", gridY: 0 };
      } else {
        useToastStore
          .getState()
          .pushError("timeline.drop", "타임라인 영역 안에 놓아야 배치할 수 있습니다");
      }
    }
    if (!a || !o) return;
```

Leave the rest of `onDragEnd` unchanged. (Note: `useToastStore` is already imported.)

- [ ] **Step 4: Run tests, verify PASS**

Run: `pnpm vitest run useTimelineDnd`
Expected: PASS (all prior cases + the new `isOffGridCanvasRelease` / release-overload cases).

---

## Task 2: Overlap-conflict tint during preview (spec §4 Phase 1 "Overlap-conflict tint")

**Approach:** During a canvas drag, the active block "would overlap" iff in the preview layout it landed in a multi-column cluster (`widthPct < 100`) — derived straight from `computeLayout` cluster sizing per the spec. We expose a pure `activeDragWouldOverlap`, then tint only the active dragged block with a preview-only attribute that vanishes on drop.

**Files:**

- Modify: `src/components/today/timelinePreview.ts` (add `activeDragWouldOverlap`)
- Modify: `src/components/today/TimelineBlock.tsx` (add `conflict?: boolean` → `data-conflict`)
- Modify: `src/components/today/TimelineCanvas.tsx` (compute conflict block id, pass `conflict`)
- Modify: `src/components/TodayView.css` (tint rule)
- Test: `src/components/today/timelinePreview.test.ts`

- [ ] **Step 1: Write failing test**

Append to the `describe("previewTimelineBoxes", …)` block (or a new describe) in `src/components/today/timelinePreview.test.ts`. Add `activeDragWouldOverlap` to the import from `./timelinePreview`. Then:

```ts
describe("activeDragWouldOverlap", () => {
  const boxes = computeLayout([
    block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
    block("event:cal:e1", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
  ]);
  const drag: DragData = {
    from: "canvas",
    blockKind: "event",
    blockId: "event:cal:e1",
    eventId: "e1",
    title: "Event",
    startISO: "2026-05-28T11:00:00+09:00",
    durationMin: 60,
    calendarId: "cal",
  };

  it("is true when the dragged block previews onto another block (multi-column cluster)", () => {
    // -120px → 11:00 모브 to 09:00, signal:s1과 겹쳐 widthPct 50.
    expect(
      activeDragWouldOverlap({
        boxes,
        activeDrag: drag,
        delta: { x: 0, y: -120 },
        anchorDate: "2026-05-28",
        days: 1,
      }),
    ).toBe(true);
  });

  it("is false when the dragged block previews onto empty time", () => {
    // +180px → 11:00 to 14:00, 단독 클러스터 widthPct 100.
    expect(
      activeDragWouldOverlap({
        boxes,
        activeDrag: drag,
        delta: { x: 0, y: 180 },
        anchorDate: "2026-05-28",
        days: 1,
      }),
    ).toBe(false);
  });

  it("is false for non-canvas drags", () => {
    const tray: DragData = { from: "tray", signalId: "s1", title: "Signal" };
    expect(
      activeDragWouldOverlap({
        boxes,
        activeDrag: tray,
        delta: { x: 0, y: 0 },
        anchorDate: "2026-05-28",
        days: 1,
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm vitest run timelinePreview`
Expected: FAIL — `activeDragWouldOverlap is not a function`.

- [ ] **Step 3: Implement the pure function**

In `src/components/today/timelinePreview.ts`, add after `previewTimelineBoxes`:

```ts
/**
 * 드래그 중인 캔버스 블록이 preview 레이아웃에서 다른 블록과 겹치는지 — computeLayout이 멀티컬럼
 * 클러스터로 배치했는지(`widthPct < 100`)로 유도한다(스펙 §4 Phase 1). 미리보기 전용 겹침 틴트
 * 트리거. 마지막-write-wins는 유지하고 _피드백_만 추가한다(area doc).
 */
export function activeDragWouldOverlap(args: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  anchorDate: string;
  days: number;
}): boolean {
  const { activeDrag } = args;
  if (!activeDrag) return false;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return false;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return false;
  const preview = previewTimelineBoxes(args);
  const activeBox = preview.find((b) => b.id === activeId);
  if (!activeBox) return false;
  return activeBox.widthPct < 100;
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm vitest run timelinePreview`
Expected: PASS.

- [ ] **Step 5: Wire the tint prop through `TimelineBlock`**

In `src/components/today/TimelineBlock.tsx`, add to the `Props` type (after `disableLayoutTransition?: boolean;`):

```ts
  /** 드래그 미리보기에서 이 블록이 다른 블록과 겹치면 true — 경고 틴트(미리보기 전용). */
  conflict?: boolean;
```

Destructure it in the component signature (add `conflict = false,` alongside the other defaults), and set the attribute on the wrapper `<div className="tl-block-wrap" …>`:

```tsx
      data-conflict={conflict || undefined}
```

(Place it right after the existing `data-dragging={drag.isDragging || undefined}` line.)

- [ ] **Step 6: Compute and pass the conflict id in `TimelineCanvas`**

In `src/components/today/TimelineCanvas.tsx`, import `activeDragWouldOverlap` (add to the existing import from `@/components/today/timelinePreview`). After the `previewOwnsBlockLayout` const, add:

```tsx
// 드래그 미리보기에서 겹치는 active 블록 id — 경고 틴트(미리보기 전용, 드롭 시 사라짐).
const conflictBlockId =
  activeDrag &&
  (activeDrag.from === "canvas" || activeDrag.from === "canvas-resize") &&
  activeDragWouldOverlap({ boxes, activeDrag, delta: activeDelta, anchorDate, days })
    ? activeDrag.blockId
    : null;
```

Then pass it on the `<TimelineBlock>` element inside `renderBoxes.map`:

```tsx
              conflict={b.id === conflictBlockId}
```

- [ ] **Step 7: Add the tint CSS**

In `src/components/TodayView.css`, add near the `.tl-block-wrap` rules (e.g. right after the `:hover/:focus-within` z-lift block around line 569). Use only existing tokens:

```css
/* 드래그 미리보기 겹침 경고 틴트 — data-conflict는 미리보기 전용(드롭 시 제거). */
.tl-block-wrap[data-conflict] .tl-block {
  background: color-mix(in srgb, var(--color-today-debt-warn) 22%, var(--td-white));
  box-shadow: inset 0 0 0 1px var(--color-today-debt-warn);
}
```

- [ ] **Step 8: Run the front gate for this task**

Run: `pnpm vitest run timelinePreview && pnpm typecheck`
Expected: tests PASS; typecheck 0 errors.

---

## Task 3: Floating duration/time pill on the active edge (spec §4 Phase 1 "Duration pill")

**Approach:** The preview active block already carries exact snapped `startISO`/`endISO` (set by `previewTimelineBoxes`), so derive the pill text from it — no duplicated clamp/snap math. Render `HH:MM–HH:MM · 1h15m` during resize and the start `HH:MM` during move, positioned at the active edge (`activeGuide`).

**Files:**

- Modify: `src/components/today/timelinePreview.ts` (add `activeDragLabel` + `ActiveDragLabel` type)
- Modify: `src/components/today/TimelineCanvas.tsx` (render the pill)
- Modify: `src/components/TodayView.css` (`.today-canvas-resize-pill`)
- Test: `src/components/today/timelinePreview.test.ts`

- [ ] **Step 1: Write failing test**

Add `activeDragLabel` to the import. Append:

```ts
describe("activeDragLabel", () => {
  const boxes = computeLayout([
    block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
  ]);

  it("labels a bottom resize with the full range + duration", () => {
    const drag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      calendarId: "cal",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
    };
    const label = activeDragLabel({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 15 },
      anchorDate: "2026-05-28",
      days: 1,
    });
    expect(label).toEqual({
      kind: "resize",
      startHHMM: "09:00",
      endHHMM: "10:15",
      durationLabel: "1h15m",
    });
  });

  it("labels a move with the new start time", () => {
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "Event",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const label = activeDragLabel({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      anchorDate: "2026-05-28",
      days: 1,
    });
    expect(label).toEqual({
      kind: "move",
      startHHMM: "11:00",
      endHHMM: "12:00",
      durationLabel: "1h",
    });
  });

  it("returns null for non-canvas drags", () => {
    const tray: DragData = { from: "tray", signalId: "s1", title: "Signal" };
    expect(
      activeDragLabel({
        boxes,
        activeDrag: tray,
        delta: { x: 0, y: 0 },
        anchorDate: "2026-05-28",
        days: 1,
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm vitest run timelinePreview`
Expected: FAIL — `activeDragLabel is not a function`.

- [ ] **Step 3: Implement**

In `src/components/today/timelinePreview.ts`, ensure `absMin` is imported (it already is: `import { absMin, localDateOf } from "@/lib/timeAxis";`). Add:

```ts
export type ActiveDragLabel = {
  kind: "move" | "resize";
  startHHMM: string;
  endHHMM: string;
  /** "1h15m" / "45m" / "1h" — 0분/0시 생략. */
  durationLabel: string;
};

/** 로컬 ISO('YYYY-MM-DDTHH:MM…')에서 HH:MM — UTC 변환 금지(INVARIANT #7). */
function hhmmOfIso(iso: string): string {
  return iso.slice(11, 16);
}

function fmtDurationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

/**
 * 드래그 중 active 캔버스 블록의 시간 라벨(플로팅 pill용). preview 블록의 스냅된 startISO/endISO를
 * 그대로 읽어(= previewTimelineBoxes가 이미 계산한 정본) 드래그 수학을 중복하지 않는다. resize면
 * 범위+길이, move면 시작 시각을 caller가 표시한다.
 */
export function activeDragLabel(args: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  anchorDate: string;
  days: number;
}): ActiveDragLabel | null {
  const { activeDrag, anchorDate } = args;
  if (!activeDrag) return null;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return null;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return null;
  const preview = previewTimelineBoxes(args);
  const box = preview.find((b) => b.id === activeId);
  if (!box) return null;
  const { startISO, endISO } = box.block;
  const durationMin = Math.max(0, absMin(endISO, anchorDate) - absMin(startISO, anchorDate));
  return {
    kind: activeDrag.from === "canvas-resize" ? "resize" : "move",
    startHHMM: hhmmOfIso(startISO),
    endHHMM: hhmmOfIso(endISO),
    durationLabel: fmtDurationLabel(durationMin),
  };
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm vitest run timelinePreview`
Expected: PASS.

- [ ] **Step 5: Render the pill in `TimelineCanvas`**

In `src/components/today/TimelineCanvas.tsx`, add `activeDragLabel` to the import from `@/components/today/timelinePreview`. After the `activeGuide` const (around line 120), add:

```tsx
const dragLabel = activeDragLabel({ boxes, activeDrag, delta: activeDelta, anchorDate, days });
```

Inside the `activeDrag && (() => { … })()` IIFE, just before the closing `</>` of the returned fragment (after the `today-canvas-drop-preview` block), render the pill using the already-computed `activeGuide`:

```tsx
{
  dragLabel && activeGuide && (
    <div
      className="today-canvas-resize-pill"
      style={{ top: `${activeGuide.y}px`, left: `${activeGuide.x}px` }}
      aria-hidden
    >
      {dragLabel.kind === "resize"
        ? `${dragLabel.startHHMM}–${dragLabel.endHHMM} · ${dragLabel.durationLabel}`
        : dragLabel.startHHMM}
    </div>
  );
}
```

(`activeGuide` is non-null exactly for `canvas`/`canvas-resize` drags, which is also when `dragLabel` is non-null — tray/routine get the existing snap-time guide instead.)

- [ ] **Step 6: Add pill CSS**

In `src/components/TodayView.css`, add after the `.today-canvas-drop-guide::after` rule (around line 204), using existing tokens only:

```css
/* 리사이즈/이동 중 active 엣지에 붙는 시각·길이 pill (Phase 1). */
.today-canvas-resize-pill {
  position: absolute;
  transform: translate(8px, -50%);
  padding: 2px 7px;
  background: var(--color-wr-fg);
  color: var(--td-white);
  border-radius: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
  pointer-events: none;
  z-index: 5;
  box-shadow: 0 2px 6px var(--td-shadow-dark-12);
}
```

- [ ] **Step 7: Run the front gate for this task**

Run: `pnpm vitest run timelinePreview && pnpm typecheck`
Expected: tests PASS; typecheck 0.

---

## Task 4: Suppress the redundant resize ghost (spec §4 Phase 1 "Suppress redundant ghost")

**Approach:** During a `canvas-resize` drag the block now resizes in place (preview) with a duration pill, so the cursor-following resize bar in `DragOverlay` is redundant. Return `null` for `canvas-resize`. The `canvas`-over-tray card (unschedule affordance) and tray/routine ghosts are kept. The now-dead `.today-drag-ghost-resize` CSS rule is removed in the same change (directly tied to the deleted branch).

**Files:**

- Modify: `src/components/TodayView.tsx` (`DragGhost`)
- Modify: `src/components/TodayView.css` (remove `.today-drag-ghost-resize`)

- [ ] **Step 1: Edit `DragGhost`**

In `src/components/TodayView.tsx`, replace the top of `DragGhost` so `canvas-resize` renders nothing:

```tsx
function DragGhost({ data, isOverTray }: { data: DragData; isOverTray: boolean }) {
  // canvas-resize: 인플레이스 preview(블록 리사이즈 + 시각 pill)가 정본 — 따라오는 막대 ghost는 중복.
  if (data.from === "canvas-resize") return null;
  if (data.from === "canvas") {
    if (!isOverTray) return null;
    // 캔버스→트레이 드래그: 인박스 카드 비주얼로 전환(unschedule 미리보기).
    return (
      <div className="today-drag-ghost today-drag-ghost--card">
        <div className="today-drag-ghost-card-title">{data.title}</div>
      </div>
    );
  }
  // 여기까지 오면 from은 tray | routine.
  return (
    <div className="today-drag-ghost">
      <span className="today-drag-ghost-grip" aria-hidden>
        ⠿
      </span>
      <span className="today-drag-ghost-title">{data.title}</span>
    </div>
  );
}
```

(Remove the old `const isResize = …` line and its `if (isResize)` block.)

- [ ] **Step 2: Remove the dead CSS rule**

In `src/components/TodayView.css`, delete the entire `.today-drag-ghost-resize { … }` rule (lines ~265–272).

- [ ] **Step 3: Verify no remaining references**

Run: `grep -rn "today-drag-ghost-resize" src` — expect **no matches**.

- [ ] **Step 4: Run typecheck/lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors (≤2 baseline warnings allowed).

---

## Phase gate (after all four tasks — runbook step 3)

Run the full front gate (canonical `docs/reference/commands.md`):

```bash
pnpm typecheck && pnpm lint && pnpm vitest run && git status --porcelain src/bindings.ts
```

Expected: typecheck 0; lint 0 errors (≤2 baseline warns); all vitest green; `src/bindings.ts` line empty (no IPC change).

## Self-review checklist

- **Spec coverage:** overlap tint (Task 2) · duration pill (Task 3) · suppress ghost (Task 4) · off-grid release (Task 1) — all four spec §4 Phase 1 bullets covered.
- **Invariants:** no IPC/schema/migration; local-ISO only (`absMin`, `.slice(11,16)`); tokens only (`--color-today-debt-warn`, `--color-wr-fg`, `--td-white`, `--td-shadow-dark-12`, `--color-today-signal`); @dnd-kit confined to `today/**`.
- **Type consistency:** `ReleaseAt`, `ActiveDragLabel` defined once and reused; `activeDragWouldOverlap`/`activeDragLabel`/`isOffGridCanvasRelease` names match between impl, tests, and call sites.
- **No placeholders.** Every step shows the exact code/command.
