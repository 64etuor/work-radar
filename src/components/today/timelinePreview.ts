import type { DragData } from "@/components/today/useTimelineDnd";
import { absMin, localDateOf } from "@/lib/timeAxis";
import { clientToGrid } from "@/lib/timelineAxis";
import {
  clampDurationToDate,
  clampIsoToDate,
  plusMinutesLocal,
  resizeIsoByPx,
  shiftIsoByPx,
} from "@/lib/timelineCoords";
import {
  computeLayout,
  type LayoutBox,
  magnetEdgesFromBoxes,
  type TimedBlock,
} from "@/lib/timelineLayout";

export type DragDelta = { x: number; y: number };
export type DragGuide = {
  x: number;
  y: number;
  durationMin: number;
};

/**
 * viewport client 좌표 → 그리드 로컬 좌표. 정본 변환 `timelineAxis.clientToGrid`에 위임한다
 * (기존 호출부 호환을 위해 이름·시그니처 유지). 드래그 중 raw client pointer를 이 함수로
 * 환산하면 오버레이 hit-test로 onPointerMove가 끊겨도 크로스헤어/델타가 실제 커서를 따른다.
 */
export function clientPointToGridGuide(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number },
  totalPx: number,
): { x: number; y: number } {
  return clientToGrid(point, rect, totalPx);
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
  const left = 60 + (layerWidth * activeBox.visual.leftPct) / 100;
  const width = Math.max(0, (layerWidth * activeBox.visual.widthPct) / 100 - 4);
  const centerX = left + width / 2 + delta.x;
  const guideX = Math.max(60, Math.min(gridWidth, centerX));

  // 루틴/루틴-backed 이동·리사이즈는 occurrence 날짜 안으로 클램프(preview/commit과 동일, Bug 2c) —
  // 자정 넘김 시 가이드 라인이 클램프된 블록 착지 엣지와 다른 hh:mm을 보이지 않게 한다. 원본 블록의
  // topPx로 occurrence 날짜의 px 범위(dayStart..dayStart+1440)를 유도(anchorDate 불필요).
  const routineBacked =
    activeDrag.blockKind === "routine" ||
    (activeDrag.blockKind === "event" && activeDrag.routineId != null);
  const dayStart = Math.floor(activeBox.visual.topPx / 1440) * 1440;

  if (activeDrag.from === "canvas-resize") {
    const rawEdgeY =
      activeDrag.edge === "top"
        ? activeBox.visual.topPx + delta.y
        : activeBox.visual.topPx + activeBox.visual.heightPx + delta.y;
    // top 핸들=시작 엣지(occurrence 날짜 안, end-15 이하), bottom 핸들=끝 엣지(start+15 이상, 자정 이하).
    const edgeY = !routineBacked
      ? rawEdgeY
      : activeDrag.edge === "top"
        ? Math.max(dayStart, Math.min(dayStart + 1440 - 15, rawEdgeY))
        : Math.max(dayStart + 15, Math.min(dayStart + 1440, rawEdgeY));
    return {
      x: guideX,
      y: Math.max(0, Math.min(maxY, edgeY)),
      durationMin: activeDrag.durationMin,
    };
  }

  const moveY = activeBox.visual.topPx + delta.y;
  const clampedY = routineBacked
    ? Math.max(dayStart, Math.min(dayStart + 1440 - 15, moveY))
    : moveY;
  return {
    x: guideX,
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
  snapMin,
}: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  /** 연속 절대 분 축의 0점(로드된 첫 날짜) — computeLayout/좌표 변환 공유. */
  anchorDate: string;
  days: number;
  /** 그리드 스냅 단위(분). 기본 15. Alt/Option fine-snap 시 5. */ snapMin?: number;
}): LayoutBox[] {
  if (!activeDrag || !delta) return boxes;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") {
    return boxes;
  }
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return boxes;

  const snapOpts = {
    snapMin,
    magnetEdges: magnetEdgesFromBoxes(boxes, anchorDate, activeId),
  };

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
      const shifted = shiftIsoByPx(anchorDate, days, activeDrag.startISO, delta.y, snapOpts);
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
      snapOpts,
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

export type ActiveDragLabel = {
  kind: "move" | "resize";
  startHHMM: string;
  endHHMM: string;
  /** "1h15m" / "45m" / "1h" — 0분/0시 생략. */
  durationLabel: string;
};

/** 로컬 ISO('YYYY-MM-DDTHH:MM…')에서 HH:MM — UTC 변환 금지(INVARIANT #7). */
function hhmmOfIso(iso: string): string {
  return iso.slice(11, 16);
}

function fmtDurationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${m}m`;
}

/**
 * 드래그 중 active 캔버스 블록의 시간 라벨(플로팅 pill용). preview 블록의 스냅된 startISO/endISO를
 * 그대로 읽어(= previewTimelineBoxes가 이미 계산한 정본) 드래그 수학을 중복하지 않는다. resize면
 * 범위+길이, move면 시작 시각을 caller가 표시한다.
 */
export function activeDragLabel(args: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  anchorDate: string;
  days: number;
  /** 그리드 스냅 단위(분). 기본 15. Alt fine-snap 시 5 — pill 시각이 렌더된 블록과 일치해야 한다. */
  snapMin?: number;
}): ActiveDragLabel | null {
  const { activeDrag, anchorDate } = args;
  if (!activeDrag) return null;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return null;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return null;
  const preview = previewTimelineBoxes(args);
  const box = preview.find((b) => b.id === activeId);
  if (!box) return null;
  const { startISO, endISO } = box.block;
  const durationMin = Math.max(0, absMin(endISO, anchorDate) - absMin(startISO, anchorDate));
  return {
    kind: activeDrag.from === "canvas-resize" ? "resize" : "move",
    startHHMM: hhmmOfIso(startISO),
    endHHMM: hhmmOfIso(endISO),
    durationLabel: fmtDurationLabel(durationMin),
  };
}

/**
 * 드래그 중인 캔버스 블록이 preview 레이아웃에서 다른 블록과 겹치는지 — computeLayout이 멀티컬럼
 * 클러스터로 배치했는지(`widthPct < 100`)로 유도한다(스펙 §4 Phase 1). 미리보기 전용 겹침 틴트
 * 트리거. last-write-wins는 유지하고 _피드백_만 추가한다(area doc).
 */
export function activeDragWouldOverlap(args: {
  boxes: LayoutBox[];
  activeDrag: DragData | null | undefined;
  delta: DragDelta | null | undefined;
  anchorDate: string;
  days: number;
  /** 그리드 스냅 단위(분). 기본 15. Alt fine-snap 시 5 — 틴트가 렌더된 preview 레이아웃과 일치해야 한다. */
  snapMin?: number;
}): boolean {
  const { activeDrag } = args;
  if (!activeDrag) return false;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return false;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return false;
  const preview = previewTimelineBoxes(args);
  const activeBox = preview.find((b) => b.id === activeId);
  if (!activeBox) return false;
  // n===1 → widthPct===100 (100/1은 IEEE 754에서 정확) → 단독 블록은 false. 멀티컬럼(n≥2)만 <100.
  return activeBox.visual.widthPct < 100;
}
