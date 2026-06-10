// src/lib/weekRange.test.ts
import { describe, expect, it } from "vitest";

import { isoWeekNumber, mondayOf, weekRangeForOffset, WEEKS_WINDOW } from "./weekRange";

describe("mondayOf", () => {
  it("returns Monday for a mid-week date", () => {
    expect(mondayOf("2026-06-10")).toBe("2026-06-08"); // Wed → Mon
  });
  it("returns same date when already Monday", () => {
    expect(mondayOf("2026-06-08")).toBe("2026-06-08");
  });
  it("handles Sunday (week's last day)", () => {
    expect(mondayOf("2026-06-14")).toBe("2026-06-08"); // Sun → that week's Mon
  });
});

describe("weekRangeForOffset", () => {
  const today = "2026-06-10"; // Wed, week Mon 6/8 – Sun 6/14
  it("offset 0 = current week Mon..Sun", () => {
    expect(weekRangeForOffset(today, 0)).toEqual({ start: "2026-06-08", end: "2026-06-14" });
  });
  it("offset -1 = previous week", () => {
    expect(weekRangeForOffset(today, -1)).toEqual({ start: "2026-06-01", end: "2026-06-07" });
  });
  it("offset -2 = two weeks back", () => {
    expect(weekRangeForOffset(today, -2)).toEqual({ start: "2026-05-25", end: "2026-05-31" });
  });
});

describe("isoWeekNumber", () => {
  it("computes ISO week of year", () => {
    expect(isoWeekNumber("2026-06-10")).toBe(24);
  });
});

describe("WEEKS_WINDOW", () => {
  it("is 12", () => {
    expect(WEEKS_WINDOW).toBe(12);
  });
});
