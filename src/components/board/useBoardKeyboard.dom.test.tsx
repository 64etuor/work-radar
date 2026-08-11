// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBoardKeyboard } from "./useBoardKeyboard";

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

function Harness({ onClassify }: { onClassify: (id: string, zone: string) => void }) {
  useBoardKeyboard({
    selectedId: "sig-1",
    onEscape: vi.fn(),
    onClassify,
    onPromoteToday: vi.fn(),
    onSnooze: vi.fn(),
    onDone: vi.fn(),
    onArchive: vi.fn(),
  });
  return null;
}

function renderHarness() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onClassify = vi.fn();
  act(() => {
    root?.render(<Harness onClassify={onClassify} />);
  });
  return { onClassify };
}

const press = (key: string) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
  });
};

describe("useBoardKeyboard × life-wheel palette", () => {
  it("classifies the selected card with number keys when no palette is open", () => {
    const { onClassify } = renderHarness();

    press("1");

    expect(onClassify).toHaveBeenCalledWith("sig-1", "q1");
  });

  it("suspends board shortcuts while the radial palette is open", () => {
    const { onClassify } = renderHarness();
    const layer = document.createElement("div");
    layer.className = "area-radial-layer";
    document.body.appendChild(layer);

    press("1");

    expect(onClassify).not.toHaveBeenCalled();
  });

  it("restores shortcuts once the palette is in its closing (exit) phase", () => {
    const { onClassify } = renderHarness();
    const layer = document.createElement("div");
    layer.className = "area-radial-layer closing";
    document.body.appendChild(layer);

    press("1");

    expect(onClassify).toHaveBeenCalledWith("sig-1", "q1");
  });
});
