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
export function TimelineCanvas({ date, today, boxes, onBlockClick }: Props) {
  const [nowPx, setNowPx] = useState<number>(() => nowOffsetPx());
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (date !== today) return;
    const t = setInterval(() => setNowPx(nowOffsetPx()), 60_000);
    return () => clearInterval(t);
  }, [date, today]);

  const showNow = date === today;

  // dropData는 매 drop마다 useDroppable 등록 시점의 객체로 잠겨버린다 — gridY는 별도
  // pointer move 기반으로 추정(setHoverPx) → onDragEnd에서 hoverPx를 함께 dispatch하기 위해
  // dropData에는 동적 ref를 담는다(아래 callback 객체로 마지막 hoverPx를 노출).
  const dropDataRef = useRef<DropData>({ to: "canvas", gridY: 0 });
  const dropData: DropData = dropDataRef.current;
  const { setNodeRef, isOver } = useDroppable({ id: "today-canvas", data: dropData });

  // pointer-tracking: 캔버스 위 pointer Y를 그리드 로컬 좌표로 환산해 ref+state 둘 다 갱신.
  // - state(setHoverPx)는 가이드 라인 렌더용
  // - ref(dropDataRef.current.gridY)는 onDragEnd에서 마지막 위치를 dispatch
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(24 * HOUR_PX, e.clientY - rect.top));
    setHoverPx(y);
    if (dropData.to === "canvas") {
      // dropData는 mutable — useDroppable이 내부적으로 ref로 보관해 매 drop 시 최신 값을 본다.
      (dropData as { to: "canvas"; gridY: number }).gridY = y;
    }
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
        {isOver && hoverPx !== null && (
          <div
            className="today-canvas-drop-guide"
            style={{ top: `${Math.round(hoverPx / 15) * 15}px` }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
