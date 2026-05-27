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
 * 블록 하단 리사이즈 핸들 (PR 7 spec §7 row 3).
 * 별도 useDraggable로 등록 — `from: "canvas-resize"` 분기로 useTimelineDnd가
 * ev.delta.y → durationMin 재계산 후 stage(resize).
 *
 * 블록 button의 형제로 배치(중첩 interactive 회피) — 컨테이너 div가 둘을 같은 좌표계로 묶는다.
 */
function ResizeHandle({
  signalId,
  startISO,
  durationMin,
}: {
  signalId: string;
  startISO: string;
  durationMin: number;
}) {
  const data: DragData = {
    from: "canvas-resize",
    signalId,
    startISO,
    durationMin,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `resize:${signalId}`,
    data,
  });
  // 부모 .tl-block-wrap 안에서 button과 형제 — pointer 이벤트가 button의 dnd-kit
  // listener로 버블되지 않으므로 별도 stopPropagation 불필요.
  return (
    <div
      ref={setNodeRef}
      className="tl-block-resize"
      data-dragging={isDragging || undefined}
      aria-label="블록 길이 조정"
      {...attributes}
      {...listeners}
    />
  );
}

/**
 * 시간축 위 단일 블록(스펙 §D8 카드 정본).
 * PR 5: signal 종류 블록만 draggable(canvas reschedule / unschedule / cross-cal).
 * PR 7: signal 블록 하단에 ResizeHandle 추가 (스펙 §7 row 3).
 * event/routine 가상 블록은 클릭만 — 외부 캘린더 또는 별도 routine 처리(스펙 §7).
 *
 * 구조: 컨테이너 <div> 안에 <button>(클릭/드래그) + <ResizeHandle>(별도 draggable).
 * 중첩 interactive 회피를 위해 핸들은 button의 형제. 컨테이너는 absolutely-positioned.
 */
export function TimelineBlock({ box, onClick }: Props) {
  const { block, topPx, heightPx, leftPct, widthPct } = box;
  const isSignal = block.kind === "signal";
  const signalId = isSignal ? block.id.replace(/^signal:/, "") : "";
  // 실제 endISO−startISO 그대로 — 15분 floor는 dispatcher(useTimelineDnd) 책임.
  const durationMin = Math.round(
    (new Date(block.endISO).getTime() - new Date(block.startISO).getTime()) /
      60000,
  );
  const dragData: DragData | undefined = isSignal
    ? {
        from: "canvas",
        signalId,
        title: block.title,
        startISO: block.startISO,
        durationMin,
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

  const ariaLabel = [
    block.title,
    `${hhmm(block.startISO)}–${hhmm(block.endISO)}`,
    block.calendarId ? `(${block.calendarId})` : `(${block.kind})`,
    isDoneRoutine ? "완료됨" : null,
  ]
    .filter(Boolean)
    .join(" ");

  // 컨테이너가 좌표/transform/opacity를 소유 — block button은 컨테이너 100% 채움.
  // resize handle은 컨테이너 하단 4px 띠.
  return (
    <div
      className="tl-block-wrap"
      data-dragging={drag.isDragging || undefined}
      style={{
        position: "absolute",
        top: `${topPx}px`,
        height: `${heightPx}px`,
        left: `calc(60px + ((100% - 60px) * ${leftPct} / 100))`,
        width: `calc(((100% - 60px) * ${widthPct} / 100) - 4px)`,
        zIndex: drag.isDragging ? 10 : 2,
        ...transformStyle,
        ...(drag.isDragging ? { opacity: 0.7 } : {}),
      }}
    >
      <button
        ref={isSignal ? drag.setNodeRef : undefined}
        type="button"
        className={`tl-block tl-block-${block.kind}${isDoneRoutine ? " tl-block-done" : ""}`}
        data-done={isDoneRoutine || undefined}
        style={{ borderLeftColor: block.color }}
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
      {isSignal && (
        <ResizeHandle
          signalId={signalId}
          startISO={block.startISO}
          durationMin={durationMin}
        />
      )}
    </div>
  );
}
