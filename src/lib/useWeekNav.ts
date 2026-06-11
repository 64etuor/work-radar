// src/lib/useWeekNav.ts
import { useState } from "react";

import { localToday } from "@/lib/query";

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
  const [offset, setOffset] = useState(0);
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
