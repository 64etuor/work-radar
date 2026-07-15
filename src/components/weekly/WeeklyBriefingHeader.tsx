import type { WeekRange } from "@/lib/weekRange";

import { WeekNavigator } from "./WeekNavigator";
import { WeekScrubber } from "./WeekScrubber";

interface WeeklyBriefingHeaderProps {
  range: WeekRange;
  isCurrent: boolean;
  isOldest: boolean;
  today: string;
  selectedOffset: number;
  countByOffset: Record<number, number>;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
  onSelect: (offset: number) => void;
}

export function WeeklyBriefingHeader({
  range,
  isCurrent,
  isOldest,
  today,
  selectedOffset,
  countByOffset,
  onPrev,
  onNext,
  onReset,
  onSelect,
}: WeeklyBriefingHeaderProps) {
  return (
    <header className="wk-head" data-tauri-drag-region>
      <div className="wk-head-inner">
        <div className="wk-heading">
          <span className="wk-eyebrow">REVIEW / WEEKLY BRIEFING</span>
          <h1>Weekly Review</h1>
          <p>이번 주의 방향과 실행 증거를 읽고, 다음 판단은 직접 확정합니다.</p>
        </div>
        <WeekNavigator
          range={range}
          isCurrent={isCurrent}
          isOldest={isOldest}
          onPrev={onPrev}
          onNext={onNext}
          onReset={onReset}
        />
      </div>
      <WeekScrubber
        today={today}
        selectedOffset={selectedOffset}
        countByOffset={countByOffset}
        onSelect={onSelect}
      />
    </header>
  );
}
