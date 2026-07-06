// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BookkeepingBudgetPlanRow } from "@/bindings";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import { BudgetPlannerPanel } from "./BudgetPlannerPanel";

const setBudgetMutate = vi.fn();
const deleteBudgetMutate = vi.fn();
let plannerRows: BookkeepingBudgetPlanRow[] = [];

// react-query/toast 훅 격리 — 패널의 렌더/편집 경계만 검증한다.
vi.mock("@/lib/query/bookkeeping", () => ({
  useBookkeepingBudgetPlanner: () => ({ data: plannerRows }),
  useSetBookkeepingBudget: () => ({ isPending: false, mutate: setBudgetMutate }),
  useDeleteBookkeepingBudget: () => ({ isPending: false, mutate: deleteBudgetMutate }),
}));
vi.mock("@/lib/toast", () => ({
  useToastStore: (selector: (s: { pushSuccess: () => void }) => unknown) =>
    selector({ pushSuccess: () => {} }),
}));

beforeAll(installRadixHappyDomShim);

function row(overrides: Partial<BookkeepingBudgetPlanRow>): BookkeepingBudgetPlanRow {
  return {
    categoryCode: "food",
    label: "식비",
    hasBudget: false,
    budgetId: null,
    limitMinor: null,
    rollover: false,
    spentMinor: 0,
    rolloverInMinor: 0,
    remainingMinor: 0,
    pct: 0,
    suggestedMinor: 0,
    currency: "KRW",
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  setBudgetMutate.mockClear();
  deleteBudgetMutate.mockClear();
  plannerRows = [];
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<BudgetPlannerPanel month="2026-07" projectId={null} />));
}

describe("BudgetPlannerPanel", () => {
  it("renders budgeted and unbudgeted rows, flagging unset categories", () => {
    plannerRows = [
      row({
        categoryCode: "food",
        label: "식비",
        hasBudget: true,
        budgetId: "b1",
        limitMinor: 500_000,
        spentMinor: 300_000,
        remainingMinor: 200_000,
        pct: 0.6,
        suggestedMinor: 320_000,
      }),
      row({ categoryCode: "transport", label: "교통", suggestedMinor: 40_000 }),
    ];
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("식비");
    expect(text).toContain("교통");
    expect(text).toContain("미설정"); // 미설정 배지 + KPI 라벨
    // 미설정 배지는 예산 없는 transport 행에만.
    expect(container!.querySelectorAll(".bk-budget-unset-badge")).toHaveLength(1);
  });

  it("applies a suggestion as a budget via setBudget.mutate", () => {
    plannerRows = [row({ categoryCode: "transport", label: "교통", suggestedMinor: 40_000 })];
    render();
    const suggest = container!.querySelector<HTMLButtonElement>(".bk-budget-suggest");
    expect(suggest).not.toBeNull();
    act(() => suggest!.click());
    expect(setBudgetMutate).toHaveBeenCalledTimes(1);
    expect(setBudgetMutate.mock.calls[0][0]).toMatchObject({
      categoryCode: "transport",
      limitMinor: 40_000,
      month: "2026-07",
    });
  });
});
