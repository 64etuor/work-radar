export interface MenuPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Cmd 페이지 메뉴의 화면 위치 계산(순수). origin(커서) 기준 가로 중앙 정렬,
 * 기본은 레버 아래쪽(below)에 살짝 띄움 — 아래 공간이 부족하면 위(above)로 flip하고,
 * 항상 뷰포트 안으로 clamp.
 * margin = 뷰포트 가장자리 최소 여백, clearance = origin(레버 중심)에서 메뉴까지 띄울 간격.
 */
export function clampMenuPosition(
  origin: { x: number; y: number },
  viewport: { w: number; h: number },
  menu: { w: number; h: number },
  margin: number,
  clearance: number,
): MenuPosition {
  const rawLeft = origin.x - menu.w / 2;
  const maxLeft = Math.max(margin, viewport.w - menu.w - margin);
  const left = Math.min(Math.max(rawLeft, margin), maxLeft);

  const belowTop = origin.y + clearance;
  let placement: "above" | "below";
  let top: number;
  if (belowTop + menu.h <= viewport.h - margin) {
    placement = "below";
    top = belowTop;
  } else {
    placement = "above";
    top = origin.y - clearance - menu.h;
  }
  const maxTop = Math.max(margin, viewport.h - menu.h - margin);
  top = Math.min(Math.max(top, margin), maxTop);

  return { left, top, placement };
}
