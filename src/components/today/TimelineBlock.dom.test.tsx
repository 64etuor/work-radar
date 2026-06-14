// @vitest-environment happy-dom
import { DndContext } from "@dnd-kit/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { LayoutBox } from "@/lib/timelineLayout";

import { TimelineBlock } from "./TimelineBlock";
import { dragDataForBox, resizeDataForBox } from "./timelineDragData";

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

function renderBlock(): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <DndContext>
        <TimelineBlock box={box()} onClick={() => {}} />
      </DndContext>,
    ),
  );
  return container;
}

describe("TimelineBlock keyboard/a11y", () => {
  it("renders both resize handles (top + bottom) on every block", () => {
    const el = renderBlock();
    expect(el.querySelectorAll(".tl-block-resize").length).toBe(2);
    expect(el.querySelector(".tl-block-resize-top")).not.toBeNull();
    expect(el.querySelector(".tl-block-resize-bottom")).not.toBeNull();
  });

  it("exposes aria-keyshortcuts on the block and handles", () => {
    const el = renderBlock();
    expect(el.querySelector(".tl-block")?.getAttribute("aria-keyshortcuts")).toContain("ArrowUp");
    expect(
      el.querySelector(".tl-block-resize-bottom")?.getAttribute("aria-keyshortcuts"),
    ).toContain("ArrowDown");
  });
});

function routineBox(linkedEventId?: string): LayoutBox {
  return {
    id: "routine:r1:2026-05-28",
    topPx: 0,
    heightPx: 60,
    leftPct: 0,
    widthPct: 100,
    block: {
      id: "routine:r1:2026-05-28",
      kind: "routine",
      title: "중국어 공부",
      startISO: "2026-05-28T20:45:00+09:00",
      endISO: "2026-05-28T21:45:00+09:00",
      calendarId: "work-cal",
      color: "#4a7bb8",
      routineId: "r1",
      linkedEventId,
    },
  };
}

// B1 회귀: 동기화 루틴(per-instance 미러 id 보유)은 event-backed로 드래그/리사이즈돼야 Google
// 인스턴스를 patch + 링크 adopt(write-back 보존). 미동기화는 routine path(로컬 미러).
describe("dragDataForBox / resizeDataForBox — synced routine write-back (B1)", () => {
  const INSTANCE = "master-1_20260528T043000Z";

  it("routes a synced routine (per-instance linkedEventId) through the event-backed path", () => {
    const drag = dragDataForBox(routineBox(INSTANCE), 60);
    if (drag.from !== "canvas" || drag.blockKind !== "event") {
      throw new Error("expected an event-backed canvas drag");
    }
    expect(drag.eventId).toBe(INSTANCE);
    expect(drag.routineId).toBe("r1");

    const rz = resizeDataForBox(routineBox(INSTANCE), "bottom", 60);
    if (rz.from !== "canvas-resize" || rz.blockKind !== "event") {
      throw new Error("expected an event-backed resize");
    }
    expect(rz.eventId).toBe(INSTANCE);
    expect(rz.routineId).toBe("r1");
  });

  it("routes an unsynced routine (no linkedEventId) through the routine path", () => {
    const drag = dragDataForBox(routineBox(undefined), 60);
    expect(drag.from === "canvas" && drag.blockKind).toBe("routine");
    const rz = resizeDataForBox(routineBox(undefined), "top", 60);
    expect(rz.from === "canvas-resize" && rz.blockKind).toBe("routine");
  });
});
