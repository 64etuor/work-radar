import { type MutableRefObject, useRef } from "react";

import {
  clientPointToGridGuide,
  type DragDelta,
  dragDeltaFromGridPoints,
} from "@/components/today/timelinePreview";

type ClientPoint = { x: number; y: number };

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
  const dragStartGridRef = useRef<ClientPoint | null>(null);
  const dragDeltaRef = useRef<DragDelta | null>(null);

  const currentGridPoint = (point: ClientPoint | null | undefined): ClientPoint | null => {
    const rect = gridElRef.current?.getBoundingClientRect();
    if (!point || !rect) return null;
    return clientPointToGridGuide(point, rect, visibleDays * 24 * 60);
  };

  const captureDragStart = (event: Event | undefined) => {
    const startClient = clientPointFromEvent(event);
    dragStartGridRef.current = currentGridPoint(startClient);
    dragRawPointerRef.current = null;
    dragDeltaRef.current = null;
    if (startClient) lastPointerRef.current = startClient;
  };

  const updateDragMoveDelta = (fallback: DragDelta) => {
    const pointerGrid = currentGridPoint(dragRawPointerRef.current);
    const delta = dragDeltaFromGridPoints(dragStartGridRef.current, pointerGrid, fallback);
    dragDeltaRef.current = delta;
    return { delta, pointerGrid };
  };

  const prepareDragEndDelta = (fallback: DragDelta) => {
    const pointerGrid = currentGridPoint(dragRawPointerRef.current);
    dragDeltaRef.current = dragDeltaFromGridPoints(
      dragStartGridRef.current,
      pointerGrid,
      dragDeltaRef.current ?? fallback,
    );
  };

  const clearDragDelta = () => {
    dragRawPointerRef.current = null;
    dragStartGridRef.current = null;
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
