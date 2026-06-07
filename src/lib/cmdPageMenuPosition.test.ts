import { describe, expect, it } from "vitest";

import { clampMenuPosition } from "./cmdPageMenuPosition";

const VP = { w: 1000, h: 800 };
const MENU = { w: 200, h: 60 };
const MARGIN = 8;
const CLEAR = 70;

describe("clampMenuPosition", () => {
  it("origin.x를 중심으로 가로 정렬", () => {
    const p = clampMenuPosition({ x: 500, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.left).toBe(400); // 500 - 200/2
  });

  it("좌측 가장자리를 넘으면 margin으로 clamp", () => {
    const p = clampMenuPosition({ x: 10, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.left).toBe(8);
  });

  it("우측 가장자리를 넘으면 (뷰포트폭 - 메뉴폭 - margin)으로 clamp", () => {
    const p = clampMenuPosition({ x: 990, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.left).toBe(792); // 1000 - 200 - 8
  });

  it("아래 공간이 충분하면 기본 below 배치(top = origin.y + clearance)", () => {
    const p = clampMenuPosition({ x: 500, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(470); // 400 + 70
  });

  it("아래 공간이 부족하면 above로 flip(top = origin.y - clearance - menu.h)", () => {
    // origin이 하단 근처 → below(830+60=890)가 뷰포트(800-8) 초과 → 위로 flip
    const p = clampMenuPosition({ x: 500, y: 760 }, VP, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(630); // 760 - 70 - 60
  });

  it("위·아래 모두 부족하면 above로 두되 margin으로 clamp", () => {
    // 작은 뷰포트: below 넘침 → above, 그러나 above도 음수 → margin으로 floor
    const p = clampMenuPosition({ x: 500, y: 10 }, { w: 1000, h: 120 }, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(8); // 10 - 70 - 60 = -120 → clamp margin
  });

  it("메뉴가 뷰포트보다 넓으면 음수 없이 margin으로 floor", () => {
    // menu.w(900) > viewport.w(400) → maxLeft = max(margin, 400-900-8) = margin
    const p = clampMenuPosition(
      { x: 200, y: 400 },
      { w: 400, h: 800 },
      { w: 900, h: 60 },
      MARGIN,
      CLEAR,
    );
    expect(p.left).toBe(8); // 음수로 가지 않고 margin에 안착
  });
});
