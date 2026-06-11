// src/lib/lifeWheelRadar.test.ts
import { describe, expect, it } from "vitest";

import type { LifeWheelTagConfig, RoutineTrackingItem, WorkSignal } from "@/bindings";

import {
  bucketRoutineDoneByOffset,
  computeRadarAxes,
  type RadarAxis,
  radarRenderMode,
  weekConfidence,
  weekSampleSize,
} from "./lifeWheelRadar";

function tag(id: string, enabled = true): LifeWheelTagConfig {
  return { id, label: id.toUpperCase(), color: "#3f7d5e", builtIn: true, enabled };
}
function sig(id: string, area: string | null, areaTags?: string[]): WorkSignal {
  return {
    id,
    projectId: null,
    title: id,
    body: null,
    source: "manual" as never,
    type: "task" as never,
    quadrant: "q2" as never,
    suggestedQuadrant: null,
    kind: "work" as never,
    area: area as never,
    areaTags: areaTags ? JSON.stringify(areaTags) : null,
    suggestedArea: null,
    status: "active" as never,
    snoozeUntil: null,
    todayForDate: null,
    todayDoneAt: "2026-06-10",
    todayRank: null,
    impactHigh: null,
    regret: null,
    scheduledAt: null,
    scheduledDuration: null,
    linkedEventId: null,
    linkedCalendarId: null,
    createdAt: "2026-06-10T00:00:00Z",
    updatedAt: "2026-06-10T00:00:00Z",
  };
}

describe("computeRadarAxes", () => {
  const tags = [tag("health"), tag("family"), tag("career"), tag("hobby", false)];

  it("counts signals per enabled tag, stable-sorted by id", () => {
    const axes = computeRadarAxes(
      [sig("a", "health"), sig("b", "career"), sig("c", "health")],
      tags,
    );
    const byKey = Object.fromEntries(axes.map((x: RadarAxis) => [x.key, x.count]));
    expect(byKey).toEqual({ career: 1, family: 0, health: 2 });
    expect(axes.map((x) => x.key)).toEqual(["career", "family", "health"]); // id asc
  });

  it("counts a multi-tagged signal in each of its tags", () => {
    const axes = computeRadarAxes([sig("a", "health", ["health", "family"])], tags);
    const byKey = Object.fromEntries(axes.map((x) => [x.key, x.count]));
    expect(byKey).toEqual({ career: 0, family: 1, health: 1 });
  });

  it("excludes untagged signals and disabled tags", () => {
    const axes = computeRadarAxes([sig("a", null), sig("b", "hobby")], tags);
    expect(axes.find((x) => x.key === "hobby")).toBeUndefined(); // disabled
    expect(axes.every((x) => x.count === 0)).toBe(true); // null + only-disabled-tag → no counts
  });

  it("carries label and color from the tag config", () => {
    const axes = computeRadarAxes([], [tag("health")]);
    expect(axes[0]).toMatchObject({ key: "health", label: "HEALTH", color: "#3f7d5e" });
  });
});

describe("radarRenderMode", () => {
  it("empty when 0 enabled tags", () => {
    expect(radarRenderMode([])).toBe("empty");
  });
  it("bars when 1 or 2 axes", () => {
    expect(radarRenderMode([tag("a")])).toBe("bars");
    expect(radarRenderMode([tag("a"), tag("b")])).toBe("bars");
  });
  it("radar when 3+ axes", () => {
    expect(radarRenderMode([tag("a"), tag("b"), tag("c")])).toBe("radar");
  });
  it("ignores disabled tags in mode decision", () => {
    expect(radarRenderMode([tag("a"), tag("b"), tag("c", false)])).toBe("bars");
  });
});

describe("weekSampleSize / weekConfidence", () => {
  const tags = [tag("health"), tag("family"), tag("career")];

  it("weekSampleSize sums enabled-axis contributions (multi-tag counts per axis)", () => {
    expect(weekSampleSize([], tags)).toBe(0);
    expect(weekSampleSize([sig("a", "health")], tags)).toBe(1);
    expect(weekSampleSize([sig("a", "health", ["health", "family"])], tags)).toBe(2);
    expect(weekSampleSize([sig("a", null)], tags)).toBe(0); // untagged ignored
  });

  it("empty when no tagged completed signals (blocks fake balanced-0 distribution)", () => {
    expect(weekConfidence([], tags)).toBe("empty");
    expect(weekConfidence([sig("a", null)], tags)).toBe("empty");
  });

  it("sparse at or below the floor (default 2)", () => {
    expect(weekConfidence([sig("a", "health")], tags)).toBe("sparse");
    expect(weekConfidence([sig("a", "health"), sig("b", "family")], tags)).toBe("sparse");
  });

  it("measured above the floor", () => {
    expect(weekConfidence([sig("a", "health"), sig("b", "family"), sig("c", "career")], tags)).toBe(
      "measured",
    );
  });

  it("respects a custom sparseFloor", () => {
    const many = [sig("a", "health"), sig("b", "family"), sig("c", "career")];
    expect(weekConfidence(many, tags, 5)).toBe("sparse"); // 3 ≤ 5
    expect(weekConfidence(many, tags, 2)).toBe("measured"); // 3 > 2
  });
});

describe("bucketRoutineDoneByOffset", () => {
  function routine(
    id: string,
    area: string | null,
    history: { date: string; done: boolean }[],
    areaTags?: string[],
  ): RoutineTrackingItem {
    return {
      id,
      title: id,
      freq: "daily" as never,
      area: area as never,
      areaTags: areaTags ? JSON.stringify(areaTags) : null,
      kind: "personal" as never,
      due: history.length,
      done: history.filter((h) => h.done).length,
      ratePct: 0,
      streak: 0,
      history,
    };
  }

  // 2026-06-11(목) 기준: 이번 주 = 6/8(월)–6/14(일), 지난주 = 6/1–6/7
  const today = "2026-06-11";

  it("buckets done occurrences into their week offset with the routine's area tags", () => {
    const map = bucketRoutineDoneByOffset(
      [
        routine("run", "health", [
          { date: "2026-06-09", done: true }, // 이번 주
          { date: "2026-06-10", done: false }, // 미완료 → 제외
          { date: "2026-06-03", done: true }, // 지난주
        ]),
      ],
      today,
    );
    expect(map.get(0)).toEqual([{ area: "health", areaTags: null }]);
    expect(map.get(-1)).toEqual([{ area: "health", areaTags: null }]);
    expect(map.get(-2)).toEqual([]);
  });

  it("feeds computeRadarAxes alongside signals (cards + routines combined)", () => {
    const tags = [tag("health"), tag("career")];
    const map = bucketRoutineDoneByOffset(
      [
        routine("run", "health", [
          { date: "2026-06-09", done: true },
          { date: "2026-06-11", done: true },
        ]),
      ],
      today,
    );
    const combined = [sig("a", "career"), ...(map.get(0) ?? [])];
    const axes = computeRadarAxes(combined, tags);
    expect(axes.find((x) => x.key === "health")?.count).toBe(2);
    expect(axes.find((x) => x.key === "career")?.count).toBe(1);
  });

  it("ignores done dates outside the 12-week window", () => {
    const map = bucketRoutineDoneByOffset(
      [routine("old", "health", [{ date: "2024-01-01", done: true }])],
      today,
    );
    for (const [, v] of map) expect(v).toEqual([]);
  });
});
