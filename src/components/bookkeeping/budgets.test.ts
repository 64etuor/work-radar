import { describe, expect, it } from "vitest";

import { budgetBarPercent, isBudgetOverrun } from "./budgets";

describe("budget helpers", () => {
  it("clamps budget progress for compact bars", () => {
    expect(budgetBarPercent(-1)).toBe(0);
    expect(budgetBarPercent(Number.NaN)).toBe(0);
    expect(budgetBarPercent(0.424)).toBe(42);
    expect(budgetBarPercent(1.75)).toBe(100);
  });

  it("flags negative remaining as overrun", () => {
    expect(isBudgetOverrun(-1)).toBe(true);
    expect(isBudgetOverrun(0)).toBe(false);
  });
});
