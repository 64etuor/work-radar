import { describe, expect, it } from "vitest";

import type { BookkeepingBudgetPlanRow } from "@/bindings";

import { parseBudgetAmount, summarizeBudgetPlan } from "./budgetPlanner";

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
    currency: "KRW",
    ...overrides,
  };
}

describe("summarizeBudgetPlan", () => {
  it("sums limits/remaining only for budgeted rows but spend for all rows", () => {
    const summary = summarizeBudgetPlan([
      row({
        categoryCode: "food",
        hasBudget: true,
        limitMinor: 5_000,
        spentMinor: 3_000,
        remainingMinor: 2_000,
      }),
      row({
        categoryCode: "transport",
        hasBudget: true,
        limitMinor: 2_000,
        spentMinor: 2_500,
        remainingMinor: -500,
      }),
      row({ categoryCode: "shopping", hasBudget: false, spentMinor: 1_000 }),
    ]);
    expect(summary.totalLimitMinor).toBe(7_000);
    expect(summary.totalSpentMinor).toBe(6_500); // 미설정 행의 지출도 포함
    expect(summary.totalRemainingMinor).toBe(1_500);
    expect(summary.unsetCount).toBe(1);
  });

  it("handles an empty plan", () => {
    expect(summarizeBudgetPlan([])).toEqual({
      totalLimitMinor: 0,
      totalSpentMinor: 0,
      totalRemainingMinor: 0,
      unsetCount: 0,
    });
  });
});

describe("parseBudgetAmount", () => {
  it("parses comma/space/₩ decorated input", () => {
    expect(parseBudgetAmount("500,000")).toBe(500_000);
    expect(parseBudgetAmount(" ₩ 12,000 ")).toBe(12_000);
    expect(parseBudgetAmount("3000")).toBe(3_000);
  });

  it("rejects empty, negative, and non-numeric", () => {
    expect(parseBudgetAmount("")).toBeNull();
    expect(parseBudgetAmount("   ")).toBeNull();
    expect(parseBudgetAmount("-100")).toBeNull();
    expect(parseBudgetAmount("abc")).toBeNull();
  });

  it("rounds fractional input", () => {
    expect(parseBudgetAmount("1000.6")).toBe(1_001);
  });
});
