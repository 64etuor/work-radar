import { describe, expect, it } from "vitest";

import { fmtMinutes, todayAgeDays } from "./timeTotals";

describe("fmtMinutes", () => {
  it('returns "0m" for 0', () => {
    expect(fmtMinutes(0)).toBe("0m");
  });
  it('returns "45m" for 45', () => {
    expect(fmtMinutes(45)).toBe("45m");
  });
  it('returns "3h" for 180', () => {
    expect(fmtMinutes(180)).toBe("3h");
  });
  it('returns "1h 30m" for 90', () => {
    expect(fmtMinutes(90)).toBe("1h 30m");
  });
  it('truncates fractional minutes — "1h 30m" for 90.7', () => {
    expect(fmtMinutes(90.7)).toBe("1h 30m");
  });
});

describe("todayAgeDays", () => {
  it("returns 3 when 2 days have elapsed since registration", () => {
    expect(todayAgeDays("2026-06-10", "2026-06-12")).toBe(3);
  });
  it("returns 1 on the same day", () => {
    expect(todayAgeDays("2026-06-12", "2026-06-12")).toBe(1);
  });
  it("clamps to 1 when registration date is in the future", () => {
    expect(todayAgeDays("2026-06-15", "2026-06-10")).toBe(1);
  });
});
