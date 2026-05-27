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
      block("event:e1", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
    ]);
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
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
      date: "2026-05-28",
    });

    expect(preview.find((b) => b.id === "signal:s1")!.widthPct).toBe(50);
    expect(preview.find((b) => b.id === "event:e1")!.widthPct).toBe(50);
  });

  it("keeps the actively moved block at its original layout so dnd transform follows the cursor", () => {
    const boxes = computeLayout([
      block("signal:s1", "2026-05-28T09:00:00+09:00", "2026-05-28T10:00:00+09:00"),
      block("event:e1", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
    ]);
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
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
      date: "2026-05-28",
    });

    const renderBoxes = renderTimelineBoxesForDrag({
      boxes,
      previewBoxes: preview,
      activeDrag: drag,
    });

    expect(renderBoxes.find((b) => b.id === "signal:s1")!.widthPct).toBe(50);
    expect(renderBoxes.find((b) => b.id === "event:e1")!.topPx).toBe(
      boxes.find((b) => b.id === "event:e1")!.topPx,
    );
    expect(renderBoxes.find((b) => b.id === "event:e1")!.widthPct).toBe(100);
  });

  it("derives a stable guide from dnd delta when canvas pointermove is missing", () => {
    const boxes = computeLayout([
      block("event:e1", "2026-05-28T11:00:00+09:00", "2026-05-28T12:00:00+09:00"),
    ]);
    const drag: DragData = {
      from: "canvas",
      blockKind: "event",
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
    });

    expect(guide).toMatchObject({
      y: 9 * 60,
      durationMin: 60,
    });
    expect(guide!.x).toBeGreaterThan(60);
  });
});
