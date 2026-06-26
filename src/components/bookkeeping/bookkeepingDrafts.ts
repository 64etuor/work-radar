import type {
  BookkeepingDirection,
  BookkeepingExpenseKind,
  BookkeepingPaymentMethodKind,
  BookkeepingTransaction,
} from "@/bindings";
import { localToday } from "@/lib/query";

import { currentMonth } from "./bookkeepingMonth";
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

export type RecurringDraft = {
  name: string;
  merchant: string;
  amount: string;
  scheduleDay: string;
  startMonth: string;
  category: string;
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
  expenseKind: BookkeepingExpenseKind;
  note: string;
};

export type BudgetDraft = {
  category: string;
  amount: string;
  rollover: boolean;
  note: string;
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

export function emptyRecurringDraft(): RecurringDraft {
  return {
    name: "",
    merchant: "",
    amount: "",
    scheduleDay: "1",
    startMonth: currentMonth(),
    category: "housing",
    paymentMethodKind: "bank_transfer",
    paymentMethodLabel: "",
    paymentMethodLast4: "",
    expenseKind: "fixed",
    note: "",
  };
}

export function emptyBudgetDraft(): BudgetDraft {
  return {
    category: "food",
    amount: "",
    rollover: false,
    note: "",
  };
}

export function emptyReconciliationDraft(): ReconciliationDraft {
  return {
    account: "",
    statementDate: localToday(),
    statementBalance: "",
    currency: "KRW",
    note: "",
  };
}

export function emptyGmailSyncDraft(): GmailSyncDraft {
  return {
    labels: "가계부",
    query: GMAIL_DEFAULT_QUERY,
  };
}

export function editDraftFromTransaction(tx: BookkeepingTransaction): TransactionEditDraft {
  return {
    merchant: tx.merchant,
    amount: String(tx.amountMinor),
    currency: tx.currency,
    spentAt: tx.spentAt,
    spentAtTime: tx.spentAtTime ?? "",
    direction: tx.direction,
    categoryCode: tx.categoryCode ?? tx.category,
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
