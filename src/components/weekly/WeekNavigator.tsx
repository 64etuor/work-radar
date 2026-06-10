// src/components/weekly/WeekNavigator.tsx
import { ChevronLeft, ChevronRight } from "lucide-react";

import { isoWeekNumber, type WeekRange } from "@/lib/weekRange";

function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface Props {
  range: WeekRange;
  isCurrent: boolean;
  isOldest: boolean;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
}

export function WeekNavigator({ range, isCurrent, isOldest, onPrev, onNext, onReset }: Props) {
  return (
    <div className="wk-nav">
      <div className="wk-pager">
        <button type="button" onClick={onPrev} disabled={isOldest} aria-label="이전 주">
          <ChevronLeft className="size-4" />
        </button>
        <span className="wk-cur">
          {isoWeekNumber(range.end)}주차
          <small>
            {md(range.start)} – {md(range.end)}
          </small>
        </span>
        <button type="button" onClick={onNext} disabled={isCurrent} aria-label="다음 주">
          <ChevronRight className="size-4" />
        </button>
      </div>
      {!isCurrent && (
        <button type="button" className="wk-today-btn" onClick={onReset}>
          이번 주로
        </button>
      )}
    </div>
  );
}
