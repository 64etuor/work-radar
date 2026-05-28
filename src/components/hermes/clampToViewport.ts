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

export function defaultBounds(vw: number, vh: number): Bounds {
  const w = 460,
    h = 600;
  return { x: Math.max(0, vw - w - 24), y: Math.max(0, vh - h - 24), w, h };
}
