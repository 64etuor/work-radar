import { describe, expect, it } from "vitest";

import {
  ATTENTION_REASON_CODES,
  categoryPathLabel,
  isSuspicious,
  REVIEW_REASON_CHIP_LIMIT,
  shouldCommitNoteDraft,
  truncateReviewChips,
} from "./reviewRow";

function reasonsJson(...codes: string[]) {
  return JSON.stringify(codes.map((code) => ({ code })));
}

describe("truncateReviewChips", () => {
  it("returns everything with no hidden count when under the limit", () => {
    expect(truncateReviewChips(["low_confidence"])).toEqual({
      visible: ["low_confidence"],
      hiddenCount: 0,
    });
  });

  it("returns empty for no codes", () => {
    expect(truncateReviewChips([])).toEqual({ visible: [], hiddenCount: 0 });
  });

  it("truncates past the limit and reports the hidden count", () => {
    const codes = ["a", "b", "c", "d", "e"];
    expect(truncateReviewChips(codes, 2)).toEqual({ visible: ["a", "b"], hiddenCount: 3 });
  });

  it("dedupes codes before counting", () => {
    expect(truncateReviewChips(["dup", "dup", "low_confidence"], 2)).toEqual({
      visible: ["dup", "low_confidence"],
      hiddenCount: 0,
    });
  });

  it("keeps at-limit lists intact (no pointless +0 chip)", () => {
    const codes = Array.from({ length: REVIEW_REASON_CHIP_LIMIT }, (_, i) => `c${i}`);
    expect(truncateReviewChips(codes)).toEqual({ visible: codes, hiddenCount: 0 });
  });
});

describe("categoryPathLabel", () => {
  it("joins category and subcategory with ›", () => {
    expect(categoryPathLabel("식비", "카페")).toBe("식비 › 카페");
  });

  it("returns category alone when subcategory is missing", () => {
    expect(categoryPathLabel("식비", null)).toBe("식비");
  });
});

describe("isSuspicious", () => {
  it("flags every attention reason code", () => {
    for (const code of ATTENTION_REASON_CODES) {
      expect(
        isSuspicious({ reviewReasonsJson: reasonsJson(code), duplicateOfTransactionId: null }),
        code,
      ).toBe(true);
    }
  });

  it("treats informational-only reasons as normal (date_from_received_at)", () => {
    expect(
      isSuspicious({
        reviewReasonsJson: reasonsJson("date_from_received_at"),
        duplicateOfTransactionId: null,
      }),
    ).toBe(false);
  });

  it("treats no reasons as normal", () => {
    expect(isSuspicious({ reviewReasonsJson: "[]", duplicateOfTransactionId: null })).toBe(false);
  });

  it("flags rows already linked as duplicates regardless of reasons", () => {
    expect(isSuspicious({ reviewReasonsJson: "[]", duplicateOfTransactionId: "tx-9" })).toBe(true);
  });

  it("flags mixed informational + attention reasons", () => {
    expect(
      isSuspicious({
        reviewReasonsJson: reasonsJson("date_from_received_at", "low_confidence"),
        duplicateOfTransactionId: null,
      }),
    ).toBe(true);
  });

  it("tolerates malformed reasons json", () => {
    expect(isSuspicious({ reviewReasonsJson: "not json", duplicateOfTransactionId: null })).toBe(
      false,
    );
  });
});

describe("shouldCommitNoteDraft", () => {
  it("commits a genuinely changed note", () => {
    expect(shouldCommitNoteDraft("old", "new")).toBe(true);
  });

  it("skips when the draft equals the current note", () => {
    expect(shouldCommitNoteDraft("같은 메모", "같은 메모")).toBe(false);
  });

  it("treats whitespace-only edits as no change", () => {
    expect(shouldCommitNoteDraft("메모", "  메모  ")).toBe(false);
  });

  it("treats empty draft as equal to null note", () => {
    expect(shouldCommitNoteDraft(null, "")).toBe(false);
    expect(shouldCommitNoteDraft(null, "   ")).toBe(false);
  });

  it("commits clearing an existing note", () => {
    expect(shouldCommitNoteDraft("지울 메모", "")).toBe(true);
  });

  it("commits adding a note to a row without one", () => {
    expect(shouldCommitNoteDraft(null, "새 메모")).toBe(true);
  });
});
