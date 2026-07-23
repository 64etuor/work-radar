import { describe, expect, it } from "vitest";

import type { BookkeepingRecurringMonthRow } from "@/bindings";

import { formatShortDate, recurringPaymentBadge } from "./recurringMirror";

function row(overrides: Partial<BookkeepingRecurringMonthRow>): BookkeepingRecurringMonthRow {
  return {
    ruleId: "r1",
    name: "주택청약",
    merchant: "청약(49)",
    amountMinor: 100_000,
    currency: "KRW",
    category: "주거/통신",
    scheduleDay: 22,
    dueDate: "2026-07-22",
    paid: false,
    matchedTransactionId: null,
    matchedSpentAt: null,
    ...overrides,
  };
}

describe("recurringPaymentBadge", () => {
  it("납부된 규칙은 실거래 일자를 표시한다", () => {
    const badge = recurringPaymentBadge(
      row({ paid: true, matchedTransactionId: "t1", matchedSpentAt: "2026-07-20" }),
      "2026-07-23",
    );
    expect(badge.kind).toBe("paid");
    expect(badge.label).toContain("납부됨");
    expect(badge.label).toContain(formatShortDate("2026-07-20"));
  });

  it("결제일이 지나지 않은 미납은 예정이다", () => {
    const badge = recurringPaymentBadge(row({ dueDate: "2026-07-25" }), "2026-07-23");
    expect(badge.kind).toBe("upcoming");
    expect(badge.label).toContain("예정");
  });

  it("결제일이 지난 미납은 미납으로 표시한다", () => {
    const badge = recurringPaymentBadge(row({ dueDate: "2026-07-10" }), "2026-07-23");
    expect(badge.kind).toBe("overdue");
    expect(badge.label).toContain("미납");
  });

  it("결제일 당일은 아직 미납이 아니다", () => {
    const badge = recurringPaymentBadge(row({ dueDate: "2026-07-23" }), "2026-07-23");
    expect(badge.kind).toBe("upcoming");
  });
});

describe("formatShortDate", () => {
  it("잘못된 형식은 원문을 그대로 돌려준다", () => {
    expect(formatShortDate("not-a-date")).toBe("not-a-date");
  });
});
