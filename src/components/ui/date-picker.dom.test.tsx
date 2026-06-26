// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { isOverlayOpen } from "@/components/ui/overlay-stack";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import { DatePicker } from "./date-picker";

beforeAll(installRadixHappyDomShim);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function setup(value: string | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onChange = vi.fn<(d: string | null) => void>();
  act(() => root?.render(<DatePicker value={value} onChange={onChange} />));
  return { onChange };
}

function trigger(): HTMLButtonElement {
  const el = container?.querySelector<HTMLButtonElement>("[data-date-picker-trigger]");
  if (!el) throw new Error("trigger not found");
  return el;
}
/** PopoverContent는 portal로 body에 렌더 → document 전체에서 찾는다. */
function dayCell(date: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-date="${date}"]`);
}
function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

describe("DatePicker", () => {
  it("shows placeholder when empty", () => {
    setup(null);
    expect(trigger().textContent).toBe("날짜");
  });

  it("shows the value formatted as YYYY.MM.DD", () => {
    setup("2026-06-15");
    expect(trigger().textContent).toBe("2026.06.15");
  });

  it("opens on trigger click; picking a day calls onChange and closes", () => {
    const { onChange } = setup("2026-06-15");
    expect(dayCell("2026-06-20")).toBeNull(); // 닫힘
    click(trigger());
    const c = dayCell("2026-06-20");
    expect(c).not.toBeNull(); // 열림 — June 그리드(selected 월)
    click(c!);
    expect(onChange).toHaveBeenCalledWith("2026-06-20");
    expect(dayCell("2026-06-20")).toBeNull(); // 선택 후 닫힘
  });

  it("focuses the selected day cell on open (keyboard-first, not the prev-month button)", () => {
    setup("2026-06-15");
    click(trigger());
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-06-15");
  });

  it("clear button calls onChange(null)", () => {
    const { onChange } = setup("2026-06-15");
    click(trigger());
    const clearBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "지우기",
    );
    expect(clearBtn).toBeTruthy();
    click(clearBtn!);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  // 회귀 잠금: 보드 표면의 popover에서 Esc가 window까지 버블되면 App 셸의 getCurrentWindow().hide()
  // (또는 비board navigate)가 깨어난다. PopoverContent가 Esc를 stopPropagation해야 한다.
  it("Esc closes the popover and does NOT bubble to window (App shell never reacts)", () => {
    setup("2026-06-15");
    click(trigger());
    expect(isOverlayOpen()).toBe(true);

    const winEscSpy = vi.fn();
    const onWin = (e: KeyboardEvent) => {
      if (e.key === "Escape") winEscSpy();
    };
    window.addEventListener("keydown", onWin);
    try {
      const active = (document.activeElement ?? document.body) as Element;
      act(() => {
        active.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
    } finally {
      window.removeEventListener("keydown", onWin);
    }

    // Radix가 Esc로 popover를 닫았고(마커 사라짐) 그 Esc는 window까지 전파되지 않았다.
    expect(isOverlayOpen()).toBe(false);
    expect(winEscSpy).not.toHaveBeenCalled();
  });
});
