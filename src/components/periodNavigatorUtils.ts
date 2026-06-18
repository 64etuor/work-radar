const MONTH_VALUE_RE = /^(\d{4})-(\d{2})$/;

function padMonth(month: number): string {
  return String(month).padStart(2, "0");
}

export function stepMonthValue(month: string, direction: -1 | 1): string {
  const match = MONTH_VALUE_RE.exec(month);
  if (!match) {
    return month;
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const next = new Date(year, monthIndex + direction, 1);
  return `${next.getFullYear()}-${padMonth(next.getMonth() + 1)}`;
}

export function formatMonthValue(month: string): string {
  const match = MONTH_VALUE_RE.exec(month);
  return match ? `${match[1]}.${match[2]}` : month;
}
