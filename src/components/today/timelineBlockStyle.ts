import type { CSSProperties } from "react";

/** 리사이즈 핸들 hitbox 높이(px) — 상수 6px(Google-캘린더 모델, 2026-06-14).
 *  body 전체=이동, 위/아래 얇은 가장자리만=리사이즈. 6px는 예전 3px(잡기 불가)보다 넉넉하면서도
 *  8px보다 move 밴드를 더 남긴다(짧은 블록도 가운데 이동 영역 확보). occlusion은 핸들 크기가 아니라
 *  wrap z-lift(:hover/:focus-within)가 해결하므로 핸들을 키울 필요가 없다. */
export function resizeHandleHeightPx(): number {
  return 6;
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
