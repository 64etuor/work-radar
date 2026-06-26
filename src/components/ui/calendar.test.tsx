// @vitest-environment happy-dom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Calendar } from "./calendar";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function render(props: Partial<ComponentProps<typeof Calendar>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onSelect = vi.fn<(d: string) => void>();
  act(() => {
    root?.render(<Calendar selected={null} onSelect={onSelect} today="2026-06-15" {...props} />);
  });
  return { onSelect };
}

function cells(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>('[role="gridcell"]') ?? []);
}
function cell(date: string): HTMLButtonElement {
  const el = container?.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
  if (!el) throw new Error(`cell not found: ${date}`);
  return el;
}
function buttonByLabel(label: string): HTMLButtonElement {
  const el = container?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`button not found: ${label}`);
  return el;
}
function grid(): HTMLElement {
  const el = container?.querySelector<HTMLElement>('[role="grid"]');
  if (!el) throw new Error("grid not found");
  return el;
}
function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}
function keydown(el: Element, key: string) {
  act(() =>
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
  );
}

describe("Calendar", () => {
  it("renders 42 cells, weekday labels, and the today month label", () => {
    render({ today: "2026-06-15" });
    expect(cells().length).toBe(42);
    expect(container?.textContent).toContain("2026년 6월");
    for (const w of ["월", "화", "수", "목", "금", "토", "일"]) {
      expect(container?.textContent).toContain(w);
    }
  });

  it("marks selected (aria-selected) and today (aria-current)", () => {
    render({ selected: "2026-06-10", today: "2026-06-15" });
    expect(cell("2026-06-10").getAttribute("aria-selected")).toBe("true");
    expect(cell("2026-06-15").getAttribute("aria-current")).toBe("date");
  });

  it("clicking a day calls onSelect with its date", () => {
    const { onSelect } = render({ today: "2026-06-15" });
    click(cell("2026-06-20"));
    expect(onSelect).toHaveBeenCalledWith("2026-06-20");
  });

  it("prev/next buttons change the visible month", () => {
    render({ today: "2026-06-15" });
    click(buttonByLabel("다음 달"));
    expect(container?.textContent).toContain("2026년 7월");
    click(buttonByLabel("이전 달"));
    click(buttonByLabel("이전 달"));
    expect(container?.textContent).toContain("2026년 5월");
  });

  it("min/max disables out-of-range days (aria-disabled, click no-ops)", () => {
    const { onSelect } = render({ today: "2026-06-15", min: "2026-06-10", max: "2026-06-20" });
    expect(cell("2026-06-09").getAttribute("aria-disabled")).toBe("true");
    expect(cell("2026-06-21").getAttribute("aria-disabled")).toBe("true");
    expect(cell("2026-06-15").getAttribute("aria-disabled")).toBeNull();
    click(cell("2026-06-09"));
    expect(onSelect).not.toHaveBeenCalled();
    click(cell("2026-06-15"));
    expect(onSelect).toHaveBeenCalledWith("2026-06-15");
  });

  it("keyboard: ArrowRight then Enter selects next day; PageDown changes month", () => {
    const { onSelect } = render({ selected: "2026-06-15", today: "2026-06-15" });
    keydown(grid(), "ArrowRight");
    keydown(grid(), "Enter");
    expect(onSelect).toHaveBeenCalledWith("2026-06-16");
    keydown(grid(), "PageDown"); // 6/16 → 7/16
    expect(container?.textContent).toContain("2026년 7월");
  });
});
