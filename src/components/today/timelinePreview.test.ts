import { describe, expect, it } from "vitest";

import { computeLayout, type TimedBlock } from "@/lib/timelineLayout";

import {
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
