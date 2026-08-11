// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OVERLAY_OPEN_ATTR } from "@/components/ui/overlay-stack";

import { BrainDumpToggle } from "./BrainDumpToggle";

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

function renderToggle(props: { disabled?: boolean } = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onSubmit = vi.fn();
  act(() => {
    root?.render(<BrainDumpToggle onSubmit={onSubmit} disabled={props.disabled} />);
  });
  return { onSubmit };
}

function state() {
  return container?.querySelector(".brain-dump-toggle")?.getAttribute("data-state");
}

describe("BrainDumpToggle DOM behavior", () => {
  it("opens from global Enter when no overlay owns focus", () => {
    renderToggle();
    expect(state()).toBe("closed");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    });

    expect(state()).toBe("open");
  });

  it("does not steal Enter from a focused button", () => {
    renderToggle();
    expect(state()).toBe("closed");
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    act(() => {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(state()).toBe("closed");
  });

  it("does not capture Enter while another overlay dialog is open", () => {
    renderToggle();
    expect(state()).toBe("closed");

    const overlay = document.createElement("div");
    overlay.setAttribute(OVERLAY_OPEN_ATTR, "");
    const confirmButton = document.createElement("button");
    confirmButton.textContent = "전체 accept (확정)";
    overlay.appendChild(confirmButton);
    document.body.appendChild(overlay);
    confirmButton.focus();

    act(() => {
      confirmButton.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(state()).toBe("closed");
  });

  it("does not submit from Enter while disabled (same rule as the submit button)", () => {
    const { onSubmit } = renderToggle({ disabled: true });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    });
    expect(state()).toBe("open");

    const input = container!.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setValue.call(input, "메모");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
