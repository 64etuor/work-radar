import type { DragData } from "@/components/today/useTimelineDnd";
import { absMin, localDateOf } from "@/lib/timeAxis";
import {
  clampDurationToDate,
  clampIsoToDate,
  plusMinutesLocal,
  resizeIsoByPx,
  shiftIsoByPx,
} from "@/lib/timelineCoords";
import { computeLayout, type LayoutBox, type TimedBlock } from "@/lib/timelineLayout";

export type DragDelta = { x: number; y: number };
export type DragGuide = {
  x: number;
  y: number;
  durationMin: number;
};

/**
 * viewport client 좌표 → 그리드 로컬 좌표(크로스헤어 가이드용). onPointerMove의 환산과 동일:
 * y는 [0, totalPx], x는 [60(시간 라벨 거터), rect.width]로 클램프. 드래그 중 라이브 포인터를
 * dnd-kit activator+delta로 구해 이 함수로 환산하면 오버레이 hit-test로 onPointerMove가 끊겨도
 * 크로스헤어가 항상 실제 커서를 따른다(블록 top-anchor offset·stale hover 동시 해소).
 */
export function clientPointToGridGuide(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number },
  totalPx: number,
): { x: number; y: number } {
  return {
    y: Math.max(0, Math.min(totalPx, point.y - rect.top)),
    x: Math.max(60, Math.min(rect.width, point.x - rect.left)),
  };
}

/** 드래그 중인 캔버스 블록의 정본 id — DragData.blockId(블록 id 그대로) 사용.
 *  과거의 `event:${eventId}` 재구성은 복합키(`event:${calendarId}:${id}`)와 불일치해
 *  event 블록 preview 매칭이 항상 실패했다(연속 타임라인 전환과 함께 수정). */
function blockIdForDrag(data: DragData): string | null {
  if (data.from !== "canvas" && data.from !== "canvas-resize") return null;
  return data.blockId;
}

/**
 * 캔버스 이동/리사이즈 중 렌더할 박스 = 스냅된 previewBoxes 그대로.
 * 과거엔 active 블록만 원본 위치로 되돌려 dnd raw transform이 커서를 따라가게 했으나, 그 방식은
 * 블록이 unsnapped raw 커서를 따라가며 스냅된 드롭 가이드/실제 착지점과 최대 ±7.5px 어긋나
 * "고스트가 어색"했다(Bug 2a). 이제 active 블록도 스냅된 preview 위치에 렌더하고, raw transform은
 * TimelineCanvas의 suppressDragTransform로 끈다 → 블록 == 가이드 == 착지점.
 */
export function renderTimelineBoxesForDrag({
  previewBoxes,
}: {
  previewBoxes: LayoutBox[];
}): LayoutBox[] {
  return previewBoxes;
}

export function dragGuideFromLayout({
  boxes,
  activeDrag,
  delta,
  gridWidth,
  days,
}: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  gridWidth: number;
  /** 로드된 일수 — 가이드 y 클램프 상한(days*1440). */
  days: number;
}): DragGuide | null {
  if (!activeDrag || !delta) return null;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") {
    return null;
  }
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return null;
  const activeBox = boxes.find((box) => box.id === activeId);
  if (!activeBox) return null;

  const maxY = days * 1440;
  const layerWidth = Math.max(0, gridWidth - 60);
  const left = 60 + (layerWidth * activeBox.leftPct) / 100;
  const width = Math.max(0, (layerWidth * activeBox.widthPct) / 100 - 4);
  const centerX = left + width / 2 + delta.x;

  if (activeDrag.from === "canvas-resize") {
    const edgeY =
      activeDrag.edge === "top"
        ? activeBox.topPx + delta.y
        : activeBox.topPx + activeBox.heightPx + delta.y;
    return {
      x: Math.max(60, Math.min(gridWidth, centerX)),
      y: Math.max(0, Math.min(maxY, edgeY)),
      durationMin: activeDrag.durationMin,
    };
  }

  // 루틴/루틴-backed 이동은 occurrence 날짜 안으로 클램프(preview/commit과 동일, Bug 2c) — 자정
  // 넘김 시 가이드 라인이 클램프된 블록 착지 엣지와 다른 hh:mm을 보이지 않게 한다. 원본 블록의
  // topPx로 occurrence 날짜의 px 범위([dayStart, dayStart+1440-15])를 유도(anchorDate 불필요).
  const routineBacked =
    activeDrag.blockKind === "routine" ||
    (activeDrag.blockKind === "event" && activeDrag.routineId != null);
  const moveY = activeBox.topPx + delta.y;
  const dayStart = Math.floor(activeBox.topPx / 1440) * 1440;
  const clampedY = routineBacked
    ? Math.max(dayStart, Math.min(dayStart + 1440 - 15, moveY))
    : moveY;
  return {
    x: Math.max(60, Math.min(gridWidth, centerX)),
    y: Math.max(0, Math.min(maxY, clampedY)),
    durationMin: activeDrag.durationMin,
  };
}

export function previewTimelineBoxes({
  boxes,
  activeDrag,
  delta,
  anchorDate,
  days,
}: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  /** 연속 절대 분 축의 0점(로드된 첫 날짜) — computeLayout/좌표 변환 공유. */
  anchorDate: string;
  days: number;
}): LayoutBox[] {
  if (!activeDrag || !delta) return boxes;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") {
    return boxes;
  }
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return boxes;

  let changed = false;
  const blocks: TimedBlock[] = boxes.map((box) => {
    const block = box.block;
    if (block.id !== activeId) return block;

    // 루틴/루틴-backed 이벤트는 occurrence 날짜 안으로 클램프 — commit(useTimelineDnd §2/§3)과
    // 동일해야 preview가 다른 날을 보여주고 드롭 시 스냅백하지 않는다(스펙 §5, Bug 2c).
    const occDate = localDateOf(activeDrag.startISO);
    const routineBacked =
      activeDrag.blockKind === "routine" ||
      (activeDrag.blockKind === "event" && activeDrag.routineId != null);

    if (activeDrag.from === "canvas") {
      const shifted = shiftIsoByPx(anchorDate, days, activeDrag.startISO, delta.y);
      const startISO = routineBacked ? clampIsoToDate(shifted, occDate) : shifted;
      const durationMin = routineBacked
        ? clampDurationToDate(startISO, occDate, activeDrag.durationMin)
        : activeDrag.durationMin;
      const endISO = plusMinutesLocal(startISO, durationMin);
      changed = startISO !== block.startISO || endISO !== block.endISO;
      return { ...block, startISO, endISO };
    }

    const resized = resizeIsoByPx({
      anchorDate,
      days,
      startISO: activeDrag.startISO,
      durationMin: activeDrag.durationMin,
      edge: activeDrag.edge,
      deltaPx: delta.y,
    });
    const at = routineBacked ? clampIsoToDate(resized.at, occDate) : resized.at;
    // 시작이 클램프로 밀렸으면 끝 시각 고정을 위해 duration 보정(commit의 resize 분기와 동일).
    let durationMin =
      at === resized.at
        ? resized.durationMin
        : resized.durationMin + (absMin(resized.at, occDate) - absMin(at, occDate));
    if (routineBacked) durationMin = clampDurationToDate(at, occDate, durationMin);
    const endISO = plusMinutesLocal(at, durationMin);
    changed = at !== block.startISO || endISO !== block.endISO;
    return { ...block, startISO: at, endISO };
  });

  return changed ? computeLayout(blocks, anchorDate) : boxes;
}
