// Control Room 헤더 — 에이전트 사용량 게이지 표시 헬퍼 (순수 함수, 테스트 대상).

export type UsageTone = "ok" | "warn" | "crit";

/** 사용률 → 게이지 톤. 70% 미만 평시, 70–90 경고, 90 이상 위험. */
export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 90) return "crit";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

/** 윈도 id → 마이크로 라벨 (백엔드 id는 "five_hour" | "weekly"). */
export function usageWindowLabel(id: string): string {
  if (id === "five_hour") return "5H";
  if (id === "weekly") return "WK";
  return id.toUpperCase();
}

/** 리셋까지 남은 시간을 "2d 3h" / "4h 12m" / "45m"으로. 과거/파싱 불가면 null. */
export function formatResetIn(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return null;
  const diffMs = t - nowMs;
  if (diffMs <= 0) return null;
  const totalMin = Math.ceil(diffMs / 60_000);
  const d = Math.floor(totalMin / 1_440);
  const h = Math.floor((totalMin % 1_440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** 툴팁용 리셋 절대 시각 (로컬 타임존, "6. 11. 15:00"). 파싱 불가면 null. */
export function formatResetAt(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
