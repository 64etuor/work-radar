import { describe, expect, it } from "vitest";

import { monthRange } from "./bookkeepingMonth";

describe("monthRange", () => {
  it("returns inclusive first/last day for a 30-day month", () => {
    expect(monthRange("2026-06")).toEqual({ fromDate: "2026-06-01", toDate: "2026-06-30" });
  });

  it("handles 31-day and leap-February months", () => {
    expect(monthRange("2026-07")).toEqual({ fromDate: "2026-07-01", toDate: "2026-07-31" });
    expect(monthRange("2028-02")).toEqual({ fromDate: "2028-02-01", toDate: "2028-02-29" });
    expect(monthRange("2026-02")).toEqual({ fromDate: "2026-02-01", toDate: "2026-02-28" });
  });
});
