/** 분 → "45m" | "3h" | "1h 30m". 소수 입력은 정수 절사. */
export function fmtMinutes(min: number): string {
  const totalMinInt = Math.floor(min);
  if (totalMinInt <= 0) return "0m";
  const h = Math.floor(totalMinInt / 60);
  const m = totalMinInt % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Today 등록 후 경과일(1일째부터) — frontend-board 정본 공식 (today − today_for_date) + 1. */
export function todayAgeDays(todayForDate: string, today: string): number {
  const diff =
    new Date(`${today}T00:00:00`).getTime() - new Date(`${todayForDate}T00:00:00`).getTime();
  if (Number.isNaN(diff)) return 1;
  return Math.max(0, Math.round(diff / 86_400_000)) + 1;
}
