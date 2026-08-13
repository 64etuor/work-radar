// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KeyResult, Mission, Objective } from "@/bindings";

import { MissionStatement } from "./MissionStatement";
import { ObjectiveCard } from "./ObjectiveCard";
import { WeeklyCheckInPanel } from "./WeeklyCheckInPanel";

const mocks = vi.hoisted(() => ({
  setMissionMutateAsync: vi.fn(),
  createKeyResultMutateAsync: vi.fn(),
  updateKeyResultMutateAsync: vi.fn(),
  upsertCheckInMutateAsync: vi.fn(),
}));

vi.mock("@/lib/query", () => ({
  useSetMission: () => ({ isPending: false, mutateAsync: mocks.setMissionMutateAsync }),
  useCreateKeyResult: () => ({ isPending: false, mutateAsync: mocks.createKeyResultMutateAsync }),
  useUpdateKeyResult: () => ({ isPending: false, mutateAsync: mocks.updateKeyResultMutateAsync }),
  useUpsertOkrCheckIn: () => ({ isPending: false, mutateAsync: mocks.upsertCheckInMutateAsync }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function complete(request: ReturnType<typeof deferred>) {
  await act(async () => {
    request.resolve();
    await request.promise;
  });
}

function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submitTwice(form: HTMLFormElement) {
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function mission(): Mission {
  return {
    id: 1,
    statement: "기존 방향",
    note: null,
    updatedAt: "2026-08-13T00:00:00Z",
  };
}

function keyResult(): KeyResult {
  return {
    id: "kr-1",
    objectiveId: "objective-1",
    title: "주 3회 운동",
    kind: "metric",
    targetValue: 3,
    currentValue: 1,
    unit: "회",
    milestones: [],
    progress: null,
    sortRank: 0,
    routineId: null,
    routine: null,
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
  };
}

function objective(keyResults: KeyResult[] = []): Objective {
  return {
    id: "objective-1",
    quarter: "2026-Q3",
    title: "체력 회복",
    description: null,
    sortRank: 0,
    status: "active",
    closedReflection: null,
    linkedAreaKeys: [],
    linkedProjectIds: [],
    keyResults,
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
  };
}

describe("OKR async submission guards", () => {
  it("allows only one mission save while the first request is pending", async () => {
    // Given
    const request = deferred();
    mocks.setMissionMutateAsync.mockReturnValue(request.promise);
    render(<MissionStatement mission={mission()} />);
    act(() => container?.querySelector<HTMLButtonElement>(".mission-statement")?.click());
    const textarea = container?.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("mission textarea not found");
    setControlValue(textarea, "새 방향");

    // When
    const form = container?.querySelector<HTMLFormElement>("form");
    if (!form) throw new Error("mission form not found");
    submitTwice(form);

    // Then
    expect(mocks.setMissionMutateAsync).toHaveBeenCalledTimes(1);
    await complete(request);
  });

  it("allows only one key-result creation while the first request is pending", async () => {
    // Given
    const request = deferred();
    mocks.createKeyResultMutateAsync.mockReturnValue(request.promise);
    render(
      <ObjectiveCard
        position={1}
        objective={objective()}
        tags={[]}
        projects={[]}
        horizons={[]}
        horizonIds={[]}
        stats={null}
        checkIns={[]}
        onEdit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const addButton = Array.from(
      container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((button) => button.textContent?.includes("추가"));
    act(() => addButton?.click());
    const title = container?.querySelector<HTMLInputElement>('input[placeholder="KR 제목"]');
    if (!title) throw new Error("key-result title input not found");
    setControlValue(title, "달리기 거리");

    // When
    const form = container?.querySelector<HTMLFormElement>(".mission-add-kr-form");
    if (!form) throw new Error("key-result form not found");
    submitTwice(form);

    // Then
    expect(mocks.createKeyResultMutateAsync).toHaveBeenCalledTimes(1);
    await complete(request);
  });

  it("allows only one weekly check-in while the first request is pending", async () => {
    // Given
    const request = deferred();
    mocks.upsertCheckInMutateAsync.mockReturnValue(request.promise);
    render(
      <WeeklyCheckInPanel
        objectives={[objective([keyResult()])]}
        checkIns={[]}
        weekStart="2026-08-10"
      />,
    );

    // When
    const form = container?.querySelector<HTMLFormElement>(".mission-checkin-item");
    if (!form) throw new Error("weekly check-in form not found");
    submitTwice(form);

    // Then
    expect(mocks.upsertCheckInMutateAsync).toHaveBeenCalledTimes(1);
    await complete(request);
  });
});
