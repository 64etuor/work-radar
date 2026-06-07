import { describe, expect, it } from "vitest";

import { clampMenuPosition } from "./cmdPageMenuPosition";

const VP = { w: 1000, h: 800 };
const MENU = { w: 200, h: 60 };
const MARGIN = 8;
const CLEAR = 70;

describe("clampMenuPosition", () => {
  it("공간이 충분하면 메뉴 중심 = 레버 origin.x", () => {
    const p = clampMenuPosition({ x: 500, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.centerX).toBe(500);
  });

  it("좌측 외곽이면 박스가 margin 안에 들도록 중심을 clamp(= margin + 폭/2)", () => {
    const p = clampMenuPosition({ x: 10, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.centerX).toBe(108); // 8 + 200/2 → 박스 [8, 208]
  });

  it("우측 외곽이면 중심을 clamp(= 뷰포트폭 - margin - 폭/2)", () => {
    const p = clampMenuPosition({ x: 990, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.centerX).toBe(892); // 1000 - 8 - 100 → 박스 [792, 992]
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

  it("메뉴가 뷰포트보다 넓으면 중심을 뷰포트 중앙으로(좌우 균등 오버플로)", () => {
    // menu.w(900) > viewport.w(400) → minCenter(458) > maxCenter(-58) → 중앙
    const p = clampMenuPosition(
      { x: 200, y: 400 },
      { w: 400, h: 800 },
      { w: 900, h: 60 },
      MARGIN,
      CLEAR,
    );
    expect(p.centerX).toBe(200); // 400 / 2
  });
});
