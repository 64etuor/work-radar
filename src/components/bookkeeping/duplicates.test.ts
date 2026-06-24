import { describe, expect, it } from "vitest";

import type { BookkeepingTransaction } from "@/bindings";

import { duplicateQueryFromTransaction, formatDuplicateScore } from "./duplicates";

function makeTx(over: Partial<BookkeepingTransaction>): BookkeepingTransaction {
  return {
    id: "tx-1",
    projectId: "proj-1",
    source: "gmail",
    sourceRef: "gmail:abc",
    merchant: "스타벅스",
    description: null,
    amountMinor: 5000,
    currency: "KRW",
    spentAt: "2026-06-20",
    category: "식비",
    reviewStatus: "needs_review",
    note: null,
    paymentMethodKind: "card",
    paymentMethodLabel: null,
    paymentMethodLast4: null,
    expenseKind: "variable",
    recurringExpenseId: null,
    recurringOccurrenceId: null,
    direction: "expense",
    account: null,
    subcategory: null,
    categoryCode: "food",
    subcategoryCode: null,
    rawCategory: null,
    spentAtTime: null,
    confidence: null,
    fieldConfidenceJson: "{}",
    reviewReasonsJson: "[]",
    duplicateOfTransactionId: null,
    orderNo: "ORD-9",
    paymentNo: "PAY-7",
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
    reviewedAt: null,
    deletedAt: null,
    ...over,
  };
}

describe("duplicateQueryFromTransaction", () => {
  it("maps the dedup keys and excludes the transaction itself", () => {
    const tx = makeTx({});
    expect(duplicateQueryFromTransaction(tx)).toEqual({
      projectId: "proj-1",
      spentAt: "2026-06-20",
      amountMinor: 5000,
      merchant: "스타벅스",
      orderNo: "ORD-9",
      paymentNo: "PAY-7",
      source: "gmail",
      sourceRef: "gmail:abc",
      excludeTransactionId: "tx-1",
    });
  });

  it("passes null optional keys through unchanged", () => {
    const query = duplicateQueryFromTransaction(
      makeTx({ orderNo: null, paymentNo: null, sourceRef: null, projectId: null }),
    );
    expect(query.orderNo).toBeNull();
    expect(query.paymentNo).toBeNull();
    expect(query.sourceRef).toBeNull();
    expect(query.projectId).toBeNull();
    expect(query.excludeTransactionId).toBe("tx-1");
  });
});

describe("formatDuplicateScore", () => {
  it("renders a fractional score as a rounded percentage", () => {
    expect(formatDuplicateScore(0.95)).toBe("95%");
    expect(formatDuplicateScore(1)).toBe("100%");
    expect(formatDuplicateScore(0.3)).toBe("30%");
  });

  it("renders a missing score as an em dash", () => {
    expect(formatDuplicateScore(null)).toBe("—");
  });
});
