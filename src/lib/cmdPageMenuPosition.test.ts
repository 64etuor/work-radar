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

  it("위 공간이 충분하면 above 배치(top = origin.y - clearance - menu.h)", () => {
    const p = clampMenuPosition({ x: 500, y: 400 }, VP, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("above");
    expect(p.top).toBe(270); // 400 - 70 - 60
  });

  it("위 공간이 부족하면 below로 flip(top = origin.y + clearance)", () => {
    const p = clampMenuPosition({ x: 500, y: 20 }, VP, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(90); // 20 + 70
  });

  it("below가 아래로 넘치면 (뷰포트높이 - 메뉴높이 - margin)으로 clamp", () => {
    // 작은 뷰포트: 위도 부족 → below, 그러나 below도 넘침 → 끌어올림
    const p = clampMenuPosition({ x: 500, y: 10 }, { w: 1000, h: 120 }, MENU, MARGIN, CLEAR);
    expect(p.placement).toBe("below");
    expect(p.top).toBe(52); // clamp: 120 - 60 - 8
  });
});
