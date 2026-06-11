import type { DragData } from "@/components/today/useTimelineDnd";
import { plusMinutesLocal, resizeIsoByPx, shiftIsoByPx } from "@/lib/timelineCoords";
import { computeLayout, type LayoutBox, type TimedBlock } from "@/lib/timelineLayout";

export type DragDelta = { x: number; y: number };
export type DragGuide = {
  x: number;
  y: number;
  durationMin: number;
};

/** 드래그 중인 캔버스 블록의 정본 id — DragData.blockId(블록 id 그대로) 사용.
 *  과거의 `event:${eventId}` 재구성은 복합키(`event:${calendarId}:${id}`)와 불일치해
 *  event 블록 preview 매칭이 항상 실패했다(연속 타임라인 전환과 함께 수정). */
function blockIdForDrag(data: DragData): string | null {
  if (data.from !== "canvas" && data.from !== "canvas-resize") return null;
  return data.blockId;
}

export function renderTimelineBoxesForDrag({
  boxes,
  previewBoxes,
  activeDrag,
}: {
  boxes: LayoutBox[];
  previewBoxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
}): LayoutBox[] {
  if (activeDrag?.from !== "canvas") return previewBoxes;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return previewBoxes;
  const activeOriginal = boxes.find((box) => box.id === activeId);
  if (!activeOriginal) return previewBoxes;
  return previewBoxes.map((box) => (box.id === activeId ? activeOriginal : box));
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

  return {
    x: Math.max(60, Math.min(gridWidth, centerX)),
    y: Math.max(0, Math.min(maxY, activeBox.topPx + delta.y)),
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

    if (activeDrag.from === "canvas") {
      const startISO = shiftIsoByPx(anchorDate, days, activeDrag.startISO, delta.y);
      const endISO = plusMinutesLocal(startISO, activeDrag.durationMin);
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
    const endISO = plusMinutesLocal(resized.at, resized.durationMin);
    changed = resized.at !== block.startISO || endISO !== block.endISO;
    return { ...block, startISO: resized.at, endISO };
  });

  return changed ? computeLayout(blocks, anchorDate) : boxes;
}
