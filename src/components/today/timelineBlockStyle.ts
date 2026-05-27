import type { CSSProperties } from "react";

export function timelineBlockPlacementStyle({
  topPx,
  heightPx,
  leftPct,
  widthPct,
  dragging,
  translate,
}: {
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
  dragging: boolean;
  translate?: { x: number; y: number } | null;
}): CSSProperties {
  return {
    position: "absolute",
    top: `${topPx}px`,
    height: `${heightPx}px`,
    left: `${leftPct}%`,
    width: `calc(${widthPct}% - 4px)`,
    zIndex: dragging ? 10 : 2,
    opacity: dragging ? 0.4 : 1,
    transform: translate
      ? `translate3d(${translate.x}px, ${translate.y}px, 0)`
      : undefined,
  };
}
