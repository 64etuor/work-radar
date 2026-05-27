import { describe, expect, it } from "vitest";

import {
  normalizeDropDataForDragEnd,
  plusMinutesLocal,
  resizeIsoByPx,
  type DragData,
} from "./useTimelineDnd";

describe("normalizeDropDataForDragEnd", () => {
  it("treats canvas block movement with over=null as a canvas self-drop", () => {
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
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

describe("resizeIsoByPx", () => {
  it("top-handle drag keeps the original end time fixed", () => {
    const originalEnd = plusMinutesLocal("2026-05-28T09:00:00+09:00", 60);
    const resized = resizeIsoByPx({
      date: "2026-05-28",
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
      date: "2026-05-28",
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
