// src/lib/lifeWheelRadar.test.ts
import { describe, expect, it } from "vitest";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";

import { computeRadarAxes, type RadarAxis, radarRenderMode } from "./lifeWheelRadar";

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
