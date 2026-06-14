import { describe, expect, it } from "vitest";

import { computeLayout, type TimedBlock } from "@/lib/timelineLayout";

import {
  activeDragLabel,
  activeDragWouldOverlap,
  clientPointToGridGuide,
  dragGuideFromLayout,
  previewTimelineBoxes,
  renderTimelineBoxesForDrag,
} from "./timelinePreview";
import type { DragData } from "./useTimelineDnd";

function block(id: string, startISO: string, endISO: string): TimedBlock {
  return {
    id,
    kind: id.startsWith("signal:") ? "signal" : "event",
    title: id,
    startISO,
    endISO,
    calendarId: "cal",
    color: "#4a7bb8",
  };
}

describe("previewTimelineBoxes", () => {
  it("shrinks neighboring blocks while a dragged block previews an overlap", () => {
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

    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: -120 },
      anchorDate: "2026-05-28",
      days: 1,
    });

    expect(preview.find((b) => b.id === "signal:s1")!.widthPct).toBe(50);
    expect(preview.find((b) => b.id === "event:cal:e1")!.widthPct).toBe(50);
  });

  it("renders the actively moved block at its snapped preview position (no raw-transform substitution, Bug 2a)", () => {
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
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: -120 },
      anchorDate: "2026-05-28",
      days: 1,
    });

    const renderBoxes = renderTimelineBoxesForDrag({ previewBoxes: preview });

    // 이동된 active 블록은 스냅된 09:00 위치(topPx 540)로 렌더되며, 09:00 시그널과 겹쳐 둘 다 50%.
    // (과거엔 원본 11:00 위치 + widthPct 100으로 되돌리고 raw transform이 커서를 따라갔다.)
    expect(renderBoxes.find((b) => b.id === "signal:s1")!.widthPct).toBe(50);
    expect(renderBoxes.find((b) => b.id === "event:cal:e1")!.topPx).toBe(9 * 60);
    expect(renderBoxes.find((b) => b.id === "event:cal:e1")!.widthPct).toBe(50);
  });

  it("derives a stable guide from dnd delta when canvas pointermove is missing", () => {
    const boxes = computeLayout([
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

    const guide = dragGuideFromLayout({
      boxes,
      activeDrag: drag,
      delta: { x: 20, y: -120 },
      gridWidth: 460,
      days: 1,
    });

    expect(guide).toMatchObject({
      y: 9 * 60,
      durationMin: 60,
    });
    expect(guide!.x).toBeGreaterThan(60);
  });

  it("루틴 이동 가이드 y는 occurrence 날짜 안으로 클램프된다 (가이드==착지 엣지, Bug 2c)", () => {
    const routineBox: TimedBlock = {
      id: "routine:r1",
      kind: "routine",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      endISO: "2026-05-28T23:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([routineBox], "2026-05-28");
    const drag: DragData = {
      from: "canvas",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };

    // topPx 1380 + 120 = 1500(다음 날 01:00)이지만 occurrence day [0, 1425]로 클램프 → 1425.
    const guide = dragGuideFromLayout({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      gridWidth: 460,
      days: 2,
    });
    expect(guide!.y).toBe(1425);
  });

  it("루틴 이동 가이드 클램프는 occurrence가 day 2일 때도 px-day에서 유도된다 (topPx≥1440)", () => {
    // 루틴이 2026-05-29(day 1, anchor 05-28 기준 topPx=2820) 23:00에 있다.
    const routineBox: TimedBlock = {
      id: "routine:r1",
      kind: "routine",
      title: "Routine",
      startISO: "2026-05-29T23:00:00+09:00",
      endISO: "2026-05-29T23:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([routineBox], "2026-05-28");
    const drag: DragData = {
      from: "canvas",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      title: "Routine",
      startISO: "2026-05-29T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };

    // topPx 2820 + 120 = 2940(day 2 01:00)이지만 occurrence day [1440, 2865]로 클램프 → 2865
    // ([0,1425]가 아니라 dayStart=1440 기준이어야 한다).
    const guide = dragGuideFromLayout({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      gridWidth: 460,
      days: 3,
    });
    expect(guide!.y).toBe(2865);
  });

  it("루틴 bottom-resize 가이드는 끝 엣지가 자정을 넘지 못한다 (가이드==preview/commit, Bug 2c)", () => {
    const routineBox: TimedBlock = {
      id: "routine:r1",
      kind: "routine",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      endISO: "2026-05-28T23:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([routineBox], "2026-05-28");
    const drag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
    };

    // 끝 엣지 raw = topPx 1380 + height 30 + 120 = 1530(다음 날 01:30)이지만 자정(1440)에서 멈춘다.
    const guide = dragGuideFromLayout({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      gridWidth: 460,
      days: 2,
    });
    expect(guide!.y).toBe(1440);
  });

  it("canvas 드래그가 자정을 넘기면 preview 블록의 날짜가 증가한다 (연속 축)", () => {
    const boxes = computeLayout(
      [block("event:cal:e1", "2026-05-28T23:00:00+09:00", "2026-05-28T23:30:00+09:00")],
      "2026-05-28",
    );
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:e1",
      eventId: "e1",
      title: "Event",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };

    // +120px = +2h → 다음 날 01:00 시작.
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      anchorDate: "2026-05-28",
      days: 2,
    });

    const moved = preview.find((b) => b.id === "event:cal:e1")!;
    expect(moved.block.startISO.startsWith("2026-05-29T01:00")).toBe(true);
    expect(moved.topPx).toBe(1440 + 60);
  });

  it("루틴 블록은 자정을 넘기려 해도 occurrence 날짜 안으로 클램프된다 (preview==commit, Bug 2c)", () => {
    const routineBox: TimedBlock = {
      id: "routine:r1",
      kind: "routine",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      endISO: "2026-05-28T23:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([routineBox], "2026-05-28");
    const drag: DragData = {
      from: "canvas",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
      calendarId: "cal",
    };

    // +120px = +2h → commit이라면 다음 날 01:00이지만 루틴은 같은 날 23:45로 클램프(끝=자정).
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      anchorDate: "2026-05-28",
      days: 2,
    });

    const moved = preview.find((b) => b.id === "routine:r1")!;
    expect(moved.block.startISO.startsWith("2026-05-28T23:45")).toBe(true);
    // 다음 날로 새지 않는다.
    expect(moved.block.startISO.startsWith("2026-05-29")).toBe(false);
  });

  it("루틴-backed 이벤트(routineId 동봉)도 같은 클램프를 따른다 (Bug 2c)", () => {
    const eventBox: TimedBlock = {
      id: "event:cal:e1",
      kind: "event",
      title: "Routine event",
      startISO: "2026-05-28T23:00:00+09:00",
      endISO: "2026-05-28T23:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([eventBox], "2026-05-28");
    const drag: DragData = {
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

    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      anchorDate: "2026-05-28",
      days: 2,
    });

    const moved = preview.find((b) => b.id === "event:cal:e1")!;
    expect(moved.block.startISO.startsWith("2026-05-28T23:45")).toBe(true);
    expect(moved.block.startISO.startsWith("2026-05-29")).toBe(false);
  });

  it("루틴 bottom-resize는 끝이 자정을 넘지 못한다 (preview==commit resize 분기, Bug 2c)", () => {
    const routineBox: TimedBlock = {
      id: "routine:r1",
      kind: "routine",
      title: "Routine",
      startISO: "2026-05-28T23:00:00+09:00",
      endISO: "2026-05-28T23:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([routineBox], "2026-05-28");
    const drag: DragData = {
      from: "canvas-resize",
      edge: "bottom",
      blockKind: "routine",
      blockId: "routine:r1",
      routineId: "r1",
      startISO: "2026-05-28T23:00:00+09:00",
      durationMin: 30,
    };

    // +120px = 끝을 01:30(다음 날)까지 늘리려 하지만 루틴은 자정에서 멈춘다.
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: 120 },
      anchorDate: "2026-05-28",
      days: 2,
    });

    const moved = preview.find((b) => b.id === "routine:r1")!;
    expect(moved.block.startISO.startsWith("2026-05-28T23:00")).toBe(true);
    expect(moved.block.endISO.startsWith("2026-05-29T00:00")).toBe(true);
    expect(moved.block.endISO.startsWith("2026-05-29T01:30")).toBe(false);
  });

  it("magnet beats grid within threshold (lands on neighbor edge)", () => {
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
    // 660-58=602 → grid 600; e1 end 600 is within 6 → magnet 600.
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: -58 },
      anchorDate: "2026-05-28",
      days: 1,
    });
    expect(preview.find((b) => b.id === "event:cal:e2")!.topPx).toBe(600);
  });

  it("grid wins when no neighbor edge is within threshold", () => {
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
    // 660-52=608 → grid 615 (10:15); e1 end 600 is 15 away (>6) → grid wins.
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: -52 },
      anchorDate: "2026-05-28",
      days: 1,
    });
    expect(preview.find((b) => b.id === "event:cal:e2")!.topPx).toBe(615);
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

  it("루틴-backed 이벤트 top-resize는 시작이 occurrence 날짜를 벗어나지 못한다 (Bug 2c)", () => {
    const eventBox: TimedBlock = {
      id: "event:cal:e1",
      kind: "event",
      title: "Routine event",
      startISO: "2026-05-29T00:30:00+09:00",
      endISO: "2026-05-29T01:30:00+09:00",
      calendarId: "cal",
      color: "#4a7bb8",
      routineId: "r1",
    };
    const boxes = computeLayout([eventBox], "2026-05-28");
    const drag: DragData = {
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

    // top을 -120px(전날 22:30) 끌어올려도 occurrence(05-29) 00:00에서 멈추고 끝(01:30)은 보존.
    const preview = previewTimelineBoxes({
      boxes,
      activeDrag: drag,
      delta: { x: 0, y: -120 },
      anchorDate: "2026-05-28",
      days: 2,
    });

    const moved = preview.find((b) => b.id === "event:cal:e1")!;
    expect(moved.block.startISO.startsWith("2026-05-29T00:00")).toBe(true);
    expect(moved.block.startISO.startsWith("2026-05-28")).toBe(false);
    expect(moved.block.endISO.startsWith("2026-05-29T01:30")).toBe(true);
  });
});

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

  it("is false when there is no active drag", () => {
    expect(
      activeDragWouldOverlap({
        boxes,
        activeDrag: null,
        delta: { x: 0, y: 0 },
        anchorDate: "2026-05-28",
        days: 1,
      }),
    ).toBe(false);
  });

  it("is false when the dragged block id is not in the layout", () => {
    const ghost: DragData = {
      from: "canvas",
      blockKind: "event",
      blockId: "event:cal:missing",
      eventId: "missing",
      title: "Missing",
      startISO: "2026-05-28T11:00:00+09:00",
      durationMin: 60,
      calendarId: "cal",
    };
    expect(
      activeDragWouldOverlap({
        boxes,
        activeDrag: ghost,
        delta: { x: 0, y: 0 },
        anchorDate: "2026-05-28",
        days: 1,
      }),
    ).toBe(false);
  });
});

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

  it("threads snapMin so the pill matches the fine-snapped block under Alt (Major B regression)", () => {
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
    const at = (snapMin?: number) =>
      activeDragLabel({
        boxes,
        activeDrag: drag,
        delta: { x: 0, y: 7 },
        anchorDate: "2026-05-28",
        days: 1,
        snapMin,
      })?.startHHMM;
    // +7px → default 15-grid rounds to 09:00, but Alt fine-snap (snapMin 5) → 09:05.
    expect(at(undefined)).toBe("09:00");
    expect(at(5)).toBe("09:05");
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

describe("clientPointToGridGuide", () => {
  const rect = { left: 100, top: 50, width: 460 };

  it("converts viewport client coords to grid-local (크로스헤어가 커서를 따른다)", () => {
    expect(clientPointToGridGuide({ x: 300, y: 250 }, rect, 1440)).toEqual({ x: 200, y: 200 });
  });

  it("clamps x into the [60px hour-gutter, rect width] range", () => {
    // 110-100=10 → 60px 거터로 클램프.
    expect(clientPointToGridGuide({ x: 110, y: 100 }, rect, 1440).x).toBe(60);
    // 폭 초과 → rect.width.
    expect(clientPointToGridGuide({ x: 9999, y: 100 }, rect, 1440).x).toBe(460);
  });

  it("clamps y into [0, totalPx]", () => {
    // 40-50=-10 → 0.
    expect(clientPointToGridGuide({ x: 300, y: 40 }, rect, 1440).y).toBe(0);
    expect(clientPointToGridGuide({ x: 300, y: 99999 }, rect, 1440).y).toBe(1440);
  });
});
