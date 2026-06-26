import { describe, expect, it } from "vitest";

import { type BookkeepingReviewFilterRow, matchesBookkeepingReviewFilter } from "./reviewFilter";

const row: BookkeepingReviewFilterRow = {
  merchant: "Cafe Momo",
  category: "식비",
  subcategory: "카페",
  categoryCode: "food",
  subcategoryCode: "food_cafe",
  amountMinor: 4500,
  currency: "KRW",
  spentAt: "2026-06-18",
  spentAtTime: "09:30:00",
  description: "morning coffee",
  note: null,
  rawCategory: "카페/간식",
  reviewReasonsJson: JSON.stringify([{ code: "low_confidence", detail: "merchant ambiguous" }]),
};

describe("matchesBookkeepingReviewFilter", () => {
  it("matches merchant category amount date and review reason text", () => {
    for (const query of ["momo", "food_cafe", "4500", "2026-06-18", "low_confidence"]) {
      expect(matchesBookkeepingReviewFilter(row, { query, fromDate: "", toDate: "" })).toBe(true);
    }
  });

  it("filters by inclusive date range", () => {
    expect(
      matchesBookkeepingReviewFilter(row, {
        query: "",
        fromDate: "2026-06-18",
        toDate: "2026-06-18",
      }),
    ).toBe(true);
    expect(
      matchesBookkeepingReviewFilter(row, {
        query: "",
        fromDate: "2026-06-19",
        toDate: "",
      }),
    ).toBe(false);
  });

  it("falls back to raw malformed review reason text", () => {
    expect(
      matchesBookkeepingReviewFilter(
        { ...row, reviewReasonsJson: "needs manual category" },
        { query: "manual category", fromDate: "", toDate: "" },
      ),
    ).toBe(true);
  });
});
