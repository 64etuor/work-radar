import { useDroppable } from "@dnd-kit/core";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { TimelineBlock } from "@/components/today/TimelineBlock";
import {
  type DragDelta,
  dragGuideFromLayout,
  previewTimelineBoxes,
  renderTimelineBoxesForDrag,
} from "@/components/today/timelinePreview";
import type { DragData, DropData } from "@/components/today/useTimelineDnd";
import type { LayoutBox } from "@/lib/timelineLayout";

const HOUR_PX = 60;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  date: string;
  today: string;
  boxes: LayoutBox[];
  /** blockId → 메모 body. 블록 위 노트 아이콘/스니펫 표시용(없으면 표시 안 함). */
  memoByBlockId?: Map<string, string>;
  onBlockClick: (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => void;
  /** ✓ 체크 토글(signal/routine). 부모(TodayView)가 block.kind 분기로 mutate dispatch. */
  onToggleDone?: (box: LayoutBox, done: boolean) => void;
  /**
   * 캔버스 그리드 로컬 좌표(Y)를 기록하는 ref. 부모(TodayView)가 소유하고 useTimelineDnd가
   * onDragEnd에서 마지막 hover Y를 읽는다. dropData에 mutable 객체를 박는 antipattern을 회피.
   */
  pointerYRef?: React.MutableRefObject<number | null>;
  pointerXRef?: React.MutableRefObject<number | null>;
  activeDrag?: DragData | null;
  activeDelta?: DragDelta | null;
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
export function TimelineCanvas({
  date,
  today,
  boxes,
  memoByBlockId,
  onBlockClick,
  onToggleDone,
  pointerYRef,
  pointerXRef,
  activeDrag,
  activeDelta,
}: Props) {
  const [nowPx, setNowPx] = useState<number>(() => nowOffsetPx());
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [gridWidth, setGridWidth] = useState<number>(0);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (date !== today) return;
    const t = setInterval(() => setNowPx(nowOffsetPx()), 60_000);
    return () => clearInterval(t);
  }, [date, today]);

  const showNow = date === today;
  const previewBoxes = useMemo(
    () => previewTimelineBoxes({ boxes, activeDrag, delta: activeDelta, date }),
    [boxes, activeDrag, activeDelta, date],
  );
  const renderBoxes = useMemo(
    () => renderTimelineBoxesForDrag({ boxes, previewBoxes, activeDrag }),
    [boxes, previewBoxes, activeDrag],
  );
  const activeGuide = useMemo(
    () =>
      dragGuideFromLayout({
        boxes,
        activeDrag,
        delta: activeDelta,
        gridWidth,
      }),
    [boxes, activeDrag, activeDelta, gridWidth],
  );
  const suppressBlockTransform = activeDrag?.from === "canvas-resize";

  // dropData는 상수 — gridY는 dropData에 박지 않는다(@dnd-kit가 register 시점 스냅샷할
  // 위험 + mutable ref antipattern). 실제 Y 좌표는 부모 pointerYRef에 기록되어
  // useTimelineDnd가 onDragEnd에서 읽는다.
  const dropData: DropData = { to: "canvas", gridY: 0 };
  const { setNodeRef, isOver } = useDroppable({ id: "today-canvas", data: dropData });
  const bindGridRef = useCallback(
    (el: HTMLDivElement | null) => {
      gridRef.current = el;
      setNodeRef(el);
      if (!el) return;
      setGridWidth((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
    },
    [setNodeRef],
  );

  // pointer-tracking: 캔버스 위 pointer Y를 그리드 로컬 좌표로 환산.
  // - 부모 pointerYRef(ref-only)는 매 move마다 갱신 — onDragEnd에서 읽힘.
  // - state(setHoverPx)는 가이드 라인 렌더용 — drag 활성(isOver) 시에만 setState해서
  //   매 pointermove 리렌더로 인한 dnd-kit pointer state 교란/성능 저하 방지.
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(24 * HOUR_PX, e.clientY - rect.top));
    const x = Math.max(60, Math.min(rect.width, e.clientX - rect.left));
    if (pointerYRef) pointerYRef.current = y;
    if (pointerXRef) pointerXRef.current = x;
    if (isOver || activeDrag) {
      setHoverPx(y);
      setHoverX(x);
      if (gridWidth !== rect.width) setGridWidth(rect.width);
    }
  }

  function onPointerLeave() {
    if (hoverPx !== null) setHoverPx(null);
    if (hoverX !== null) setHoverX(null);
  }

  return (
    <div
      className="today-canvas"
      data-date={date}
      data-drop-over={isOver || undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div ref={bindGridRef} className="today-canvas-grid" style={{ height: `${24 * HOUR_PX}px` }}>
        {/* 업무시간 음영 (09–18) — 시각적 닻. */}
        <div className="today-canvas-workhours" aria-hidden />
        {HOURS.map((h) => (
          <div key={h} className="today-canvas-hour" style={{ top: `${h * HOUR_PX}px` }}>
            <span className="today-canvas-hour-label">{String(h).padStart(2, "0")}:00</span>
            <div className="today-canvas-hour-rule" />
          </div>
        ))}
        <div className="today-canvas-block-layer" aria-hidden={false}>
          {renderBoxes.map((b) => (
            <TimelineBlock
              key={b.id}
              box={b}
              memo={memoByBlockId?.get(b.block.id)}
              onClick={onBlockClick}
              onToggleDone={onToggleDone}
              suppressDragTransform={suppressBlockTransform}
              disableLayoutTransition={activeDrag?.from === "canvas-resize"}
            />
          ))}
        </div>
        {showNow && (
          <div className="today-canvas-now" style={{ top: `${nowPx}px` }} aria-label="현재 시각" />
        )}
        {activeDrag &&
          (() => {
            const guideY = activeGuide?.y ?? hoverPx;
            const guideX = activeGuide?.x ?? hoverX;
            if (guideY === null || guideX === null) return null;
            // 15분 그리드 스냅 — 분 단위로 환산해 라벨까지 표시(스펙 §D2).
            // HOUR_PX=60이라 1min=1px, snap = round(min/15)*15.
            const snapMin = Math.max(0, Math.min(24 * 60, Math.round(guideY / 15) * 15));
            const hh = String(Math.floor(snapMin / 60)).padStart(2, "0");
            const mm = String(snapMin % 60).padStart(2, "0");
            const previewDuration =
              activeGuide?.durationMin ??
              ("durationMin" in activeDrag ? (activeDrag.durationMin ?? 60) : 60);
            const previewHeight = Math.max(20, previewDuration);
            const previewWidth = Math.min(260, Math.max(120, guideX - 60));
            const previewLeft = Math.max(
              60,
              Math.min(guideX - previewWidth / 2, Math.max(60, gridWidth - previewWidth)),
            );
            return (
              <>
                <div
                  className="today-canvas-drop-guide"
                  style={{ top: `${snapMin}px` }}
                  data-time={`${hh}:${mm}`}
                  aria-hidden
                />
                <div
                  className="today-canvas-drop-x-guide"
                  style={{ left: `${guideX}px` }}
                  aria-hidden
                />
                {activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize" && (
                  <div
                    className={`today-canvas-drop-preview today-canvas-drop-preview-${activeDrag.from}`}
                    style={{
                      top: `${snapMin}px`,
                      left: `${previewLeft}px`,
                      width: `${previewWidth}px`,
                      height: `${previewHeight}px`,
                    }}
                    aria-hidden
                  >
                    <span>
                      {hh}:{mm}
                    </span>
                  </div>
                )}
              </>
            );
          })()}
      </div>
    </div>
  );
}
