import { useDraggable } from "@dnd-kit/core";
import { Repeat, StickyNote } from "lucide-react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

import { timelineBlockPlacementStyle } from "@/components/today/timelineBlockStyle";
import type { DragData } from "@/components/today/useTimelineDnd";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/components/ui/cn";
import type { LayoutBox } from "@/lib/timelineLayout";
import { eventBlockApiId } from "@/lib/todayBlocks";

type Props = {
  box: LayoutBox;
  /** 이 블록에 달린 메모 body(없으면 undefined). 있으면 제목 앞 노트 아이콘 + (공간 되면) 1줄 스니펫. */
  memo?: string;
  onClick: (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => void;
  /**
   * 좌상단 ✓ 체크 토글. signal/routine 블록에만 표시 — event는 done 개념 없음.
   * parent(TodayView)가 block.kind 분기로 mutate dispatch.
   */
  onToggleDone?: (box: LayoutBox, done: boolean) => void;
  suppressDragTransform?: boolean;
  disableLayoutTransition?: boolean;
};

/** 메모 첫 줄만(스니펫). 줄바꿈 이후는 버리고 CSS ellipsis가 가로 넘침 처리. */
function memoSnippet(memo: string): string {
  const first = memo.split("\n").find((l) => l.trim().length > 0);
  return (first ?? "").trim();
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function stripBlockPrefix(id: string, kind: "signal" | "event" | "routine"): string {
  return id.replace(new RegExp(`^${kind}:`), "");
}

function dragDataForBox(box: LayoutBox, durationMin: number): DragData {
  const { block } = box;
  if (block.kind === "event") {
    return {
      from: "canvas",
      blockKind: "event",
      blockId: block.id,
      eventId: eventBlockApiId(block),
      title: block.title,
      startISO: block.startISO,
      durationMin,
      calendarId: block.calendarId,
    };
  }
  if (block.kind === "routine") {
    return {
      from: "canvas",
      blockKind: "routine",
      blockId: block.id,
      routineId: block.routineId ?? stripBlockPrefix(block.id, "routine"),
      title: block.title,
      startISO: block.startISO,
      durationMin,
      calendarId: block.calendarId,
    };
  }
  return {
    from: "canvas",
    blockKind: "signal",
    blockId: block.id,
    signalId: stripBlockPrefix(block.id, "signal"),
    title: block.title,
    startISO: block.startISO,
    durationMin,
    calendarId: block.calendarId,
  };
}

function resizeDataForBox(box: LayoutBox, edge: "top" | "bottom", durationMin: number): DragData {
  const { block } = box;
  if (block.kind === "event") {
    return {
      from: "canvas-resize",
      edge,
      blockKind: "event",
      blockId: block.id,
      eventId: eventBlockApiId(block),
      calendarId: block.calendarId,
      startISO: block.startISO,
      durationMin,
    };
  }
  if (block.kind === "routine") {
    return {
      from: "canvas-resize",
      edge,
      blockKind: "routine",
      blockId: block.id,
      routineId: block.routineId ?? stripBlockPrefix(block.id, "routine"),
      startISO: block.startISO,
      durationMin,
    };
  }
  return {
    from: "canvas-resize",
    edge,
    blockKind: "signal",
    blockId: block.id,
    signalId: stripBlockPrefix(block.id, "signal"),
    startISO: block.startISO,
    durationMin,
  };
}

/**
 * 블록 상/하단 리사이즈 핸들 (Today×Timeline spec §7 row 3).
 * 별도 useDraggable로 등록 — `from: "canvas-resize"` 분기로 useTimelineDnd가
 * ev.delta.y → start/durationMin 재계산 후 stage(resize).
 *
 * 블록 button의 형제로 배치(중첩 interactive 회피) — 컨테이너 div가 둘을 같은 좌표계로 묶는다.
 */
function ResizeHandle({
  edge,
  box,
  durationMin,
}: {
  edge: "top" | "bottom";
  box: LayoutBox;
  durationMin: number;
}) {
  const data = resizeDataForBox(box, edge, durationMin);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `resize:${box.block.id}:${edge}`,
    data,
  });
  // 부모 .tl-block-wrap 안에서 button과 형제 — pointer 이벤트가 button의 dnd-kit
  // listener로 버블되지 않으므로 별도 stopPropagation 불필요.
  return (
    <div
      ref={setNodeRef}
      className={`tl-block-resize tl-block-resize-${edge}`}
      data-dragging={isDragging || undefined}
      aria-label={edge === "top" ? "블록 시작 시간 조정" : "블록 종료 시간 조정"}
      {...attributes}
      {...listeners}
    />
  );
}

/**
 * 시간축 위 단일 블록(스펙 §D8 카드 정본).
 * 모든 block kind는 캔버스 안에서 드래그/리사이즈 가능하다. tray drop과 cross-calendar
 * move는 signal만 dispatcher가 허용한다.
 *
 * 구조: 컨테이너 <div> 안에 <button>(클릭/드래그) + <ResizeHandle>(별도 draggable).
 * 중첩 interactive 회피를 위해 핸들은 button의 형제. 컨테이너는 absolutely-positioned.
 */
export function TimelineBlock({
  box,
  memo,
  onClick,
  onToggleDone,
  suppressDragTransform = false,
  disableLayoutTransition = false,
}: Props) {
  const { block, topPx, heightPx, leftPct, widthPct } = box;
  const hasMemo = Boolean(memo && memo.trim());
  // 실제 endISO−startISO 그대로 — 15분 floor는 dispatcher(useTimelineDnd) 책임.
  const durationMin = Math.round(
    (new Date(block.endISO).getTime() - new Date(block.startISO).getTime()) / 60000,
  );
  /*
   * 반응형 블록 높이:
   *   - normal  (≥36px ≈ 36분+):  두 줄 stack — 시간 위, 제목 아래(기본 디자인).
   *   - compact (22~35px ≈ 30분): 한 줄 — 시간 · 제목(ellipsis), 작은 폰트, tight padding.
   *   - ultra   (<22px ≈ 15분):   한 줄 + 리사이즈 핸들/체크 더 얇게.
   * 두 줄 stack은 30분(30px) 이하에서 항상 잘림 → compact 한 줄 전환이 필요.
   */
  const compact = heightPx < 36;
  const ultraCompact = heightPx < 22;
  // 스니펫(메모 1줄)은 normal 모드 + 시간·제목 두 줄 위에 한 줄 더 들어갈 높이(≈56px)일 때만.
  // 그보다 짧으면 제목 앞 노트 아이콘만으로 메모 존재를 표시(공간 부족 시 본문 생략).
  const showSnippet = hasMemo && !compact && heightPx >= 56;
  const drag = useDraggable({
    id: `block:${block.id}`,
    data: dragDataForBox(box, durationMin),
  });
  const { attributes, listeners, setNodeRef, transform } = drag;

  const isCheckable =
    block.kind === "signal" || block.kind === "routine" || Boolean(block.routineId);
  const isDone = isCheckable && block.done === true;

  const ariaLabel = [
    block.title,
    `${hhmm(block.startISO)}–${hhmm(block.endISO)}`,
    block.calendarLabel || block.calendarId
      ? `(${block.calendarLabel || block.calendarId})`
      : `(${block.kind})`,
    hasMemo ? "메모 있음" : null,
    isDone ? "완료됨" : null,
  ]
    .filter(Boolean)
    .join(" ");

  // 컨테이너가 좌표/transform/opacity를 소유 — block button은 컨테이너 100% 채움.
  // resize handle은 컨테이너 하단 4px 띠.
  return (
    <div
      className="tl-block-wrap"
      data-dragging={drag.isDragging || undefined}
      style={timelineBlockPlacementStyle({
        topPx,
        heightPx,
        leftPct,
        widthPct,
        dragging: drag.isDragging,
        translate: suppressDragTransform ? null : transform,
        disableLayoutTransition,
      })}
    >
      <button
        ref={setNodeRef}
        type="button"
        className={cn(
          "tl-block",
          `tl-block-${block.kind}`,
          isDone && "tl-block-done",
          compact && "tl-block--compact",
          ultraCompact && "tl-block--ultra",
        )}
        data-done={isDone || undefined}
        style={
          {
            borderLeftColor: block.color,
            "--tl-accent": block.color,
          } as CSSProperties
        }
        onClick={(e) => onClick(box, e)}
        title={block.title}
        {...attributes}
        {...listeners}
        aria-label={ariaLabel}
      >
        <div className="tl-block-time">
          {hhmm(block.startISO)}–{hhmm(block.endISO)}
        </div>
        <div className="tl-block-title">
          {block.kind === "routine" && <Repeat className="tl-block-icon" aria-hidden />}
          {hasMemo && <StickyNote className="tl-block-memo-icon" aria-hidden />}
          {block.title}
        </div>
        {showSnippet && memo && <div className="tl-block-memo">{memoSnippet(memo)}</div>}
      </button>
      {isCheckable && onToggleDone && (
        // 블록 button의 형제로 배치(중첩 interactive 회피) — pointerdown으로 dnd-kit
        // listener 버블 끊기. click은 done 토글로만 소비.
        <Checkbox
          className="tl-block-check"
          checked={isDone}
          forceMountIndicator
          aria-label={isDone ? `${block.title} 완료 취소` : `${block.title} 완료`}
          title={isDone ? "완료 취소" : "완료"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={(checked) => {
            onToggleDone(box, checked === true);
          }}
        />
      )}
      <ResizeHandle edge="top" box={box} durationMin={durationMin} />
      <ResizeHandle edge="bottom" box={box} durationMin={durationMin} />
    </div>
  );
}
