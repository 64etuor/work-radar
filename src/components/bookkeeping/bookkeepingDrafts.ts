import type {
  BookkeepingDirection,
  BookkeepingExpenseKind,
  BookkeepingPaymentMethodKind,
  BookkeepingTransaction,
} from "@/bindings";
import { localToday } from "@/lib/query";

import { GMAIL_DEFAULT_QUERY } from "./gmailSync";

export type ManualDraft = {
  merchant: string;
  amount: string;
  spentAt: string;
  category: string;
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
  expenseKind: BookkeepingExpenseKind;
  note: string;
};

export type TransactionEditDraft = {
  merchant: string;
  amount: string;
  currency: string;
  spentAt: string;
  spentAtTime: string;
  direction: BookkeepingDirection;
  categoryCode: string;
  subcategoryCode: string;
  note: string;
  description: string;
  account: string;
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
  expenseKind: BookkeepingExpenseKind;
  orderNo: string;
  paymentNo: string;
};

export type ReconciliationDraft = {
  account: string;
  statementDate: string;
  statementBalance: string;
  currency: string;
  note: string;
};

export type GmailSyncDraft = {
  labels: string;
  query: string;
};

export function emptyManualDraft(): ManualDraft {
  return {
    merchant: "",
    amount: "",
    spentAt: localToday(),
    category: "food",
    paymentMethodKind: "unknown",
    paymentMethodLabel: "",
    paymentMethodLast4: "",
    expenseKind: "variable",
    note: "",
  };
}

export function emptyReconciliationDraft(): ReconciliationDraft {
  return {
    account: "",
    statementDate: localToday(),
    statementBalance: "",
    // 빈 값 = 앱 기본 통화(bookkeeping.default_currency, 백엔드가 채움) — KRW 하드코딩 제거.
    currency: "",
    note: "",
  };
}

export function emptyGmailSyncDraft(): GmailSyncDraft {
  return {
    labels: "가계부",
    query: GMAIL_DEFAULT_QUERY,
  };
}

/**
 * 편집 폼과 인라인 분류 quick action이 공유하는 유효 분류 코드.
 * 레거시 행은 `categoryCode`가 null이고 `category` 문자열만 있다 — 표시/변경/no-op
 * 판정 모두 이 fallback을 거쳐야 한다(로직 중복 금지).
 */
export function effectiveCategoryCode(
  tx: Pick<BookkeepingTransaction, "categoryCode" | "category">,
): string {
  return tx.categoryCode ?? tx.category;
}

export function editDraftFromTransaction(tx: BookkeepingTransaction): TransactionEditDraft {
  return {
    merchant: tx.merchant,
    amount: String(tx.amountMinor),
    currency: tx.currency,
    spentAt: tx.spentAt,
    spentAtTime: tx.spentAtTime ?? "",
    direction: tx.direction,
    categoryCode: effectiveCategoryCode(tx),
    subcategoryCode: tx.subcategoryCode ?? "",
    note: tx.note ?? "",
    description: tx.description ?? "",
    account: tx.account ?? "",
    paymentMethodKind: tx.paymentMethodKind,
    paymentMethodLabel: tx.paymentMethodLabel ?? "",
    paymentMethodLast4: tx.paymentMethodLast4 ?? "",
    expenseKind: tx.expenseKind,
    orderNo: tx.orderNo ?? "",
    paymentNo: tx.paymentNo ?? "",
  };
}
