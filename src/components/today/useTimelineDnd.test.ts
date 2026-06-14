import { describe, expect, it, vi } from "vitest";

import { plusMinutesLocal, resizeIsoByPx } from "@/lib/timelineCoords";

import {
  type DragData,
  isClientPointInsideRect,
  isOffGridCanvasRelease,
  normalizeDropDataForDragEnd,
  resolveDragEndActiveData,
  shouldSynthesizeCanvasDropFromPointer,
  timelineKeyboardCoordinates,
} from "./useTimelineDnd";

describe("normalizeDropDataForDragEnd", () => {
  it("treats canvas block movement with over=null as a canvas self-drop", () => {
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal1:evt1",
      eventId: "evt1",
      title: "Event",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal1",
    };

    expect(normalizeDropDataForDragEnd(drag, undefined)).toEqual({
      to: "canvas",
      gridY: 0,
    });
  });

  it("treats resize handle release with over=null as a canvas self-drop", () => {
    const drag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "signal",
      blockId: "signal:sig1",
      signalId: "sig1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
    };

    expect(normalizeDropDataForDragEnd(drag, undefined)).toEqual({
      to: "canvas",
      gridY: 0,
    });
  });

  it("does not synthesize a canvas drop for tray items", () => {
    const drag: DragData = {
      from: "tray",
      signalId: "sig1",
      title: "Signal",
    };

    expect(normalizeDropDataForDragEnd(drag, undefined)).toBeUndefined();
  });
});

describe("shouldSynthesizeCanvasDropFromPointer", () => {
  const tray: DragData = { from: "tray", signalId: "sig1", title: "Signal" };
  const routine: DragData = { from: "routine", routineId: "r1", title: "Routine" };
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

  it("synthesizes only for tray/routine pointer drags that ended with no droppable", () => {
    expect(shouldSynthesizeCanvasDropFromPointer(tray, undefined, true)).toBe(true);
    expect(shouldSynthesizeCanvasDropFromPointer(routine, undefined, true)).toBe(true);
  });

  it("does not synthesize for keyboard drags (last pointer is not user intent)", () => {
    expect(shouldSynthesizeCanvasDropFromPointer(tray, undefined, false)).toBe(false);
    expect(shouldSynthesizeCanvasDropFromPointer(routine, undefined, false)).toBe(false);
  });

  it("does not synthesize when a droppable was hit", () => {
    expect(shouldSynthesizeCanvasDropFromPointer(tray, { to: "canvas", gridY: 0 }, true)).toBe(
      false,
    );
  });

  it("does not synthesize for canvas drags (they already have a fallback)", () => {
    expect(shouldSynthesizeCanvasDropFromPointer(canvas, undefined, true)).toBe(false);
  });

  it("does not synthesize when there is no active drag", () => {
    expect(shouldSynthesizeCanvasDropFromPointer(undefined, undefined, true)).toBe(false);
  });
});

describe("isClientPointInsideRect", () => {
  const rect = { left: 100, right: 400, top: 50, bottom: 600 };

  it("accepts points inside and on the boundary", () => {
    expect(isClientPointInsideRect({ x: 200, y: 300 }, rect)).toBe(true);
    expect(isClientPointInsideRect({ x: 100, y: 50 }, rect)).toBe(true);
    expect(isClientPointInsideRect({ x: 400, y: 600 }, rect)).toBe(true);
  });

  it("rejects points outside any edge", () => {
    expect(isClientPointInsideRect({ x: 99, y: 300 }, rect)).toBe(false);
    expect(isClientPointInsideRect({ x: 401, y: 300 }, rect)).toBe(false);
    expect(isClientPointInsideRect({ x: 200, y: 49 }, rect)).toBe(false);
    expect(isClientPointInsideRect({ x: 200, y: 601 }, rect)).toBe(false);
  });
});

describe("resizeIsoByPx", () => {
  it("top-handle drag keeps the original end time fixed", () => {
    const originalEnd = plusMinutesLocal("2026-05-28T09:00:00+09:00", 60);
    const resized = resizeIsoByPx({
      anchorDate: "2026-05-28",
      days: 1,
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      edge: "top",
      deltaPx: 15,
    });

    expect(resized.at).toContain("09:15");
    expect(resized.durationMin).toBe(45);
    expect(plusMinutesLocal(resized.at, resized.durationMin)).toBe(originalEnd);
  });

  it("bottom-handle drag keeps start fixed and changes end", () => {
    const resized = resizeIsoByPx({
      anchorDate: "2026-05-28",
      days: 1,
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      edge: "bottom",
      deltaPx: 15,
    });

    expect(resized.at).toBe("2026-05-28T09:00:00+09:00");
    expect(resized.durationMin).toBe(75);
    expect(plusMinutesLocal(resized.at, resized.durationMin)).toContain("10:15");
  });
});

describe("resolveDragEndActiveData", () => {
  it("uses the drag-start snapshot so resize preview duration is not counted twice", () => {
    const started: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "signal",
      blockId: "signal:sig1",
      signalId: "sig1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
    };
    const previewMutated: DragData = {
      ...started,
      durationMin: 120,
    };

    const active = resolveDragEndActiveData(started, previewMutated);
    expect(active).toBe(started);
    if (active?.from !== "canvas-resize") {
      throw new Error("expected resize drag data");
    }

    const resized = resizeIsoByPx({
      anchorDate: "2026-05-28",
      days: 1,
      startISO: active.startISO,
      durationMin: active.durationMin,
      edge: active.edge,
      deltaPx: 60,
    });

    expect(resized.durationMin).toBe(120);
    expect(plusMinutesLocal(resized.at, resized.durationMin)).toContain("11:00");
  });
});

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

  it("treats a point exactly on the grid edge as inside (inclusive boundary)", () => {
    expect(isOffGridCanvasRelease(canvas, undefined, { point: { x: 100, y: 300 }, rect })).toBe(
      false,
    );
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

  it("preventDefault on handled keys only (so the page doesn't scroll mid-drag)", () => {
    const fired = (code: string) => {
      const preventDefault = vi.fn();
      timelineKeyboardCoordinates(
        { code, shiftKey: false, preventDefault } as unknown as KeyboardEvent,
        { currentCoordinates: { x: 10, y: 100 } } as never,
      );
      return preventDefault;
    };
    expect(fired("ArrowDown")).toHaveBeenCalledOnce();
    expect(fired("ArrowUp")).toHaveBeenCalledOnce();
    expect(fired("ArrowLeft")).not.toHaveBeenCalled();
  });
});
