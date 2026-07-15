// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useBoardKeyboard } from "./useBoardKeyboard";

type Callbacks = {
  onEscape: () => void;
  onClassify: (id: string, zone: "q1" | "q2" | "q3" | "q4" | "unclassified") => void;
  onPromoteToday: (id: string) => void;
  onSnooze: (id: string) => void;
  onDone: (id: string) => void;
  onArchive: (id: string) => void;
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function Harness({ selectedId, callbacks }: { selectedId: string | null; callbacks: Callbacks }) {
  useBoardKeyboard({ selectedId, ...callbacks });
  return <input aria-label="editor" />;
}

function renderHarness(selectedId: string | null, callbacks: Callbacks) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness selectedId={selectedId} callbacks={callbacks} />));
}

function callbacks(): Callbacks {
  return {
    onEscape: vi.fn(),
    onClassify: vi.fn(),
    onPromoteToday: vi.fn(),
    onSnooze: vi.fn(),
    onDone: vi.fn(),
    onArchive: vi.fn(),
  };
}

describe("useBoardKeyboard", () => {
  it("routes decision keys to the selected signal", () => {
    const handlers = callbacks();
    renderHarness("signal-1", handlers);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "e", cancelable: true }));

    expect(handlers.onClassify).toHaveBeenCalledWith("signal-1", "q1");
    expect(handlers.onPromoteToday).toHaveBeenCalledWith("signal-1");
    expect(handlers.onSnooze).toHaveBeenCalledWith("signal-1");
    expect(handlers.onDone).toHaveBeenCalledWith("signal-1");
    expect(handlers.onArchive).toHaveBeenCalledWith("signal-1");
  });

  it("reads the latest callbacks without rebinding and ignores actions while editing", () => {
    const first = callbacks();
    const latest = callbacks();
    renderHarness("signal-1", first);

    act(() => root?.render(<Harness selectedId="signal-2" callbacks={latest} />));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", cancelable: true }));

    expect(first.onPromoteToday).not.toHaveBeenCalled();
    expect(latest.onPromoteToday).toHaveBeenCalledWith("signal-2");

    container?.querySelector("input")?.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

    expect(latest.onPromoteToday).toHaveBeenCalledTimes(1);
    expect(latest.onEscape).toHaveBeenCalledTimes(1);
  });
});
