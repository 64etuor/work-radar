// src/lib/useWeekNav.test.ts
import { describe, expect, it } from "vitest";

import { clampOffset } from "./useWeekNav";
import { WEEKS_WINDOW } from "./weekRange";

describe("clampOffset", () => {
  it("blocks the future (max 0)", () => {
    expect(clampOffset(3)).toBe(0);
  });
  it("clamps to oldest window week", () => {
    expect(clampOffset(-999)).toBe(-(WEEKS_WINDOW - 1));
  });
  it("passes valid past offsets", () => {
    expect(clampOffset(-4)).toBe(-4);
  });
});
