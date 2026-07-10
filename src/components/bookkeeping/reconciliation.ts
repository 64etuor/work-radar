import { APP_LOCALE } from "@/lib/localeFormat";

export type ReconciliationTone = "matched" | "over" | "under";

export function reconciliationTone(differenceMinor: number): ReconciliationTone {
  if (differenceMinor === 0) return "matched";
  return differenceMinor > 0 ? "over" : "under";
}

export function signedMinorLabel(value: number): string {
  if (value === 0) return "0";
  const sign = value > 0 ? "+" : "-";
  return `${sign}${Math.abs(value).toLocaleString(APP_LOCALE)}`;
}
