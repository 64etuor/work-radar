import { describe, expect, it } from "vitest";

import { armedDirection, clampToThrow, type KnobDir, knobFrame } from "./knobGeometry";

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
  it("우세 축이 disabled여도 다른 축이 임계+enabled면 그쪽으로 폴백(상하 미바인딩 기본값)", () => {
    // 위로 크게 → 좌로 curve(세로가 아직 우세하지만 좌측 성분이 임계 초과). up 미바인딩 → left로 발사.
    const updown_off = { up: false, down: false, left: true, right: true };
    expect(armedDirection(-60, -70, R, RATIO, updown_off)).toBe("left");
    expect(armedDirection(60, -70, R, RATIO, updown_off)).toBe("right");
  });
  it("우세 축 disabled + 다른 축이 임계 미만이면 null(폴백 후보 없음)", () => {
    // 거의 수직 위(좌측 성분이 임계 미만). up 미바인딩 → 폴백 없음 → null.
    expect(
      armedDirection(-40, -70, R, RATIO, { up: false, down: false, left: true, right: true }),
    ).toBeNull();
  });
});

describe("knobFrame — 판정은 raw, 표시는 클램프", () => {
  const R = 46; // CmdKnob THROW_RADIUS
  const RATIO = 0.55;
  const UPDOWN_OFF = { up: false, down: false, left: true, right: true };

  it("버그 제스처: 위로 150px 후 좌로 60px → left armed (클램프 좌표로 판정하면 60→17px로 희석돼 null이던 케이스)", () => {
    const f = knobFrame(-60, -150, R, RATIO, UPDOWN_OFF);
    expect(f.armed).toBe("left");
  });

  it("표시 offset은 림으로 클램프(스틱이 원 밖으로 안 나감)", () => {
    const f = knobFrame(-60, -150, R, RATIO, UPDOWN_OFF);
    expect(Math.hypot(f.offset.x, f.offset.y)).toBeCloseTo(R);
  });

  it("커서를 원점 근처로 되돌리면 중립(null) — 상태 없음(경로 무관)", () => {
    // delta 적분 방식과 달리 직전 경로가 무엇이든 현재 위치만 본다.
    const f = knobFrame(5, -8, R, RATIO, UPDOWN_OFF);
    expect(f.armed).toBeNull();
    expect(f.offset).toEqual({ x: 5, y: -8 });
  });

  it("반경 안 직접 좌 드래그(종전 동작 보존)", () => {
    const f = knobFrame(-30, 0, R, RATIO, UPDOWN_OFF);
    expect(f.armed).toBe("left");
    expect(f.offset).toEqual({ x: -30, y: 0 });
  });
});
