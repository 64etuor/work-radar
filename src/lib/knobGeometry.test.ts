import { describe, expect, it } from "vitest";

import { armedDirection, clampToThrow, type KnobDir } from "./knobGeometry";

const ALL: Record<KnobDir, boolean> = { up: true, down: true, left: true, right: true };

describe("clampToThrow", () => {
  it("반경 안이면 그대로", () => {
    expect(clampToThrow(3, 4, 10)).toEqual({ x: 3, y: 4 });
  });
  it("반경 밖이면 원 위로 클램프(거리=반경)", () => {
    const { x, y } = clampToThrow(30, 40, 10); // dist 50 → 1/5
    expect(Math.hypot(x, y)).toBeCloseTo(10);
    expect(x).toBeCloseTo(6);
    expect(y).toBeCloseTo(8);
  });
});

describe("armedDirection", () => {
  const R = 100;
  const RATIO = 0.55; // 임계 55

  it("임계 미만이면 null", () => {
    expect(armedDirection(40, 0, R, RATIO, ALL)).toBeNull();
  });
  it("우세 축이 좌측이면 left", () => {
    expect(armedDirection(-60, 10, R, RATIO, ALL)).toBe("left");
  });
  it("우세 축이 위면 up(화면 y는 아래가 양수)", () => {
    expect(armedDirection(10, -70, R, RATIO, ALL)).toBe("up");
  });
  it("해당 방향이 disabled면 null", () => {
    expect(armedDirection(-60, 10, R, RATIO, { ...ALL, left: false })).toBeNull();
  });
});
