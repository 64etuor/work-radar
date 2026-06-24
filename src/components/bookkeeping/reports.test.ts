import { describe, expect, it } from "vitest";

import { reportBarPercent, reportSeriesMax } from "./reports";

describe("report helpers", () => {
  it("keeps report maxima usable for empty or zero series", () => {
    expect(reportSeriesMax([])).toBe(1);
    expect(reportSeriesMax([0, Number.NaN])).toBe(1);
  });

  it("uses absolute values for net bars and clamps widths", () => {
    const max = reportSeriesMax([-500, 1_000, 250]);

    expect(max).toBe(1_000);
    expect(reportBarPercent(-500, max)).toBe(50);
    expect(reportBarPercent(2_000, max)).toBe(100);
    expect(reportBarPercent(Number.NaN, max)).toBe(0);
  });
});
