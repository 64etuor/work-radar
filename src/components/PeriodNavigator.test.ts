import { describe, expect, it } from "vitest";

import { formatMonthValue, stepMonthValue } from "./periodNavigatorUtils";

describe("PeriodNavigator month helpers", () => {
  it("formats YYYY-MM values for compact month labels", () => {
    expect(formatMonthValue("2026-06")).toBe("2026.06");
  });

  it("steps month values across year boundaries", () => {
    expect(stepMonthValue("2026-12", 1)).toBe("2027-01");
    expect(stepMonthValue("2026-01", -1)).toBe("2025-12");
  });
});
