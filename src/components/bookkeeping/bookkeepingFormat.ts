import { APP_LOCALE } from "@/lib/localeFormat";

/** KRW 고정 집계 포맷터. 합계류는 통화 혼합 시 의미가 흐려지는 기존 한계 그대로 —
 *  기본 통화 설정(bookkeeping.default_currency)을 집계 표시에 반영하는 작업은 deferred
 *  (docs/plans/2026-07-10-generalization-plan.md Non-goals 참조). */
export const currency = new Intl.NumberFormat(APP_LOCALE, {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** 최소단위 지수 — Rust `bookkeeping_export::currency_exponent`(KRW/JPY=0, 그 외 2)와 정합.
 *  Intl 자체 지수(예: BHD=3)로 바꾸면 백엔드 해석과 어긋난다. */
function currencyExponent(currencyCode: string) {
  return currencyCode === "KRW" || currencyCode === "JPY" ? 0 : 2;
}

export function formatCurrencyMinor(amountMinor: number, currencyCode: string) {
  const exponent = currencyExponent(currencyCode);
  const amount = amountMinor / 10 ** exponent;
  return new Intl.NumberFormat(APP_LOCALE, {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amount);
}
