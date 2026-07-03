import { describe, expect, it } from "vitest";

import { keyResultProgressRatio, objectiveProgressRatio, weekStartMonday } from "./okr";

describe("keyResultProgressRatio", () => {
  it("derives metric progress from current / target", () => {
    expect(
      keyResultProgressRatio({
        kind: "metric",
        currentValue: 30,
        targetValue: 100,
        milestones: [],
      }),
    ).toBe(0.3);
  });

  it("guards metric progress when target is zero", () => {
    const progress = keyResultProgressRatio({
      kind: "metric",
      currentValue: 30,
      targetValue: 0,
      milestones: [],
    });

    expect(progress).toBe(0);
    expect(Number.isFinite(progress)).toBe(true);
  });

  it("derives milestone progress from completed checklist items", () => {
    expect(
      keyResultProgressRatio({
        kind: "milestone",
        currentValue: null,
        targetValue: null,
        milestones: [
          { label: "초안", done: true },
          { label: "리뷰", done: false },
          { label: "배포", done: true },
          { label: "회고", done: false },
        ],
      }),
    ).toBe(0.5);
  });

  it("averages key result progress for an objective", () => {
    expect(
      objectiveProgressRatio([
        { kind: "metric", currentValue: 25, targetValue: 100, milestones: [] },
        {
          kind: "milestone",
          currentValue: null,
          targetValue: null,
          milestones: [
            { label: "A", done: true },
            { label: "B", done: true },
          ],
        },
      ]),
    ).toBe(0.625);
  });
});

describe("weekStartMonday", () => {
  it("returns the local Monday for a mid-week date", () => {
    expect(weekStartMonday(new Date(2026, 6, 8, 15, 30))).toBe("2026-07-06");
  });

  it("treats Sunday as the end of the same Monday-start week", () => {
    expect(weekStartMonday(new Date(2026, 6, 12, 9, 0))).toBe("2026-07-06");
  });
});
