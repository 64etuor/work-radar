export function reportSeriesMax(values: number[]): number {
  const max = values.reduce((current, value) => {
    if (!Number.isFinite(value)) return current;
    return Math.max(current, Math.abs(value));
  }, 0);
  return Math.max(1, max);
}

export function reportBarPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.round((Math.abs(value) / max) * 100));
}
