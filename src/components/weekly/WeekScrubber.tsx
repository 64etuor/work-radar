// src/components/weekly/WeekScrubber.tsx
import { useEffect, useRef } from "react";

import { cn } from "@/components/ui/cn";
import { isoWeekNumber, weekRangeForOffset, WEEKS_WINDOW } from "@/lib/weekRange";

interface Props {
  today: string;
  selectedOffset: number; // 0..-(WEEKS_WINDOW-1)
  countByOffset: Record<number, number>; // 주별 완료 수(스파크 높이)
  onSelect: (offset: number) => void;
}

export function WeekScrubber({ today, selectedOffset, countByOffset, onSelect }: Props) {
  const ref = useRef<HTMLElement>(null);
  const offsets: number[] = [];
  for (let o = -(WEEKS_WINDOW - 1); o <= 0; o++) offsets.push(o);
  const max = Math.max(1, ...Object.values(countByOffset));

  // 최신(우측)으로 스크롤
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, []);

  return (
    <nav className="wk-scrub" ref={ref} aria-label="최근 12주 활동">
      {offsets.map((o) => {
        const r = weekRangeForOffset(today, o);
        const count = countByOffset[o] ?? 0;
        const h = 8 + Math.round((count / max) * 30);
        return (
          <button
            key={o}
            type="button"
            className={cn("wk-week", o === selectedOffset && "on")}
            onClick={() => onSelect(o)}
            title={`${isoWeekNumber(r.end)}주차 · 완료 ${count}`}
            aria-pressed={o === selectedOffset}
          >
            <span className="wk-spark">
              <i style={{ height: `${h}px` }} />
            </span>
            <span className="wk-week-lab">{isoWeekNumber(r.end)}</span>
          </button>
        );
      })}
    </nav>
  );
}
