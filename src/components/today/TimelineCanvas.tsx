import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useDroppable } from "@dnd-kit/core";

import { TimelineBlock } from "@/components/today/TimelineBlock";
import type { DropData } from "@/components/today/useTimelineDnd";
import type { LayoutBox } from "@/lib/timelineLayout";

const HOUR_PX = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  date: string;
  today: string;
  boxes: LayoutBox[];
  onBlockClick: (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => void;
  /**
   * 캔버스 그리드 로컬 좌표(Y)를 기록하는 ref. 부모(TodayView)가 소유하고 useTimelineDnd가
   * onDragEnd에서 마지막 hover Y를 읽는다. dropData에 mutable 객체를 박는 antipattern을 회피.
   */
  pointerYRef?: React.MutableRefObject<number | null>;
};

function nowOffsetPx(): number {
  const d = new Date();
  return (d.getHours() + d.getMinutes() / 60) * HOUR_PX;
}

/**
 * 24h 캔버스(스펙 §3·§D2). 1시간=60px, 총 1440px.
 * PR 5: 그리드 전체가 droppable("canvas") — drop 시 그리드 내부 Y 좌표(gridY)를 dropData에 담아
 * useTimelineDnd가 15분 스냅 ISO로 변환. 드래그 중 hover Y는 setHoverY로 가이드 라인 렌더(선택).
 */
export function TimelineCanvas({ date, today, boxes, onBlockClick, pointerYRef }: Props) {
  const [nowPx, setNowPx] = useState<number>(() => nowOffsetPx());
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (date !== today) return;
    const t = setInterval(() => setNowPx(nowOffsetPx()), 60_000);
    return () => clearInterval(t);
  }, [date, today]);

  const showNow = date === today;

  // dropData는 상수 — gridY는 dropData에 박지 않는다(@dnd-kit가 register 시점 스냅샷할
  // 위험 + mutable ref antipattern). 실제 Y 좌표는 부모 pointerYRef에 기록되어
  // useTimelineDnd가 onDragEnd에서 읽는다.
  const dropData: DropData = { to: "canvas", gridY: 0 };
  const { setNodeRef, isOver } = useDroppable({ id: "today-canvas", data: dropData });

  // pointer-tracking: 캔버스 위 pointer Y를 그리드 로컬 좌표로 환산.
  // - state(setHoverPx)는 가이드 라인 렌더용(이 컴포넌트 내부).
  // - 부모 pointerYRef는 onDragEnd에서 마지막 위치를 읽는 용도(props로 주입).
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(24 * HOUR_PX, e.clientY - rect.top));
    setHoverPx(y);
    if (pointerYRef) pointerYRef.current = y;
  }

  function onPointerLeave() {
    setHoverPx(null);
  }

  return (
    <div
      className="today-canvas"
      data-date={date}
      data-drop-over={isOver || undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div
        ref={(el) => {
          gridRef.current = el;
          setNodeRef(el);
        }}
        className="today-canvas-grid"
        style={{ height: `${24 * HOUR_PX}px` }}
      >
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
        {isOver && hoverPx !== null && (() => {
          // 15분 그리드 스냅 — 분 단위로 환산해 라벨까지 표시(스펙 §D2).
          // HOUR_PX=60이라 1min=1px, snap = round(min/15)*15.
          const snapMin = Math.max(0, Math.min(24 * 60, Math.round(hoverPx / 15) * 15));
          const hh = String(Math.floor(snapMin / 60)).padStart(2, "0");
          const mm = String(snapMin % 60).padStart(2, "0");
          return (
            <div
              className="today-canvas-drop-guide"
              style={{ top: `${snapMin}px` }}
              data-time={`${hh}:${mm}`}
              aria-hidden
            />
          );
        })()}
      </div>
    </div>
  );
}
