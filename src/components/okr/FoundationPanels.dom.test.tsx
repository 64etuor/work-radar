// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MissionHorizon } from "@/bindings";

import { HorizonShelf } from "./HorizonShelf";

const mocks = vi.hoisted(() => ({
  createHorizonMutateAsync: vi.fn(),
  updateHorizonMutateAsync: vi.fn(),
  deleteHorizonMutate: vi.fn(),
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
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.createHorizonMutateAsync.mockReset();
  mocks.updateHorizonMutateAsync.mockReset();
  mocks.deleteHorizonMutate.mockReset();
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

function setInputValue(el: HTMLInputElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  act(() => {
    el.focus();
  });
  desc?.set?.call(el, value);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (!input) throw new Error(`input not found: ${placeholder}`);
  return input;
}

function inputByLabel(label: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`input not found: ${label}`);
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

describe("OKR foundation panels", () => {
  it("edits an existing mission horizon inline through the update command", async () => {
    render(<HorizonShelf horizons={[horizon()]} />);

    const title = inputByLabel("장기 목표 제목: 몸의 기반 회복");
    expect(title.value).toBe("몸의 기반 회복");
    setInputValue(title, "몸의 기반 회복 루틴화");
    await act(async () => {
      title.blur();
      await Promise.resolve();
    });

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
    expect(inputByPlaceholder("장기 목표 또는 1년 테마").value).toBe("");
  });
});
