// @vitest-environment happy-dom
import { DndContext } from "@dnd-kit/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { LayoutBox } from "@/lib/timelineLayout";

import { TimelineBlock } from "./TimelineBlock";

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
