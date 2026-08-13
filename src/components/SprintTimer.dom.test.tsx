// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SprintTimer } from "./SprintTimer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/query", () => ({
  useSprintConfig: () => ({
    data: {
      intervalDays: 14,
      anchorWeekday: "fri",
      anchorTime: "21:00",
      goal: "접근성 점검",
    },
  }),
  useSprintStatus: () => ({ data: { nextBoundary: "2026-08-27T21:00:00+09:00" } }),
  useSetSprintConfig: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
  useClearSprintConfig: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("@/lib/toast", () => ({
  useToastStore: () => ({ pushSuccess: vi.fn() }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T12:00:00+09:00"));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("SprintTimer focus restoration", () => {
  it("returns focus to the meter after Escape closes the editor", () => {
    act(() => root?.render(<SprintTimer />));
    const meter = container?.querySelector<HTMLButtonElement>(".sprint-meter");
    if (!meter) throw new Error("sprint meter not found");

    act(() => meter.click());
    act(() => vi.advanceTimersByTime(380));
    expect(container?.querySelector(".sprint-inline-editor")).not.toBeNull();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    act(() => vi.advanceTimersByTime(340));

    const restoredMeter = container?.querySelector<HTMLButtonElement>(".sprint-meter");
    expect(restoredMeter).not.toBeNull();
    expect(document.activeElement).toBe(restoredMeter);
  });
});
