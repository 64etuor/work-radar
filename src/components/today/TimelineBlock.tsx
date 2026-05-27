import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Repeat } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { LayoutBox } from "@/lib/timelineLayout";
import type { DragData } from "@/components/today/useTimelineDnd";

type Props = {
  box: LayoutBox;
  onClick: (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => void;
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 시간축 위 단일 블록(스펙 §D8 카드 정본).
 * PR 5: signal 종류 블록만 draggable(canvas reschedule / unschedule / cross-cal).
 * event/routine 가상 블록은 클릭만 — 외부 캘린더 또는 별도 routine 처리(스펙 §7).
 */
export function TimelineBlock({ box, onClick }: Props) {
  const { block, topPx, heightPx, leftPct, widthPct } = box;
  const isSignal = block.kind === "signal";
  // signal 블록만 draggable — id는 signal:{signalId} 패턴(block.id).
  const signalId = isSignal ? block.id.replace(/^signal:/, "") : "";
  const dragData: DragData | undefined = isSignal
    ? {
        from: "canvas",
        signalId,
        title: block.title,
        startISO: block.startISO,
        durationMin: Math.max(
          15,
          Math.round((new Date(block.endISO).getTime() - new Date(block.startISO).getTime()) / 60000),
        ),
        calendarId: block.calendarId,
      }
    : undefined;
  const drag = useDraggable({
    id: `block:${block.id}`,
    data: dragData,
    disabled: !isSignal,
  });

  const transformStyle = drag.transform
    ? { transform: CSS.Translate.toString(drag.transform) }
    : {};

  const isDoneRoutine = block.kind === "routine" && block.done === true;

  // a11y: 색만으로 의미 전달 X — aria-label에 시간/캘린더/완료 상태를 텍스트로 노출.
  // 스크린리더 사용자가 "title 09:30–10:00 (cal-id) 완료됨" 형태로 듣게 된다.
  const ariaLabel = [
    block.title,
    `${hhmm(block.startISO)}–${hhmm(block.endISO)}`,
    block.calendarId ? `(${block.calendarId})` : `(${block.kind})`,
    isDoneRoutine ? "완료됨" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={isSignal ? drag.setNodeRef : undefined}
      type="button"
      className={`tl-block tl-block-${block.kind}${isDoneRoutine ? " tl-block-done" : ""}`}
      data-done={isDoneRoutine || undefined}
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        // 60px 라벨 거터 안쪽 영역에서 leftPct/widthPct를 백분율로 적용.
        left: `calc(60px + ((100% - 60px) * ${leftPct} / 100))`,
        width: `calc(((100% - 60px) * ${widthPct} / 100) - 4px)`,
        borderLeftColor: block.color,
        ...transformStyle,
        ...(drag.isDragging ? { opacity: 0.7, zIndex: 10 } : {}),
      }}
      onClick={(e) => onClick(box, e)}
      title={block.title}
      {...(isSignal ? drag.attributes : {})}
      {...(isSignal ? drag.listeners : {})}
      aria-label={ariaLabel}
    >
      <div className="tl-block-time">
        {hhmm(block.startISO)}–{hhmm(block.endISO)}
      </div>
      <div className="tl-block-title">
        {block.kind === "routine" && (
          <Repeat className="tl-block-icon" aria-hidden />
        )}
        {block.title}
      </div>
    </button>
  );
}
