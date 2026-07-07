import { describe, expect, it } from "vitest";

import {
  keyResultProgressRatio,
  objectiveMatchesForSignal,
  objectiveProgressRatio,
  objectivesMatchingSignal,
  okrBadgeMatchesForSignal,
  parseAreaTags,
  signalMatchesObjective,
  uncheckedKrCount,
  weekStartMonday,
} from "./okr";

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

  it("derives decrease metric progress toward a lower target", () => {
    expect(
      keyResultProgressRatio({
        kind: "metric",
        currentValue: 80,
        targetValue: 70,
        milestones: [],
      }),
    ).toBe(0.875);
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

// okr.rs stats_for_objective SQL 매칭 규칙의 프런트 미러 — 규칙 변경 시 양쪽 동시 수정.
describe("signalMatchesObjective", () => {
  const objective = {
    id: "o1",
    title: "건강 루틴 정착",
    status: "active" as const,
    linkedAreaKeys: ["health"],
    linkedProjectIds: ["p1"],
  };

  it("matches by primary area", () => {
    expect(
      signalMatchesObjective({ area: "health", areaTags: null, projectId: null }, objective),
    ).toBe(true);
  });

  it("matches by area_tags JSON membership", () => {
    expect(
      signalMatchesObjective(
        { area: null, areaTags: '["work","health"]', projectId: null },
        objective,
      ),
    ).toBe(true);
  });

  it("matches by linked project id", () => {
    expect(signalMatchesObjective({ area: null, areaTags: null, projectId: "p1" }, objective)).toBe(
      true,
    );
  });

  it("does not match unrelated signals or malformed tags", () => {
    expect(
      signalMatchesObjective({ area: "work", areaTags: "not-json", projectId: "p2" }, objective),
    ).toBe(false);
  });

  it("objectiveMatchesForSignal reports the matching basis (area beats project)", () => {
    expect(
      objectiveMatchesForSignal({ area: "health", areaTags: null, projectId: "p1" }, [objective]),
    ).toEqual([{ objective, via: "area" }]);
    expect(
      objectiveMatchesForSignal({ area: "work", areaTags: null, projectId: "p1" }, [objective]),
    ).toEqual([{ objective, via: "project" }]);
  });

  it("okrBadgeMatchesForSignal does not badge project-only matches", () => {
    expect(
      okrBadgeMatchesForSignal({ area: null, areaTags: null, projectId: "p1" }, [objective]),
    ).toEqual([]);
    expect(
      okrBadgeMatchesForSignal({ area: "health", areaTags: null, projectId: "p1" }, [objective]),
    ).toEqual([{ objective, via: "area" }]);
  });

  it("objectivesMatchingSignal excludes non-active objectives", () => {
    const closed = { ...objective, id: "o2", status: "closed" as const };
    expect(
      objectivesMatchingSignal({ area: "health", areaTags: null, projectId: null }, [
        objective,
        closed,
      ]).map((o) => o.id),
    ).toEqual(["o1"]);
  });
});

describe("parseAreaTags", () => {
  it("parses valid arrays and rejects junk", () => {
    expect(parseAreaTags('["a","b"]')).toEqual(["a", "b"]);
    expect(parseAreaTags(null)).toEqual([]);
    expect(parseAreaTags("oops")).toEqual([]);
    expect(parseAreaTags('{"a":1}')).toEqual([]);
  });
});

describe("uncheckedKrCount", () => {
  const objectives = [
    {
      status: "active" as const,
      keyResults: [
        { id: "kr1", routineId: null },
        { id: "kr2", routineId: null },
      ],
    },
    { status: "closed" as const, keyResults: [{ id: "kr3", routineId: null }] },
  ];

  it("counts only active-objective KRs without a check-in this week", () => {
    expect(
      uncheckedKrCount(objectives, [{ keyResultId: "kr1", weekStart: "2026-07-06" }], "2026-07-06"),
    ).toBe(1);
  });

  it("excludes routine-linked KRs (progress auto-derives from routine checks)", () => {
    const withRoutine = [
      {
        status: "active" as const,
        keyResults: [
          { id: "kr1", routineId: "routine-1" },
          { id: "kr2", routineId: null },
        ],
      },
    ];
    expect(uncheckedKrCount(withRoutine, [], "2026-07-06")).toBe(1);
  });

  it("ignores check-ins from other weeks", () => {
    expect(
      uncheckedKrCount(objectives, [{ keyResultId: "kr1", weekStart: "2026-06-29" }], "2026-07-06"),
    ).toBe(2);
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
