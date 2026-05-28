export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 360;
const MIN_H = 320;

export function clampToViewport(b: Bounds, vw: number, vh: number): Bounds {
  const w = Math.max(MIN_W, Math.min(b.w, vw));
  const h = Math.max(MIN_H, Math.min(b.h, vh));
  const x = Math.max(0, Math.min(b.x, vw - w));
  const y = Math.max(0, Math.min(b.y, vh - h));
  return { x, y, w, h };
}

/** AgentStatusBar 가 상단을 고정 점유하는 높이(px) — AgentStatusBar.css `.asb-row min-height`. */
const TOP_BAR_H = 56;

/** 기본 패널 크기. viewport 보다 크면 clampToViewport 가 추가 축소. */
const DEFAULT_W = 480;
const DEFAULT_H = 760;

export function defaultBounds(vw: number, vh: number): Bounds {
  // viewport 보다 크면 비율 유지 없이 사용 가능 영역에 맞춘 후 약간의 여백을 둔다.
  const usableH = Math.max(MIN_H, vh - TOP_BAR_H);
  const w = Math.min(DEFAULT_W, Math.max(MIN_W, vw - 32));
  const h = Math.min(DEFAULT_H, Math.max(MIN_H, usableH - 32));
  // 가로는 viewport 정중앙, 세로는 status bar 아래의 사용 가능 영역 정중앙.
  const x = Math.max(0, Math.round((vw - w) / 2));
  const y = Math.max(TOP_BAR_H, Math.round(TOP_BAR_H + (usableH - h) / 2));
  return { x, y, w, h };
}
