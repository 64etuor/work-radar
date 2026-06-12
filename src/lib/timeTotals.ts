/** 분 → "45m" | "3h" | "1h 30m". */
export function fmtMinutes(min: number): string {
  if (min <= 0) return "0m";
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Today 등록 후 경과일(1일째부터) — frontend-board 정본 공식 (today − today_for_date) + 1. */
export function todayAgeDays(todayForDate: string, today: string): number {
  const diff =
    new Date(`${today}T00:00:00`).getTime() - new Date(`${todayForDate}T00:00:00`).getTime();
  return Math.max(0, Math.round(diff / 86_400_000)) + 1;
}
