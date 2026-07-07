// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LifeWheelTagConfig, MissionHorizon, OkrGuardrail } from "@/bindings";

import { GuardrailPanel } from "./GuardrailPanel";
import { HorizonShelf } from "./HorizonShelf";

const mocks = vi.hoisted(() => ({
  createHorizonMutateAsync: vi.fn(),
  updateHorizonMutateAsync: vi.fn(),
  deleteHorizonMutate: vi.fn(),
  upsertGuardrailMutateAsync: vi.fn(),
  deleteGuardrailMutate: vi.fn(),
}));

vi.mock("@/lib/query", () => ({
  useCreateMissionHorizon: () => ({
    isPending: false,
    mutateAsync: mocks.createHorizonMutateAsync,
  }),
  useUpdateMissionHorizon: () => ({
    isPending: false,
    mutateAsync: mocks.updateHorizonMutateAsync,
  }),
  useDeleteMissionHorizon: () => ({
    isPending: false,
    mutate: mocks.deleteHorizonMutate,
  }),
  useUpsertGuardrail: () => ({
    isPending: false,
    mutateAsync: mocks.upsertGuardrailMutateAsync,
  }),
  useDeleteGuardrail: () => ({
    isPending: false,
    mutate: mocks.deleteGuardrailMutate,
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.createHorizonMutateAsync.mockReset();
  mocks.updateHorizonMutateAsync.mockReset();
  mocks.deleteHorizonMutate.mockReset();
  mocks.upsertGuardrailMutateAsync.mockReset();
  mocks.deleteGuardrailMutate.mockReset();
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

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
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

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!input) throw new Error(`input not found: ${placeholder}`);
  return input;
}

function horizon(over: Partial<MissionHorizon> = {}): MissionHorizon {
  return {
    id: "horizon-1",
    title: "몸의 기반 회복",
    description: null,
    horizonKind: "one_year",
    wscKind: "w",
    areaKeys: [],
    status: "active",
    sortRank: 2,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function guardrail(over: Partial<OkrGuardrail> = {}): OkrGuardrail {
  return {
    id: "guardrail-1",
    quarter: "2026-Q3",
    areaKey: "health",
    label: "주 3회 운동",
    targetKind: "routine_count",
    targetValue: 3,
    unit: "회",
    sourceRoutineIds: ["routine-1"],
    status: "active",
    sortRank: 4,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

const tags: LifeWheelTagConfig[] = [
  { id: "health", label: "건강", color: "#6a8f74", builtIn: true, enabled: true },
  { id: "work", label: "일", color: "#4d6d8f", builtIn: true, enabled: true },
];

describe("OKR foundation panels", () => {
  it("edits an existing mission horizon through the update command", async () => {
    render(<HorizonShelf horizons={[horizon()]} />);

    click(document.querySelector('[aria-label="몸의 기반 회복 수정"]')!);
    const title = inputByPlaceholder("장기 목표 또는 1년 테마");
    expect(title.value).toBe("몸의 기반 회복");
    setInputValue(title, "몸의 기반 회복 루틴화");
    await submitForm();

    expect(mocks.updateHorizonMutateAsync).toHaveBeenCalledWith({
      id: "horizon-1",
      title: "몸의 기반 회복 루틴화",
      description: null,
      horizonKind: "one_year",
      wscKind: "w",
      areaKeys: [],
      status: "active",
      sortRank: 2,
    });
    expect(mocks.createHorizonMutateAsync).not.toHaveBeenCalled();
  });

  it("edits an existing guardrail through upsert with its id", async () => {
    render(<GuardrailPanel quarter="2026-Q3" guardrails={[guardrail()]} tags={tags} />);

    click(document.querySelector('[aria-label="주 3회 운동 수정"]')!);
    const label = inputByPlaceholder("예: 주 3회 운동");
    expect(label.value).toBe("주 3회 운동");
    setInputValue(label, "주 4회 운동");
    await submitForm();

    expect(mocks.upsertGuardrailMutateAsync).toHaveBeenCalledWith({
      id: "guardrail-1",
      quarter: "2026-Q3",
      areaKey: "health",
      label: "주 4회 운동",
      targetKind: "routine_count",
      targetValue: 3,
      unit: "회",
      sourceRoutineIds: ["routine-1"],
      sortRank: 4,
    });
  });
});
