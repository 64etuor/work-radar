import { computeLayout, type LayoutBox, type TimedBlock } from "@/lib/timelineLayout";
import {
  plusMinutesLocal,
  resizeIsoByPx,
  shiftIsoByPx,
  type DragData,
} from "@/components/today/useTimelineDnd";

export type DragDelta = { x: number; y: number };
export type DragGuide = {
  x: number;
  y: number;
  durationMin: number;
};

export function blockIdForDrag(data: DragData): string | null {
  if (data.from !== "canvas" && data.from !== "canvas-resize") return null;
  if (data.blockKind === "signal" && "signalId" in data) return `signal:${data.signalId}`;
  if (data.blockKind === "event" && "eventId" in data) return `event:${data.eventId}`;
  if (data.blockKind === "routine" && "routineId" in data) return `routine:${data.routineId}`;
  return null;
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
}: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  gridWidth: number;
}): DragGuide | null {
  if (!activeDrag || !delta) return null;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") {
    return null;
  }
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return null;
  const activeBox = boxes.find((box) => box.id === activeId);
  if (!activeBox) return null;

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
      y: Math.max(0, Math.min(24 * 60, edgeY)),
      durationMin: activeDrag.durationMin,
    };
  }

  return {
    x: Math.max(60, Math.min(gridWidth, centerX)),
    y: Math.max(0, Math.min(24 * 60, activeBox.topPx + delta.y)),
    durationMin: activeDrag.durationMin,
  };
}

export function previewTimelineBoxes({
  boxes,
  activeDrag,
  delta,
  date,
}: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  date: string;
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
      const startISO = shiftIsoByPx(date, activeDrag.startISO, delta.y);
      const endISO = plusMinutesLocal(startISO, activeDrag.durationMin);
      changed = startISO !== block.startISO || endISO !== block.endISO;
      return { ...block, startISO, endISO };
    }

    const resized = resizeIsoByPx({
      date,
      startISO: activeDrag.startISO,
      durationMin: activeDrag.durationMin,
      edge: activeDrag.edge,
      deltaPx: delta.y,
    });
    const endISO = plusMinutesLocal(resized.at, resized.durationMin);
    changed = resized.at !== block.startISO || endISO !== block.endISO;
    return { ...block, startISO: resized.at, endISO };
  });

  return changed ? computeLayout(blocks) : boxes;
}
