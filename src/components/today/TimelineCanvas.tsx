import { useDroppable } from "@dnd-kit/core";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { TimelineBlock } from "@/components/today/TimelineBlock";
import {
  type DragDelta,
  dragGuideFromLayout,
  previewTimelineBoxes,
  renderTimelineBoxesForDrag,
} from "@/components/today/timelinePreview";
import type { DragData, DropData } from "@/components/today/useTimelineDnd";
import { weekdayForDate } from "@/lib/query";
import { dayDiff } from "@/lib/timeAxis";
import type { LayoutBox } from "@/lib/timelineLayout";

const HOUR_PX = 60;
const DAY_PX = 24 * HOUR_PX;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

type Props = {
  /** 로드된 날짜(연속·오름차순). anchor = dates[0]. 연속 타임라인 스펙 §4. */
  dates: string[];
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
  /** 그리드 DOM을 부모(TodayView)에 노출 — useTimelineDnd가 onDragEnd에서 fresh rect를 읽는다. */
  gridElRef?: React.MutableRefObject<HTMLDivElement | null>;
  activeDrag?: DragData | null;
  activeDelta?: DragDelta | null;
};

/** "지금"의 절대 px(앵커 날짜 00:00 기준). 앵커 범위 밖이면 음수/초과 — 호출부가 범위 체크. */
function nowOffsetPx(anchorDate: string): number {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return (dayDiff(date, anchorDate) * 24 + d.getHours() + d.getMinutes() / 60) * HOUR_PX;
}

const WEEKDAY_KO: Record<string, string> = {
  sun: "일",
  mon: "월",
  tue: "화",
  wed: "수",
  thu: "목",
  fri: "금",
  sat: "토",
};

/** 날짜 separator 라벨 — "6월 12일 (금)". */
function fmtDayLabel(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}월 ${d}일 (${WEEKDAY_KO[weekdayForDate(date)]})`;
}

/**
 * 연속 멀티데이 캔버스(연속 타임라인 스펙 §4). 1시간=60px, 총 dates.length×1440px.
 * 각 날짜 00:00에 separator, 시간 라벨/업무시간 음영은 날짜별 반복. now 라인은 절대 위치 1개.
 * 그리드 전체가 droppable("canvas") — 드롭 Y는 절대 좌표라 날짜가 Y에서 유도된다(자정 통과 배치).
 */
export function TimelineCanvas({
  dates,
  today,
  boxes,
  memoByBlockId,
  onBlockClick,
  onToggleDone,
  pointerYRef,
  pointerXRef,
  gridElRef,
  activeDrag,
  activeDelta,
}: Props) {
  const anchorDate = dates[0];
  const days = dates.length;
  const totalPx = days * DAY_PX;

  // 분 단위 tick — nowPx는 렌더 시 anchorDate에서 파생(앵커 변경 시 effect-내 setState 회피).
  const [, setMinuteTick] = useState(0);
  const nowPx = nowOffsetPx(anchorDate);
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [gridWidth, setGridWidth] = useState<number>(0);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setInterval(() => setMinuteTick((v) => v + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const showNow = dates.includes(today);
  const previewBoxes = previewTimelineBoxes({
    boxes,
    activeDrag,
    delta: activeDelta,
    anchorDate,
    days,
  });
  const renderBoxes = renderTimelineBoxesForDrag({ previewBoxes });
  const activeGuide = dragGuideFromLayout({
    boxes,
    activeDrag,
    delta: activeDelta,
    gridWidth,
    days,
  });
  // 캔버스 이동/리사이즈 모두 preview가 스냅된 블록 위치를 소유한다 → raw transform suppress +
  // 레이아웃 transition off(드래그 중 active 블록 ±7.5px 오차 제거 Bug 2a, 이웃 220ms 리플로우
  // rubber-band 제거 Bug 2b). 드롭 시 activeDrag=null로 돌아오면 transition이 살아나 settle.
  const previewOwnsBlockLayout =
    activeDrag?.from === "canvas" || activeDrag?.from === "canvas-resize";

  // dropData는 상수 — gridY는 dropData에 박지 않는다(@dnd-kit가 register 시점 스냅샷할
  // 위험 + mutable ref antipattern). 실제 Y 좌표는 부모 pointerYRef에 기록되어
  // useTimelineDnd가 onDragEnd에서 읽는다.
  const dropData: DropData = { to: "canvas", gridY: 0 };
  const { setNodeRef, isOver } = useDroppable({ id: "today-canvas", data: dropData });
  const bindGridRef = (el: HTMLDivElement | null) => {
    gridRef.current = el;
    if (gridElRef) gridElRef.current = el;
    setNodeRef(el);
    if (!el) return;
    setGridWidth((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
  };

  // pointer-tracking: 캔버스 위 pointer Y를 그리드 로컬 좌표로 환산.
  // - 부모 pointerYRef(ref-only)는 매 move마다 갱신 — onDragEnd에서 읽힘.
  // - state(setHoverPx)는 가이드 라인 렌더용 — drag 활성(isOver) 시에만 setState해서
  //   매 pointermove 리렌더로 인한 dnd-kit pointer state 교란/성능 저하 방지.
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = gridRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(totalPx, e.clientY - rect.top));
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
      data-dates={`${dates[0]}..${dates[days - 1]}`}
      data-drop-over={isOver || undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div ref={bindGridRef} className="today-canvas-grid" style={{ height: `${totalPx}px` }}>
        {dates.map((date, di) => (
          <div key={date} aria-hidden>
            {/* 업무시간 음영 (09–18) — 날짜별 반복(시각적 닻). */}
            <div
              className="today-canvas-workhours"
              style={{ top: `${di * DAY_PX + 9 * HOUR_PX}px`, height: `${9 * HOUR_PX}px` }}
            />
            {HOURS.map((h) => (
              <div
                key={`${date}:${h}`}
                className="today-canvas-hour"
                style={{ top: `${(di * 24 + h) * HOUR_PX}px` }}
              >
                <span className="today-canvas-hour-label">{String(h).padStart(2, "0")}:00</span>
                <div className="today-canvas-hour-rule" />
              </div>
            ))}
            {di > 0 && (
              <div className="today-canvas-day-sep" style={{ top: `${di * DAY_PX}px` }}>
                <span
                  className="today-canvas-day-sep-label"
                  data-today={date === today || undefined}
                >
                  {fmtDayLabel(date)}
                </span>
              </div>
            )}
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
              suppressDragTransform={previewOwnsBlockLayout}
              disableLayoutTransition={previewOwnsBlockLayout}
            />
          ))}
        </div>
        {showNow && nowPx >= 0 && nowPx <= totalPx && (
          <div className="today-canvas-now" style={{ top: `${nowPx}px` }} aria-label="현재 시각" />
        )}
        {activeDrag &&
          (() => {
            const guideY = activeGuide?.y ?? hoverPx;
            const guideX = activeGuide?.x ?? hoverX;
            if (guideY === null || guideX === null) return null;
            // 15분 그리드 스냅 — 절대 분으로 환산해 라벨은 일중 시각(hh:mm)으로 표시(스펙 §D2).
            // HOUR_PX=60이라 1min=1px. 날짜 컨텍스트는 separator가 제공.
            const snapMin = Math.max(0, Math.min(days * 1440, Math.round(guideY / 15) * 15));
            const dayMin = snapMin % 1440;
            const hh = String(Math.floor(dayMin / 60)).padStart(2, "0");
            const mm = String(dayMin % 60).padStart(2, "0");
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
