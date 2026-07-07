// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyResult, RoutineTrackingItem } from "@/bindings";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import { RoutineLinkControl } from "./RoutineLinkControl";

const mocks = vi.hoisted(() => ({
  createRoutineMutate: vi.fn(),
  createRoutineMutateAsync: vi.fn(),
  setRoutineMutate: vi.fn(),
  setRoutineMutateAsync: vi.fn(),
  routines: [] as RoutineTrackingItem[],
}));

vi.mock("@/lib/query", () => ({
  localToday: () => "2026-07-07",
  useCreateRoutine: () => ({
    isPending: false,
    mutate: mocks.createRoutineMutate,
    mutateAsync: mocks.createRoutineMutateAsync,
  }),
  useRoutineTracking: () => ({
    data: mocks.routines,
  }),
  useSetKeyResultRoutine: () => ({
    isPending: false,
    mutate: mocks.setRoutineMutate,
    mutateAsync: mocks.setRoutineMutateAsync,
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(installRadixHappyDomShim);

beforeEach(() => {
  mocks.createRoutineMutate.mockReset();
  mocks.createRoutineMutateAsync.mockReset();
  mocks.createRoutineMutateAsync.mockResolvedValue({ id: "routine-new" });
  mocks.setRoutineMutate.mockReset();
  mocks.setRoutineMutateAsync.mockReset();
  mocks.setRoutineMutateAsync.mockResolvedValue(undefined);
  mocks.routines = [routine({ id: "routine-existing", title: "운동 루틴" })];
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function routine(over: Partial<RoutineTrackingItem> = {}): RoutineTrackingItem {
  return {
    id: "routine-1",
    title: "기본 루틴",
    freq: "daily",
    area: null,
    areaTags: null,
    kind: null,
    done: 0,
    due: 1,
    ratePct: 0,
    streak: 0,
    history: [],
    ...over,
  };
}

function kr(over: Partial<KeyResult> = {}): KeyResult {
  return {
    id: "kr-1",
    objectiveId: "obj-1",
    title: "주 3회 운동",
    kind: "metric",
    currentValue: 0,
    targetValue: 12,
    unit: "회",
    milestones: [],
    sortRank: 0,
    routineId: null,
    routine: null,
    progress: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  } as KeyResult;
}

function render(props: Partial<React.ComponentProps<typeof RoutineLinkControl>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <RoutineLinkControl
        kr={props.kr ?? kr()}
        quarterStart={props.quarterStart ?? "2026-07-01"}
        quarterEnd={props.quarterEnd ?? "2026-09-30"}
      />,
    );
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const btn = Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.trim().includes(text),
  );
  if (!btn) throw new Error(`button not found: ${text}`);
  return btn as HTMLButtonElement;
}

function setInputValue(el: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  desc?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm() {
  const form = document.querySelector("form");
  if (!form) throw new Error("form not found");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("RoutineLinkControl shared routine modal", () => {
  it("opens a Dialog-backed shared routine modal", () => {
    render();
    click(buttonByText("루틴으로 자동화"));
    expect(document.querySelector('[role="dialog"]')).toBeTruthy();
    expect(document.querySelector(".wr-dialog-overlay")).toBeNull();
    expect(document.querySelector("[data-cb-routine-title]")).toBeTruthy();
  });

  it("keeps OKR modal width fixed while allowing it to grow vertically", () => {
    mocks.routines = [
      routine({ id: "routine-1", title: "운동" }),
      routine({ id: "routine-2", title: "독서" }),
      routine({ id: "routine-3", title: "회고" }),
      routine({ id: "routine-4", title: "정리" }),
    ];
    render();
    click(buttonByText("루틴으로 자동화"));
    const modal = document.querySelector<HTMLElement>("[data-routine-modal-content]");
    expect(modal?.style.getPropertyValue("--routine-modal-width")).toBe("400px");
    expect(modal?.style.getPropertyValue("--routine-modal-max-height")).toBe("800px");
    expect(document.querySelector(".mission-routine-list")?.textContent).toContain("정리");
  });

  it("links an existing routine to the key result", () => {
    render();
    click(buttonByText("루틴으로 자동화"));
    click(buttonByText("운동 루틴"));
    expect(mocks.setRoutineMutateAsync).toHaveBeenCalledWith({
      id: "kr-1",
      routineId: "routine-existing",
    });
  });

  it("unlinks an existing routine", () => {
    render({ kr: kr({ routineId: "routine-existing", routine: { title: "운동 루틴" } as never }) });
    click(buttonByText("운동 루틴"));
    click(buttonByText("연결 해제"));
    expect(mocks.setRoutineMutateAsync).toHaveBeenCalledWith({
      id: "kr-1",
      routineId: null,
    });
  });

  it("creates a quarter-bounded routine and links it to the key result", async () => {
    render();
    click(buttonByText("루틴으로 자동화"));
    const title = document.querySelector<HTMLInputElement>("[data-cb-routine-title]");
    expect(title?.value).toBe("주 3회 운동");
    if (!title) throw new Error("title input not found");
    setInputValue(title, "운동 루틴");
    await submitForm();
    expect(mocks.createRoutineMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "운동 루틴",
        startDate: "2026-07-01",
        endDate: "2026-09-30",
      }),
    );
    expect(mocks.setRoutineMutateAsync).toHaveBeenCalledWith({
      id: "kr-1",
      routineId: "routine-new",
    });
  });
});
