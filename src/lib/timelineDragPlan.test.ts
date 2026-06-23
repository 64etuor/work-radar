import { describe, expect, it } from "vitest";

import type { DragData } from "@/components/today/useTimelineDnd";

import { planTimelineDrag, type TimelineDragInput } from "./timelineDragPlan";
import { computeLayout, type TimedBlock } from "./timelineLayout";

const ANCHOR = "2026-05-28";

function block(
  id: string,
  startISO: string,
  endISO: string,
  extra?: Partial<TimedBlock>,
): TimedBlock {
  return {
    id,
    kind: id.startsWith("signal:") ? "signal" : id.startsWith("routine:") ? "routine" : "event",
    title: id,
    startISO,
    endISO,
    calendarId: "cal",
    color: "#4a7bb8",
    ...extra,
  };
}

function plan(partial: Partial<TimelineDragInput> & Pick<TimelineDragInput, "boxes">) {
  return planTimelineDrag({
    anchorDate: ANCHOR,
    days: 1,
    activeDrag: null,
    drop: null,
    delta: { x: 0, y: 0 },
    snapMin: 15,
    ...partial,
  });
}

describe("planTimelineDrag — reschedule (move) parity", () => {
  it("signal move: commit at/duration == preview block position", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      delta: { x: 0, y: 120 }, // +2h → 11:00
    });
    expect(result.commit).toEqual({
      kind: "reschedule",
      targetSignalId: "s1",
      at: "2026-05-28T11:00:00+09:00",
      durationMin: 60,
      fromDate: "2026-05-28",
    });
    // preview block lands at the same start time.
    const moved = result.previewBoxes.find((b) => b.id === "signal:s1")!;
    expect(moved.block.startISO).toBe("2026-05-28T11:00:00+09:00");
  });

  it("event move: eventReschedule with calendar/event ids; preview matches", () => {
    const boxes = computeLayout(
      [block("event:cal:e1", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "Event",
      startISO: "2026-05-28T11:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: 120 }, // 11:00 → 13:00
    });
    expect(result.commit).toEqual({
      kind: "eventReschedule",
      eventId: "e1",
      calendarId: "cal",
      at: "2026-05-28T13:00:00+09:00",
      durationMin: 60,
      routineId: undefined,
      routineDate: undefined,
    });
    expect(result.previewBoxes.find((b) => b.id === "event:cal:e1")!.block.startISO).toBe(
      "2026-05-28T13:00:00+09:00",
    );
  });

  it("event move crossing midnight: continuous axis (no clamp for plain event)", () => {
    const boxes = computeLayout(
      [block("event:cal:e1", "2026-05-28T23:00:00+09:00", "2026-05-28T23:30:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "Event",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: 120 }, // +2h → next day 01:00
    });
    expect((result.commit as { at: string }).at).toBe("2026-05-29T01:00:00+09:00");
    expect(result.previewBoxes.find((b) => b.id === "event:cal:e1")!.visual.topPx).toBe(1440 + 60);
  });

  it("routine move clamps to occurrence date (cannot cross midnight)", () => {
    const boxes = computeLayout(
      [
        block("routine:r1", "2026-05-28T23:00:00+09:00", "2026-05-28T23:30:00+09:00", {
          routineId: "r1",
        }),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: 120 }, // would be next-day 01:00 → clamps to 23:45 (end at midnight)
    });
    expect(result.commit).toEqual({
      kind: "routineReschedule",
      routineId: "r1",
      date: "2026-05-28",
      at: "2026-05-28T23:45:00+09:00",
      durationMin: 15,
    });
    expect(result.routineBoundaryClamped).toBe(true);
    const moved = result.previewBoxes.find((b) => b.id === "routine:r1")!;
    expect(moved.block.startISO.startsWith("2026-05-28T23:45")).toBe(true);
  });

  it("routine-backed event (routineId attached) follows the routine clamp", () => {
    const boxes = computeLayout(
      [
        block("event:cal:e1", "2026-05-28T23:00:00+09:00", "2026-05-28T23:30:00+09:00", {
          routineId: "r1",
        }),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "Routine event",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
      routineId: "r1",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: 120 },
    });
    expect(result.commit).toEqual({
      kind: "eventReschedule",
      eventId: "e1",
      calendarId: "cal",
      at: "2026-05-28T23:45:00+09:00",
      durationMin: 15,
      routineId: "r1",
      routineDate: "2026-05-28",
    });
  });

  it("magnet beats grid within threshold (lands on neighbor edge)", () => {
    const boxes = computeLayout(
      [
        block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
        block("event:cal:e2", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e2",
      eventId: "e2",
      title: "E2",
      startISO: "2026-05-28T11:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    // 660-58=602 → grid 600; e1 end 600 within 6 → magnet 600 (10:00).
    const result = plan({ boxes, activeDrag, drop: { to: "canvas" }, delta: { x: 0, y: -58 } });
    expect((result.commit as { at: string }).at).toBe("2026-05-28T10:00:00+09:00");
    expect(result.previewBoxes.find((b) => b.id === "event:cal:e2")!.visual.topPx).toBe(600);
  });

  it("fine snap (snapMin=5) yields 5-minute steps in both preview and commit", () => {
    const boxes = computeLayout(
      [block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "E1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    // 540 + 7 = 547 → fine 5 → 545 (09:05).
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      delta: { x: 0, y: 7 },
      snapMin: 5,
    });
    expect((result.commit as { at: string }).at).toBe("2026-05-28T09:05:00+09:00");
    expect(result.previewBoxes.find((b) => b.id === "event:cal:e1")!.visual.topPx).toBe(545);
  });
});

describe("planTimelineDrag — resize parity", () => {
  it("bottom resize: signal resize, duration grows by snapped delta", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
    };
    // +15px → end 10:15, duration 75, start unchanged.
    const result = plan({ boxes, activeDrag, drop: { to: "canvas" }, delta: { x: 0, y: 15 } });
    expect(result.commit).toEqual({
      kind: "resize",
      targetSignalId: "s1",
      at: "2026-05-28T09:00:00+09:00",
      durationMin: 75,
      fromDate: "2026-05-28",
    });
    const moved = result.previewBoxes.find((b) => b.id === "signal:s1")!;
    expect(moved.block.startISO).toBe("2026-05-28T09:00:00+09:00");
    expect(moved.block.endISO).toBe("2026-05-28T10:15:00+09:00");
  });

  it("top resize keeps the END fixed and shifts the start", () => {
    const boxes = computeLayout(
      [block("event:cal:e1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas-resize",
      edge: "top",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      calendarId: "cal",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
    };
    // top -30px → start 08:30, end stays 10:00 → duration 90.
    const result = plan({ boxes, activeDrag, drop: { to: "canvas" }, delta: { x: 0, y: -30 } });
    expect(result.commit).toEqual({
      kind: "eventResize",
      eventId: "e1",
      calendarId: "cal",
      at: "2026-05-28T08:30:00+09:00",
      durationMin: 90,
      routineId: undefined,
      routineDate: undefined,
    });
    const moved = result.previewBoxes.find((b) => b.id === "event:cal:e1")!;
    expect(moved.block.endISO).toBe("2026-05-28T10:00:00+09:00");
  });

  it("routine bottom-resize: end cannot exceed midnight; routineLengthFixed flagged", () => {
    const boxes = computeLayout(
      [
        block("routine:r1", "2026-05-28T23:00:00+09:00", "2026-05-28T23:30:00+09:00", {
          routineId: "r1",
        }),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
    };
    // +120px → end would be next-day 01:30, clamp end to midnight → duration 60.
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: 120 },
    });
    expect(result.commit).toEqual({
      kind: "routineResize",
      routineId: "r1",
      date: "2026-05-28",
      at: "2026-05-28T23:00:00+09:00",
      durationMin: 60,
    });
    expect(result.routineLengthFixed).toBe(true);
    const moved = result.previewBoxes.find((b) => b.id === "routine:r1")!;
    expect(moved.block.endISO.startsWith("2026-05-29T00:00")).toBe(true);
  });

  it("routine-backed event top-resize: start clamps to occurrence 00:00, end preserved", () => {
    const boxes = computeLayout(
      [
        block("event:cal:e1", "2026-05-29T00:30:00+09:00", "2026-05-29T01:30:00+09:00", {
          routineId: "r1",
        }),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas-resize",
      edge: "top",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      calendarId: "cal",
      startISO: "2026-05-29T00:30:00+09:00",
      durationMin: 60,
      routineId: "r1",
    };
    // top -120px → would be prev-day 22:30, clamp to occurrence 05-29 00:00, end (01:30) preserved.
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: -120 },
    });
    expect(result.commit).toEqual({
      kind: "eventResize",
      eventId: "e1",
      calendarId: "cal",
      at: "2026-05-29T00:00:00+09:00",
      durationMin: 90,
      routineId: "r1",
      routineDate: "2026-05-29",
    });
    const moved = result.previewBoxes.find((b) => b.id === "event:cal:e1")!;
    expect(moved.block.startISO.startsWith("2026-05-29T00:00")).toBe(true);
    expect(moved.block.endISO.startsWith("2026-05-29T01:30")).toBe(true);
  });
});

describe("planTimelineDrag — no-op / off-grid", () => {
  it("zero movement resize → commit null (no-op snap back)", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
    };
    const result = plan({ boxes, activeDrag, drop: { to: "canvas" }, delta: { x: 0, y: 0 } });
    expect(result.commit).toBeNull();
  });

  it("off-grid release (release point outside rect, no droppable) → commit null", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: null, // no droppable
      delta: { x: 0, y: 120 },
      release: {
        point: { x: 9999, y: 9999 },
        rect: { left: 0, right: 500, top: 0, bottom: 800 },
      },
    });
    expect(result.commit).toBeNull();
    // preview still reflects the move (display-only), commit is suppressed.
    expect(result.previewBoxes.find((b) => b.id === "signal:s1")!.block.startISO).toBe(
      "2026-05-28T11:00:00+09:00",
    );
  });

  it("collision-miss (no droppable but pointer inside rect) is NOT off-grid → still commits", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    // Caller (Task 4.4) synthesizes drop:{to:canvas} when pointer is inside rect; planner commits.
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      delta: { x: 0, y: 120 },
      release: {
        point: { x: 100, y: 100 },
        rect: { left: 0, right: 500, top: 0, bottom: 800 },
      },
    });
    expect((result.commit as { at: string }).at).toBe("2026-05-28T11:00:00+09:00");
  });

  it("keyboard-style delta (release absent) still yields a commit from delta", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      delta: { x: 0, y: 60 }, // keyboard ArrowDown step
      release: null, // no pointer (keyboard drag)
    });
    expect((result.commit as { at: string }).at).toBe("2026-05-28T10:00:00+09:00");
  });
});

describe("planTimelineDrag — schedule / unschedule / moveCalendar / routineSchedule", () => {
  it("tray → canvas schedule: pixelToLocalIso for at, default 60m, no calendar picked", () => {
    const activeDrag: DragData = {
      from: "tray",
      signalId: "s1",
      title: "S1",
    };
    const result = plan({
      boxes: [],
      activeDrag,
      drop: { to: "canvas", gridY: 600 }, // 600px → 10:00
    });
    expect(result.commit).toEqual({
      kind: "schedule",
      targetSignalId: "s1",
      at: "2026-05-28T10:00:00+09:00",
      durationMin: 60,
      title: "S1",
    });
  });

  it("tray → canvas schedule honors tray durationMin override", () => {
    const activeDrag: DragData = {
      from: "tray",
      signalId: "s1",
      title: "S1",
      durationMin: 45,
    };
    const result = plan({ boxes: [], activeDrag, drop: { to: "canvas", gridY: 540 } });
    expect((result.commit as { durationMin: number }).durationMin).toBe(45);
  });

  it("canvas signal → tray unschedule (no linkedEventId)", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({ boxes, activeDrag, drop: { to: "tray" }, delta: { x: 0, y: 0 } });
    expect(result.commit).toEqual({
      kind: "unschedule",
      targetSignalId: "s1",
      fromDate: "2026-05-28",
      calendarId: "cal",
      linkedEventId: undefined,
    });
  });

  it("canvas signal → tray unschedule carries calendarId + linkedEventId when linked", () => {
    const boxes = computeLayout(
      [
        block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00", {
          linkedEventId: "goog-evt-42",
        }),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
      linkedEventId: "goog-evt-42",
    };
    const result = plan({ boxes, activeDrag, drop: { to: "tray" }, delta: { x: 0, y: 0 } });
    expect(result.commit).toEqual({
      kind: "unschedule",
      targetSignalId: "s1",
      fromDate: "2026-05-28",
      calendarId: "cal",
      linkedEventId: "goog-evt-42",
    });
  });

  it("canvas signal → canvas:cal moveCalendar (different calendar)", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas:cal", calendarId: "cal2" },
      delta: { x: 0, y: 120 }, // 09:00 → 11:00
    });
    expect(result.commit).toEqual({
      kind: "moveCalendar",
      targetSignalId: "s1",
      calendarId: "cal2",
      at: "2026-05-28T11:00:00+09:00",
      durationMin: 60,
      title: "S1",
    });
  });

  it("canvas signal → canvas:cal same calendar → no-op (commit null)", () => {
    const boxes = computeLayout(
      [block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "signal",
      blockId: "signal:s1",
      signalId: "s1",
      title: "S1",
      startISO: "2026-05-28T09:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas:cal", calendarId: "cal" },
      delta: { x: 0, y: 120 },
    });
    expect(result.commit).toBeNull();
  });

  it("routine → canvas routineSchedule: 30m, date derived from drop position", () => {
    const activeDrag: DragData = {
      from: "routine",
      routineId: "r1",
      title: "Routine",
    };
    const result = plan({
      boxes: [],
      activeDrag,
      drop: { to: "canvas", gridY: 600 }, // 10:00 same anchor day
    });
    expect(result.commit).toEqual({
      kind: "routineSchedule",
      routineId: "r1",
      date: "2026-05-28",
      at: "2026-05-28T10:00:00+09:00",
      durationMin: 30,
      title: "Routine",
    });
  });
});

describe("planTimelineDrag — guide parity", () => {
  it("move guide y == preview semantic top (event)", () => {
    const boxes = computeLayout(
      [block("event:cal:e1", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00")],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "Event",
      startISO: "2026-05-28T11:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    const result = plan({ boxes, activeDrag, drop: { to: "canvas" }, delta: { x: 20, y: -120 } });
    expect(result.guide).toMatchObject({ y: 9 * 60, durationMin: 60 });
  });

  it("routine move guide y clamps to occurrence date", () => {
    const boxes = computeLayout(
      [
        block("routine:r1", "2026-05-28T23:00:00+09:00", "2026-05-28T23:30:00+09:00", {
          routineId: "r1",
        }),
      ],
      ANCHOR,
    );
    const activeDrag: DragData = {
      from: "canvas",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };
    // topPx 1380 + 120 = 1500, clamp to [0, 1425] → 1425.
    const result = plan({
      boxes,
      activeDrag,
      drop: { to: "canvas" },
      days: 2,
      delta: { x: 0, y: 120 },
    });
    expect(result.guide!.y).toBe(1425);
  });

  it("guide is null for non-canvas drags (tray)", () => {
    const activeDrag: DragData = { from: "tray", signalId: "s1", title: "S1" };
    const result = plan({ boxes: [], activeDrag, drop: { to: "canvas", gridY: 0 } });
    expect(result.guide).toBeNull();
  });
});
