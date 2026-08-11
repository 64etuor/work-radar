// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useListReorder } from "./useListReorder";

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

function List({ onReorder }: { onReorder: (ids: string[]) => void }) {
  const dnd = useListReorder(["a", "b"], onReorder);
  return (
    <div>
      {["a", "b"].map((id) => (
        <div {...dnd.itemProps(id)} key={id} data-id={id}>
          <span {...dnd.handleProps(id)} data-handle={id}>
            ⠿
          </span>
        </div>
      ))}
    </div>
  );
}

function renderList() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onReorder = vi.fn();
  act(() => {
    root?.render(<List onReorder={onReorder} />);
  });
  return { onReorder };
}

describe("useListReorder pointercancel", () => {
  it("resets drag state without committing a reorder when the pointer is cancelled", () => {
    const { onReorder } = renderList();
    const handle = container!.querySelector<HTMLElement>("[data-handle='a']")!;
    const item = container!.querySelector<HTMLElement>("[data-id='a']")!;

    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
      );
    });
    expect(item.hasAttribute("data-dragging")).toBe(true);

    act(() => {
      handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientY: 40 }));
    });
    act(() => {
      handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    });

    // 유령 드래그 상태(data-dragging/transform)가 남지 않고, 순서 반영도 없어야 한다.
    expect(item.hasAttribute("data-dragging")).toBe(false);
    expect(item.style.transform).toBe("");
    expect(onReorder).not.toHaveBeenCalled();
  });
});
