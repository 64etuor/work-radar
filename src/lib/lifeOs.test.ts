import { describe, expect, it } from "vitest";

import type { SprintCycle, WeeklyFocus } from "@/bindings";

import {
  currentQuarterKey,
  focusMatchesSprintCycle,
  primaryDominoTitle,
  sprintGoalLabel,
} from "./lifeOs";

function focus(overrides: Partial<WeeklyFocus> = {}): WeeklyFocus {
  return {
    id: "wf1",
    weekStart: "2026-07-06",
    title: "주간 도미노",
    sourceKind: "sprint",
    sourceId: "cycle1",
    objectiveId: null,
    keyResultId: null,
    horizonId: null,
    status: "selected",
    estimatedMinutes: null,
    reason: null,
    mustDoSignalIds: [],
    notDoSignalIds: [],
    guardrailIds: [],
    shrinkCount: 0,
    createdAt: "2026-07-06 00:00:00",
    updatedAt: "2026-07-06 00:00:00",
    ...overrides,
  };
}

function cycle(overrides: Partial<SprintCycle> = {}): SprintCycle {
  return {
    id: "cycle1",
    sprintKey: "20260703T2100__20260717T2100",
    startAt: "2026-07-03T21:00:00",
    endAt: "2026-07-17T21:00:00",
    intervalDays: 14,
    anchorWeekday: "fri",
    anchorTime: "21:00",
    goal: "스프린트 목표",
    weeklyFocusId: "wf1",
    status: "active",
    createdAt: "2026-07-04 00:00:00",
    updatedAt: "2026-07-04 00:00:00",
    ...overrides,
  };
}

describe("lifeOs helpers", () => {
  it("derives current quarter keys from local dates", () => {
    expect(currentQuarterKey(new Date(2026, 6, 4))).toBe("2026-Q3");
    expect(currentQuarterKey(new Date(2026, 11, 31))).toBe("2026-Q4");
  });

  it("matches sprint-linked weekly focus by both ids", () => {
    expect(focusMatchesSprintCycle(focus(), cycle())).toBe(true);
    expect(focusMatchesSprintCycle(focus({ sourceId: "other" }), cycle())).toBe(false);
    expect(focusMatchesSprintCycle(focus({ id: "other" }), cycle())).toBe(false);
  });

  it("prefers selected weekly focus over sprint display goal for Today domino", () => {
    expect(primaryDominoTitle(focus(), cycle())).toEqual({
      title: "주간 도미노",
      source: "weekly_focus",
    });
    expect(primaryDominoTitle(null, cycle())).toEqual({
      title: "스프린트 목표",
      source: "sprint",
    });
    expect(primaryDominoTitle(null, cycle({ goal: "  " }))).toEqual({
      title: null,
      source: "none",
    });
  });

  it("formats sprint goal labels compactly", () => {
    expect(sprintGoalLabel(cycle())).toBe("스프린트 목표");
    expect(sprintGoalLabel(cycle({ goal: "   " }))).toBeNull();
    expect(sprintGoalLabel(null)).toBeNull();
  });
});
