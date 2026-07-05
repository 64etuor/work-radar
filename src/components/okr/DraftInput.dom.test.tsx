// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DraftInput } from "./DraftInput";

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

function render(value: string, onCommit: (next: string) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<DraftInput value={value} onCommit={onCommit} aria-label="draft" />);
  });
  return container.querySelector("input") as HTMLInputElement;
}

function type(input: HTMLInputElement, next: string) {
  act(() => {
    input.focus();
  });
  act(() => {
    // React 제어 입력 — native setter로 값 넣고 input 이벤트 발사.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DraftInput commit contract", () => {
  it("blur 시 변경된 draft를 커밋한다", () => {
    const onCommit = vi.fn();
    const input = render("10", onCommit);
    type(input, "25");
    act(() => {
      input.blur();
    });
    expect(onCommit).toHaveBeenCalledWith("25");
  });

  it("변경 없으면 blur에 커밋하지 않는다", () => {
    const onCommit = vi.fn();
    const input = render("10", onCommit);
    act(() => {
      input.focus();
    });
    act(() => {
      input.blur();
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Esc는 draft를 폐기하고 커밋하지 않는다", () => {
    const onCommit = vi.fn();
    const input = render("10", onCommit);
    type(input, "99");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    act(() => {
      input.blur();
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("10");
  });

  it("Enter는 blur를 유발해 커밋한다", () => {
    const onCommit = vi.fn();
    const input = render("10", onCommit);
    type(input, "42");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(onCommit).toHaveBeenCalledWith("42");
  });
});
