// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkSignal } from "@/bindings";

import { MatrixCanvas } from "./MatrixCanvas";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function signal(overrides: Partial<WorkSignal> = {}): WorkSignal {
  return {
    id: "sig-1",
    projectId: null,
    title: "대표님 요청 자료 긴급 정리",
    body: null,
    source: "braindump",
    type: "thought",
    quadrant: "unclassified",
    suggestedQuadrant: "q1_do_now",
    kind: "work",
    area: null,
    areaTags: null,
    suggestedArea: "work",
    status: "new",
    snoozeUntil: null,
    todayForDate: null,
    todayDoneAt: null,
    todayRank: null,
    impactHigh: null,
    regret: null,
    scheduledAt: null,
    scheduledDuration: null,
    linkedEventId: null,
    linkedCalendarId: null,
    createdAt: "2026-07-07 09:00:00",
    updatedAt: "2026-07-07 09:00:00",
    ...overrides,
  };
}

function renderCanvas(workSignal = signal()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MatrixCanvas
        signals={[workSignal]}
        selectedId={null}
        poppedIds={new Set()}
        onSelect={vi.fn()}
        onClassify={vi.fn()}
        onPromoteToday={vi.fn()}
        onOpenMenu={vi.fn()}
        editingId={null}
        onEditStart={vi.fn()}
        onEditCommit={vi.fn()}
        onEditCancel={vi.fn()}
        onEnrichAll={vi.fn()}
        onSetKind={vi.fn()}
        onSetAreaTagKey={vi.fn()}
        lifeWheelTags={[]}
        enrichAllDisabled={false}
        enrichAllRunning={false}
        todayPanelRef={createRef<HTMLDivElement>()}
        onCapture={vi.fn()}
      />,
    );
  });
}

describe("MatrixCanvas card hints", () => {
  it("does not render suggested quadrant or area hint chips on braindump cards", () => {
    renderCanvas();

    expect(container?.textContent).not.toContain("Q1?");
    expect(container?.textContent).not.toContain("업무?");
  });

  it("does not render OKR badges on braindump cards with area tags", () => {
    renderCanvas(signal({ area: "work", areaTags: '["work"]' }));

    expect(container?.textContent).not.toContain("OKR");
  });
});
