import type { CSSProperties } from "react";

/**
 * 짧은 블록일수록 상/하단 리사이즈 핸들 hitbox(px)를 줄여 중앙 move-grab 밴드를 확보한다(Bug 1a).
 * 핸들은 z-index가 블록 버튼보다 위라, 풀사이즈 8px×2가 ≤30분(≤30px) 블록 grab 면적의 40~50%를
 * 가려 "옮기려는데 리사이즈가 잡히는" 회귀를 만든다. 높이에 비례해 축소(36px+→8px, 30px→5px,
 * 최소 블록 20px→3px)해 리사이즈는 유지하되 중앙은 항상 move로 잡히게 한다.
 */
export function resizeHandleHeightPx(heightPx: number): number {
  return Math.max(3, Math.min(8, Math.floor((heightPx - 20) / 2)));
}

export function timelineBlockPlacementStyle({
  topPx,
  heightPx,
  leftPct,
  widthPct,
  dragging,
  translate,
  disableLayoutTransition = false,
}: {
  topPx: number;
  heightPx: number;
  leftPct: number;
  widthPct: number;
  dragging: boolean;
  translate?: { x: number; y: number } | null;
  disableLayoutTransition?: boolean;
}): CSSProperties {
  return {
    position: "absolute",
    top: `${topPx}px`,
    height: `${heightPx}px`,
    left: `${leftPct}%`,
    width: `calc(${widthPct}% - 4px)`,
    zIndex: dragging ? 10 : 2,
    opacity: dragging ? 0.4 : 1,
    transition: disableLayoutTransition ? "none" : undefined,
    willChange: disableLayoutTransition ? "auto" : undefined,
    transform: translate ? `translate3d(${translate.x}px, ${translate.y}px, 0)` : undefined,
  };
}
