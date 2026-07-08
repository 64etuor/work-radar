export const currency = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

function currencyExponent(currencyCode: string) {
  return currencyCode === "KRW" || currencyCode === "JPY" ? 0 : 2;
}

export function formatCurrencyMinor(amountMinor: number, currencyCode: string) {
  const exponent = currencyExponent(currencyCode);
  const amount = amountMinor / 10 ** exponent;
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: currencyCode,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(amount);
}
