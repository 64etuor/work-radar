export function budgetBarPercent(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(100, Math.round(pct * 100));
}

export function isBudgetOverrun(remainingMinor: number): boolean {
  return remainingMinor < 0;
}
