import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { TimelineBlock } from "@/components/today/TimelineBlock";
import type { LayoutBox } from "@/lib/timelineLayout";

const HOUR_PX = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  date: string;
  today: string;
  boxes: LayoutBox[];
  onBlockClick: (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => void;
};

function nowOffsetPx(): number {
  const d = new Date();
  return (d.getHours() + d.getMinutes() / 60) * HOUR_PX;
}

/**
 * 24시간 read-only 그리드(스펙 §3·§D2). 1시간=60px, 총 1440px.
 * "현재 시각" 빨간 선은 `date === today`일 때만 표시 — 다른 날 보기에선 노출 금지.
 * PR 4에서 블록 레이어 추가(클릭 = EventPopover). 드래그는 PR 5.
 */
export function TimelineCanvas({ date, today, boxes, onBlockClick }: Props) {
  const [nowPx, setNowPx] = useState<number>(() => nowOffsetPx());

  useEffect(() => {
    if (date !== today) return;
    const t = setInterval(() => setNowPx(nowOffsetPx()), 60_000);
    return () => clearInterval(t);
  }, [date, today]);

  const showNow = date === today;

  return (
    <div className="today-canvas" data-date={date}>
      <div className="today-canvas-grid" style={{ height: `${24 * HOUR_PX}px` }}>
        {HOURS.map((h) => (
          <div
            key={h}
            className="today-canvas-hour"
            style={{ top: `${h * HOUR_PX}px` }}
          >
            <span className="today-canvas-hour-label">
              {String(h).padStart(2, "0")}:00
            </span>
            <div className="today-canvas-hour-rule" />
          </div>
        ))}
        {boxes.map((b) => (
          <TimelineBlock key={b.id} box={b} onClick={onBlockClick} />
        ))}
        {showNow && (
          <div
            className="today-canvas-now"
            style={{ top: `${nowPx}px` }}
            aria-label="현재 시각"
          />
        )}
      </div>
    </div>
  );
}
