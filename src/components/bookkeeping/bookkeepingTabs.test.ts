import { describe, expect, it } from "vitest";

import {
  BOOKKEEPING_DEFAULT_TAB,
  BOOKKEEPING_TAB_STORAGE_KEY,
  BOOKKEEPING_TABS,
  isBookkeepingTabId,
  readStoredBookkeepingTab,
  reviewBadgeLabel,
  shouldShowReviewJumpChip,
  writeStoredBookkeepingTab,
} from "./bookkeepingTabs";

describe("bookkeeping tabs", () => {
  it("keeps the task-oriented segment order with 검토 first", () => {
    expect(BOOKKEEPING_TABS.map((tab) => tab.id)).toEqual([
      "review",
      "ledger",
      "recurring",
      "budget",
      "reports",
      "import",
    ]);
    expect(BOOKKEEPING_TABS[0].label).toBe("검토");
    expect(BOOKKEEPING_DEFAULT_TAB).toBe("review");
  });

  it("recognizes only known tab ids", () => {
    expect(isBookkeepingTabId("ledger")).toBe(true);
    expect(isBookkeepingTabId("unknown")).toBe(false);
    expect(isBookkeepingTabId(null)).toBe(false);
  });

  describe("readStoredBookkeepingTab", () => {
    it("restores a stored tab id", () => {
      expect(readStoredBookkeepingTab(() => "reports")).toBe("reports");
    });

    it("falls back to 검토 for missing or unknown values", () => {
      expect(readStoredBookkeepingTab(() => null)).toBe("review");
      expect(readStoredBookkeepingTab(() => "stale-tab")).toBe("review");
    });

    it("falls back to 검토 when storage access throws", () => {
      expect(
        readStoredBookkeepingTab(() => {
          throw new Error("denied");
        }),
      ).toBe("review");
    });
  });

  describe("writeStoredBookkeepingTab", () => {
    it("persists under the namespaced key", () => {
      const writes: Array<[string, string]> = [];
      writeStoredBookkeepingTab((key, value) => writes.push([key, value]), "ledger");
      expect(writes).toEqual([[BOOKKEEPING_TAB_STORAGE_KEY, "ledger"]]);
    });

    it("swallows storage write failures", () => {
      expect(() =>
        writeStoredBookkeepingTab(() => {
          throw new Error("quota");
        }, "review"),
      ).not.toThrow();
    });
  });

  describe("reviewBadgeLabel", () => {
    it("hides the badge at zero and below", () => {
      expect(reviewBadgeLabel(0)).toBeNull();
      expect(reviewBadgeLabel(-3)).toBeNull();
      expect(reviewBadgeLabel(Number.NaN)).toBeNull();
    });

    it("shows the count and caps at 99+", () => {
      expect(reviewBadgeLabel(1)).toBe("1");
      expect(reviewBadgeLabel(99)).toBe("99");
      expect(reviewBadgeLabel(100)).toBe("99+");
    });
  });

  describe("shouldShowReviewJumpChip", () => {
    it("shows the jump chip only outside the active review tab", () => {
      expect(shouldShowReviewJumpChip(3, "ledger")).toBe(true);
      expect(shouldShowReviewJumpChip(3, "review")).toBe(false);
      expect(shouldShowReviewJumpChip(0, "ledger")).toBe(false);
    });
  });
});
