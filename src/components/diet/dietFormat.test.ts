import { describe, expect, it } from "vitest";

import {
  addDays,
  expiryTone,
  fmtG,
  fmtKcal,
  kcalBand,
  num,
  parseOptionalInt,
  parseOptionalNumber,
} from "./dietFormat";

describe("expiryTone", () => {
  const today = "2026-07-17";

  it("classifies expired / soon / ok on string date boundaries", () => {
    expect(expiryTone("2026-07-16", today)).toBe("expired");
    expect(expiryTone("2026-07-17", today)).toBe("soon"); // 오늘 만료 = soon(아직 안 지남)
    expect(expiryTone("2026-07-20", today)).toBe("soon"); // 기본 soonDays=3의 경계 포함
    expect(expiryTone("2026-07-21", today)).toBe("ok");
    expect(expiryTone(null, today)).toBeNull();
    expect(expiryTone(undefined, today)).toBeNull();
  });

  it("respects a custom soon window", () => {
    expect(expiryTone("2026-07-24", today, 7)).toBe("soon");
    expect(expiryTone("2026-07-25", today, 7)).toBe("ok");
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-07-17", -7)).toBe("2026-07-10");
  });
});

describe("kcalBand", () => {
  it("computes target ± tolerance%", () => {
    const band = kcalBand(2200, 7);
    expect(band.min).toBeCloseTo(2046);
    expect(band.max).toBeCloseTo(2354);
  });

  it("treats null target/tolerance as zero (specta f64 → number|null)", () => {
    expect(kcalBand(null, null)).toEqual({ min: 0, max: 0 });
    expect(kcalBand(2000, null)).toEqual({ min: 2000, max: 2000 });
  });
});

describe("parseOptionalNumber", () => {
  it("keeps valid numbers, rejects junk/negatives, and treats blank as null", () => {
    expect(parseOptionalNumber("1200")).toBe(1200);
    expect(parseOptionalNumber(" 12.5 ")).toBe(12.5);
    expect(parseOptionalNumber("")).toBeNull();
    expect(parseOptionalNumber("   ")).toBeNull();
    expect(parseOptionalNumber("abc")).toBeNull();
    expect(parseOptionalNumber("-5")).toBeNull();
  });

  it("parseOptionalInt rounds and inherits the same guards", () => {
    expect(parseOptionalInt("12.5")).toBe(13);
    expect(parseOptionalInt("")).toBeNull();
    expect(parseOptionalInt("abc")).toBeNull();
  });
});

describe("formatters", () => {
  it("rounds and falls back on null", () => {
    expect(num(null)).toBe(0);
    expect(fmtG(1234.6)).toBe("1,235g");
    expect(fmtG(null)).toBe("0g");
    expect(fmtKcal(2185.4)).toBe("2,185 kcal");
  });
});
