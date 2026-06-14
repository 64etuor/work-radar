import type { CSSProperties } from "react";

/** 리사이즈 핸들 hitbox 높이(px) — 항상 8px. 예전 3px 바닥은 마우스로 잡기 불가능했다(Bug, 2026-06-14).
 *  짧은 블록은 핸들을 줄이는 대신 `showTopHandle`로 상단 핸들을 떼서 move 밴드를 확보하므로,
 *  핸들 자체는 모든 높이에서 8px로 유지한다. */
export function resizeHandleHeightPx(): number {
  return 8;
}

/** 상/하 2-핸들을 렌더할 최소 블록 높이(px). 8px 핸들 2개(16px) + 최소 12px move 밴드 = 28px.
 *  그보다 짧으면(20–27px; timelineLayout이 20px로 floor) 하단 단일 핸들 + 전체 body=move. */
export const TWO_HANDLE_MIN_PX = 28;

/** 짧은 블록(<28px)은 상단 핸들을 떼고 전체 body를 move로 둔다 — 8px×2가 move 밴드를 0으로 만들기 때문. */
export function showTopHandle(heightPx: number): boolean {
  return heightPx >= TWO_HANDLE_MIN_PX;
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
    opacity: dragging ? 0.4 : 1,
    transition: disableLayoutTransition ? "none" : undefined,
    willChange: disableLayoutTransition ? "auto" : undefined,
    transform: translate ? `translate3d(${translate.x}px, ${translate.y}px, 0)` : undefined,
  };
}
