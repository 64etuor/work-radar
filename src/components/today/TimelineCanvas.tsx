import { useEffect, useState } from "react";

const HOUR_PX = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  date: string;
  today: string;
};

function nowOffsetPx(): number {
  const d = new Date();
  return (d.getHours() + d.getMinutes() / 60) * HOUR_PX;
}

/**
 * 24시간 read-only 그리드(스펙 §3·§D2). 1시간=60px, 총 1440px.
 * "현재 시각" 빨간 선은 `date === today`일 때만 표시 — 다른 날 보기에선 노출 금지.
 * 블록 렌더는 PR 4, 드래그는 PR 5에서 추가한다.
 */
export function TimelineCanvas({ date, today }: Props) {
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
