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
  const onSetKind = vi.fn();
  const onSetAreaTagKey = vi.fn();
  const onSelect = vi.fn();
  const onEditStart = vi.fn();
  act(() => {
    root?.render(
      <MatrixCanvas
        signals={[workSignal]}
        selectedId={null}
        poppedIds={new Set()}
        onSelect={onSelect}
        onClassify={vi.fn()}
        onPromoteToday={vi.fn()}
        onOpenMenu={vi.fn()}
        editingId={null}
        onEditStart={onEditStart}
        onEditCommit={vi.fn()}
        onEditCancel={vi.fn()}
        onEnrichAll={vi.fn()}
        onSetKind={onSetKind}
        onSetAreaTagKey={onSetAreaTagKey}
        lifeWheelTags={[]}
        enrichAllDisabled={false}
        enrichAllRunning={false}
        todayPanelRef={createRef<HTMLDivElement>()}
        onCapture={vi.fn()}
      />,
    );
  });
  return { onSetKind, onSetAreaTagKey, onSelect, onEditStart };
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

describe("MatrixCanvas card tag chips", () => {
  // happy-dom은 pointer capture retarget을 재현하지 못한다. 회귀 가드는 첫 두 테스트
  // ("칩 pointerdown → 드래그 시작 금지·선택 유지" / "본문 pointerdown → 드래그 시작")이고,
  // 나머지 click 테스트 2개는 칩→핸들러 배선 가드다.
  const pointerDown = (el: Element) => {
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
    });
  };
  const click = (el: HTMLElement) => {
    act(() => {
      el.click();
    });
  };

  it("selects the card without starting drag when pointerdown lands on a tag chip", () => {
    const { onSelect } = renderCanvas();
    const kindChip = container!.querySelector<HTMLButtonElement>(".postit-kind")!;
    const postit = container!.querySelector(".postit")!;

    pointerDown(kindChip);

    expect(postit.classList.contains("dragging")).toBe(false);
    expect(onSelect).toHaveBeenCalledWith("sig-1");
  });

  it("starts card drag when pointerdown lands on the card body", () => {
    renderCanvas();
    const body = container!.querySelector(".body")!;
    const postit = container!.querySelector(".postit")!;

    pointerDown(body);

    expect(postit.classList.contains("dragging")).toBe(true);
  });

  it("tears down the drag session on pointercancel", () => {
    renderCanvas();
    const postit = container!.querySelector(".postit")!;
    pointerDown(container!.querySelector(".body")!);
    expect(postit.classList.contains("dragging")).toBe(true);

    act(() => {
      postit.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
    });

    expect(postit.classList.contains("dragging")).toBe(false);
  });

  it("toggles kind when the kind chip is clicked", () => {
    const { onSetKind } = renderCanvas();
    const kindChip = container!.querySelector<HTMLButtonElement>(".postit-kind")!;

    click(kindChip);

    expect(onSetKind).toHaveBeenCalledWith("sig-1", "personal");
  });

  it("opens the life-wheel radial palette when the area chip is clicked", () => {
    renderCanvas();
    const areaChip = container!.querySelector<HTMLButtonElement>(".postit-area-button")!;

    click(areaChip);

    expect(container!.querySelector(".area-radial-layer")).not.toBeNull();
  });

  it("closes the radial palette with Escape before bubble-phase handlers (overlay contract)", () => {
    renderCanvas();
    click(container!.querySelector<HTMLButtonElement>(".postit-area-button")!);
    expect(container!.querySelector("[data-wr-overlay-open].area-radial-layer")).not.toBeNull();

    // capture 리스너가 stopPropagation으로 셸/보드(bubble) 핸들러 도달을 차단하는지까지 검증.
    const bubbleSpy = vi.fn();
    window.addEventListener("keydown", bubbleSpy);
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    window.removeEventListener("keydown", bubbleSpy);

    expect(container!.querySelector(".area-radial-layer.closing")).not.toBeNull();
    expect(bubbleSpy).not.toHaveBeenCalled();
  });

  it("ignores tag chip interactions on optimistic temp cards", () => {
    const { onSetKind } = renderCanvas(signal({ id: "optimistic:tmp" }));

    click(container!.querySelector<HTMLButtonElement>(".postit-kind")!);
    click(container!.querySelector<HTMLButtonElement>(".postit-area-button")!);

    expect(onSetKind).not.toHaveBeenCalled();
    expect(container!.querySelector(".area-radial-layer")).toBeNull();
  });
});

describe("MatrixCanvas title editing + inbox", () => {
  const dblclick = (el: Element) => {
    act(() => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
  };

  it("opens inline title edit from card double-click (card-level handler)", () => {
    const { onEditStart } = renderCanvas();

    dblclick(container!.querySelector(".postit .body")!);

    expect(onEditStart).toHaveBeenCalledWith("sig-1");
  });

  it("opens title edit when dblclick targets the card root (WKWebView capture retarget shape)", () => {
    const { onEditStart } = renderCanvas();

    dblclick(container!.querySelector(".postit")!);

    expect(onEditStart).toHaveBeenCalledWith("sig-1");
  });

  it("does not open title edit when double-click lands on a tag chip", () => {
    const { onEditStart } = renderCanvas();

    dblclick(container!.querySelector(".postit-kind")!);

    expect(onEditStart).not.toHaveBeenCalled();
  });

  it("does not open title edit on optimistic temp cards", () => {
    const { onEditStart } = renderCanvas(signal({ id: "optimistic:tmp" }));

    dblclick(container!.querySelector(".postit .body")!);

    expect(onEditStart).not.toHaveBeenCalled();
  });

  it("keeps the responsive .inbox class on the inbox column (CaptureBoard.css contract)", () => {
    renderCanvas();

    expect(container!.querySelector(".inbox-column.inbox")).not.toBeNull();
  });

  it("sizes the inbox well from item count at narrow widths (inboxRef wiring)", () => {
    const originalWidth = window.innerWidth;
    (window as { innerWidth: number }).innerWidth = 800;
    try {
      renderCanvas();

      const inbox = container!.querySelector<HTMLElement>(".inbox-column")!;
      expect(inbox.style.height).not.toBe("");
    } finally {
      (window as { innerWidth: number }).innerWidth = originalWidth;
    }
  });
});
