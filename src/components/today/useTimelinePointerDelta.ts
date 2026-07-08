import { type MutableRefObject, useRef } from "react";

import { clientPointToGridGuide, type DragDelta } from "@/components/today/timelinePreview";
import { totalPxForDays } from "@/lib/timelineAxis";

export type ClientPoint = { x: number; y: number };

function clientPointFromEvent(event: Event | undefined): ClientPoint | null {
  if (
    event &&
    "clientX" in event &&
    "clientY" in event &&
    typeof event.clientX === "number" &&
    typeof event.clientY === "number"
  ) {
    return { x: event.clientX, y: event.clientY };
  }
  return null;
}

/**
 * raw client pointer → grid-local coordinate (crosshair / guide only).
 * This is NOT used for the operation delta — it is only used for the
 * crosshair cursor position (pointerGrid) and off-grid release classification.
 */
export function computeGridPoint(
  point: ClientPoint | null | undefined,
  rect: DOMRect | { left: number; top: number; width: number } | null | undefined,
  visibleDays: number,
): ClientPoint | null {
  if (!point || !rect) return null;
  return clientPointToGridGuide(point, rect, totalPxForDays(visibleDays));
}

/**
 * Computes the operation delta returned by updateDragMoveDelta.
 * Operation delta = evDelta (dnd-kit authoritative, always fresh).
 * pointerGrid = raw client pointer → grid coord (crosshair only).
 */
export function computeMoveDelta(
  evDelta: DragDelta,
  rawPointer: ClientPoint | null | undefined,
  rect: DOMRect | { left: number; top: number; width: number } | null | undefined,
  visibleDays: number,
): { delta: DragDelta; pointerGrid: ClientPoint | null } {
  return {
    delta: evDelta,
    pointerGrid: computeGridPoint(rawPointer, rect, visibleDays),
  };
}

export function useTimelinePointerDelta({
  gridElRef,
  lastPointerRef,
  visibleDays,
}: {
  gridElRef: MutableRefObject<HTMLDivElement | null>;
  lastPointerRef: MutableRefObject<ClientPoint>;
  visibleDays: number;
}) {
  const dragRawPointerRef = useRef<ClientPoint | null>(null);
  const dragDeltaRef = useRef<DragDelta | null>(null);

  const captureDragStart = (event: Event | undefined) => {
    const startClient = clientPointFromEvent(event);
    dragRawPointerRef.current = null;
    dragDeltaRef.current = null;
    if (startClient) lastPointerRef.current = startClient;
  };

  /**
   * Called on every dnd-kit onDragMove.
   * - delta    = evDelta  (dnd-kit authoritative — fixes the freeze)
   * - pointerGrid = raw window pointer via computeGridPoint (crosshair / guide only)
   */
  const updateDragMoveDelta = (evDelta: DragDelta) => {
    const rect = gridElRef.current?.getBoundingClientRect();
    const { delta, pointerGrid } = computeMoveDelta(
      evDelta,
      dragRawPointerRef.current,
      rect,
      visibleDays,
    );
    dragDeltaRef.current = delta;
    return { delta, pointerGrid };
  };

  /**
   * Called just before onDragEnd commit.
   * Stores evDelta as the authoritative delta for the commit branch.
   */
  const prepareDragEndDelta = (evDelta: DragDelta) => {
    dragDeltaRef.current = evDelta;
  };

  const clearDragDelta = () => {
    dragRawPointerRef.current = null;
    dragDeltaRef.current = null;
  };

  return {
    captureDragStart,
    clearDragDelta,
    dragDeltaRef,
    dragRawPointerRef,
    prepareDragEndDelta,
    updateDragMoveDelta,
  };
}
