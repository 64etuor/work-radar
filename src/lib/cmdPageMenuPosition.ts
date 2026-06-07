export interface MenuPosition {
  left: number;
  top: number;
  placement: "above" | "below";
}

/**
 * Cmd 페이지 메뉴의 화면 위치 계산(순수). origin(커서) 기준 가로 중앙 정렬,
 * 기본은 레버 위쪽(above) — 위 공간이 부족하면 아래(below)로 flip하고, 항상 뷰포트 안으로 clamp.
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

  const aboveTop = origin.y - clearance - menu.h;
  let placement: "above" | "below";
  let top: number;
  if (aboveTop >= margin) {
    placement = "above";
    top = aboveTop;
  } else {
    placement = "below";
    top = origin.y + clearance;
  }
  const maxTop = Math.max(margin, viewport.h - menu.h - margin);
  top = Math.min(Math.max(top, margin), maxTop);

  return { left, top, placement };
}
