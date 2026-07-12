// src/lib/useWeekNav.ts
import { localToday } from "@/lib/query";

import { useViewSessionState } from "./useViewSessionState";
import { type WeekRange, weekRangeForOffset, WEEKS_WINDOW } from "./weekRange";

/** offset를 [-(WEEKS_WINDOW-1), 0] 범위로 clamp. 0=이번 주(미래 차단), 음수=과거. */
export function clampOffset(offset: number): number {
  if (offset > 0) return 0;
  const oldest = -(WEEKS_WINDOW - 1);
  return offset < oldest ? oldest : offset;
}

export interface WeekNav {
  offset: number; // 0=이번 주
  range: WeekRange; // {start 월, end 일}
  today: string;
  isCurrent: boolean; // offset === 0
  isOldest: boolean;
  prev: () => void;
  next: () => void;
  goto: (offset: number) => void;
  reset: () => void;
}

export function useWeekNav(): WeekNav {
  const today = localToday();
  // 뷰 전환에도 보던 주가 유지되도록 세션 상태(리마운트 생존, 재시작 시 이번 주로 리셋).
  const [offset, setOffset] = useViewSessionState("weekly.offset", 0);
  const goto = (o: number) => setOffset(clampOffset(o));
  const prev = () => setOffset((o) => clampOffset(o - 1));
  const next = () => setOffset((o) => clampOffset(o + 1));
  const reset = () => setOffset(0);
  return {
    offset,
    range: weekRangeForOffset(today, offset),
    today,
    isCurrent: offset === 0,
    isOldest: offset === -(WEEKS_WINDOW - 1),
    prev,
    next,
    goto,
    reset,
  };
}
