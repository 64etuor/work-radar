import type { DragData } from "@/components/today/useTimelineDnd";
import { absMin } from "@/lib/timeAxis";
import { clientToGrid } from "@/lib/timelineAxis";
import { planTimelineDrag } from "@/lib/timelineDragPlan";
import type { LayoutBox } from "@/lib/timelineLayout";

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
  const { activeDrag, anchorDate, boxes, days, snapMin } = args;
  const delta = args.delta;
  if (!activeDrag) return null;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return null;
  const activeId = activeDrag.blockId;
  if (!activeId) return null;
  const { previewBoxes } = planTimelineDrag({
    anchorDate,
    days,
    boxes,
    activeDrag,
    drop: { to: "canvas" },
    delta: delta ?? { x: 0, y: 0 },
    snapMin: snapMin ?? 15,
    release: null,
  });
  const box = previewBoxes.find((b) => b.id === activeId);
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
  const { activeDrag, boxes, anchorDate, days, snapMin } = args;
  const delta = args.delta;
  if (!activeDrag) return false;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return false;
  const activeId = activeDrag.blockId;
  if (!activeId) return false;
  const { previewBoxes } = planTimelineDrag({
    anchorDate,
    days,
    boxes,
    activeDrag,
    drop: { to: "canvas" },
    delta: delta ?? { x: 0, y: 0 },
    snapMin: snapMin ?? 15,
    release: null,
  });
  const activeBox = previewBoxes.find((b) => b.id === activeId);
  if (!activeBox) return false;
  // n===1 → widthPct===100 (100/1은 IEEE 754에서 정확) → 단독 블록은 false. 멀티컬럼(n≥2)만 <100.
  return activeBox.visual.widthPct < 100;
}
