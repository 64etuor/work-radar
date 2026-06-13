import { describe, expect, it } from "vitest";

import { plusMinutesLocal, resizeIsoByPx } from "@/lib/timelineCoords";

import {
  type DragData,
  isClientPointInsideRect,
  normalizeDropDataForDragEnd,
  resolveDragEndActiveData,
  shouldSynthesizeCanvasDropFromPointer,
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
