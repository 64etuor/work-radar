import { describe, expect, it } from "vitest";

import { paceInfo, progressPct, starFills, tierOf, yearOf } from "./readingFormat";

describe("tierOf", () => {
  it("buckets ratings into Obsidian hall-of-fame tiers", () => {
    expect(tierOf(10)).toBe("S");
    expect(tierOf(9)).toBe("S");
    expect(tierOf(8.9)).toBe("A");
    expect(tierOf(7)).toBe("A");
    expect(tierOf(5)).toBe("B");
    expect(tierOf(3)).toBe("C");
    expect(tierOf(1)).toBe("D");
    expect(tierOf(0.5)).toBe("none");
    expect(tierOf(null)).toBe("none");
  });
});

describe("starFills", () => {
  it("maps 0..10 rating to five star fill percents", () => {
    expect(starFills(10)).toEqual([100, 100, 100, 100, 100]);
    expect(starFills(5)).toEqual([100, 100, 50, 0, 0]);
    expect(starFills(0)).toEqual([0, 0, 0, 0, 0]);
    expect(starFills(9)).toEqual([100, 100, 100, 100, 50]);
  });
});

describe("progressPct", () => {
  it("clamps to 0..100 and returns null without page count", () => {
    expect(progressPct(206, 412)).toBe(50);
    expect(progressPct(500, 412)).toBe(100);
    expect(progressPct(0, 412)).toBe(0);
    expect(progressPct(50, null)).toBeNull();
    expect(progressPct(50, 0)).toBeNull();
  });
});

describe("paceInfo", () => {
  it("computes expected books from year progress (Obsidian formula)", () => {
    // 연말: 기대 = 목표 전체.
    const end = paceInfo(40, 52, "2026-12-31");
    expect(end.expected).toBe(52);
    expect(end.diff).toBe(-12);
    expect(end.remaining).toBe(12);

    // 연초: 기대 0권 근처, 달성률 클램프.
    const start = paceInfo(60, 52, "2026-01-01");
    expect(start.expected).toBe(0);
    expect(start.pct).toBe(100);
    expect(start.remaining).toBe(0);
    expect(start.monthlyGoal).toBe(5);
  });
});

describe("yearOf", () => {
  it("extracts the year with a sane fallback", () => {
    expect(yearOf("2026-07-23")).toBe(2026);
    expect(yearOf("")).toBe(new Date().getFullYear());
  });
});
