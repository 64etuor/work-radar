import type { BookkeepingPaymentMethodKind } from "@/bindings";

import { paymentMethodLabel } from "../bookkeepingLabels";

export function ensureSelectOption<T extends { value: string; label: string }>(
  items: T[],
  value: string,
) {
  if (!value || items.some((item) => item.value === value)) {
    return items;
  }
  return [...items, { value, label: value }];
}

export function paymentSummary(
  kind: BookkeepingPaymentMethodKind,
  label: string | null,
  last4: string | null,
) {
  const base = paymentMethodLabel(kind);
  const detail = [label, last4 ? `끝 ${last4}` : null].filter(Boolean).join(" · ");
  return detail ? `${base} · ${detail}` : base;
}
