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

/**
 * 원장 결제·자산 셀 요약 — payment_method_*와 account(자산)를 하나의 셀에서 보여준다.
 * .mmbak 임포트는 자산(ASSETS.NIC_NAME)이 `account`로만 저장되고 payment_method_kind는
 * unknown이라, 기존 paymentSummary만 쓰면 "미확인"으로 떠 자산 정보가 숨었다(정합성 피드백
 * 2026-07-04). unknown kind는 표기에서 생략하고, 자산이 표시명과 중복이면 한 번만 보여준다.
 */
export function paymentAssetSummary(
  kind: BookkeepingPaymentMethodKind,
  label: string | null,
  last4: string | null,
  account: string | null,
) {
  const parts = [
    kind !== "unknown" ? paymentMethodLabel(kind) : null,
    label,
    last4 ? `끝 ${last4}` : null,
    account && account !== label ? account : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "—";
}
