import type { BookkeepingExpenseKind, BookkeepingPaymentMethodKind } from "@/bindings";

export const CATEGORY_OPTIONS = [
  "food",
  "transport",
  "shopping",
  "housing",
  "health",
  "work",
  "misc",
];
export const ALL_PROJECTS = "__all__";

export const PAYMENT_METHOD_OPTIONS: { value: BookkeepingPaymentMethodKind; label: string }[] = [
  { value: "unknown", label: "미정" },
  { value: "card", label: "카드" },
  { value: "bank_transfer", label: "계좌이체" },
  { value: "simple_pay", label: "간편결제" },
  { value: "cash", label: "현금" },
];

export const EXPENSE_KIND_OPTIONS: { value: BookkeepingExpenseKind; label: string }[] = [
  { value: "variable", label: "변동비" },
  { value: "fixed", label: "고정비" },
  { value: "subscription", label: "구독" },
  { value: "installment", label: "할부" },
];

export const RECURRING_EXPENSE_KIND_OPTIONS = EXPENSE_KIND_OPTIONS.filter(
  (option) => option.value !== "variable",
);

export const FIELD_IDS = {
  projectScope: "bk-project-scope",
  gmailLabels: "bk-gmail-labels",
  gmailQuery: "bk-gmail-query",
  mmbakWatchDir: "bk-mmbak-watch-dir",
  mmbakAutoImport: "bk-mmbak-auto-import",
  recurringName: "bk-recurring-name",
  recurringMerchant: "bk-recurring-merchant",
  recurringAmount: "bk-recurring-amount",
  recurringDay: "bk-recurring-day",
  recurringStart: "bk-recurring-start",
  recurringCategory: "bk-recurring-category",
  recurringPaymentKind: "bk-recurring-payment-kind",
  recurringPaymentLabel: "bk-recurring-payment-label",
  recurringPaymentLast4: "bk-recurring-payment-last4",
  recurringExpenseKind: "bk-recurring-expense-kind",
  recurringNote: "bk-recurring-note",
  recurringPanel: "bk-recurring-panel",
  budgetCategory: "bk-budget-category",
  budgetAmount: "bk-budget-amount",
  budgetRollover: "bk-budget-rollover",
  budgetNote: "bk-budget-note",
  reconcileAccount: "bk-reconcile-account",
  reconcileDate: "bk-reconcile-date",
  reconcileBalance: "bk-reconcile-balance",
  reconcileCurrency: "bk-reconcile-currency",
  reconcileNote: "bk-reconcile-note",
  merchant: "bk-manual-merchant",
  amount: "bk-manual-amount",
  spentAt: "bk-manual-spent-at",
  category: "bk-manual-category",
  paymentKind: "bk-manual-payment-kind",
  paymentLabel: "bk-manual-payment-label",
  paymentLast4: "bk-manual-payment-last4",
  expenseKind: "bk-manual-expense-kind",
  note: "bk-manual-note",
  manualPanel: "bk-manual-panel",
};
