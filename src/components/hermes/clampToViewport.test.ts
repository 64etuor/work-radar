import { describe, expect, it } from "vitest";

import { clampToViewport, defaultBounds } from "./clampToViewport";

describe("clampToViewport", () => {
  it("returns input unchanged when bounds are fully inside viewport", () => {
    const b = { x: 100, y: 100, w: 460, h: 600 };
    expect(clampToViewport(b, 1440, 900)).toEqual(b);
  });

  it("pulls panel back when it extends past the right edge", () => {
    // x=1000, w=460 → right edge = 1460 which exceeds vw=1440 → x should clamp to 1440-460=980
    const b = { x: 1000, y: 100, w: 460, h: 600 };
    const result = clampToViewport(b, 1440, 900);
    expect(result.x).toBe(980);
    expect(result.y).toBe(100);
  });

  it("clamps negative x to 0", () => {
    const b = { x: -50, y: 100, w: 460, h: 600 };
    const result = clampToViewport(b, 1440, 900);
    expect(result.x).toBe(0);
  });

  it("clamps height to viewport height", () => {
    const b = { x: 100, y: 0, w: 460, h: 1200 };
    const result = clampToViewport(b, 1440, 900);
    expect(result.h).toBe(900);
    expect(result.y).toBe(0);
  });
});

describe("defaultBounds", () => {
  it("uses a tall portrait phone-chat shape on a large viewport", () => {
    const b = defaultBounds(1440, 900);
    expect(b.w).toBe(380);
    expect(b.h).toBe(720);
    // portrait: clearly taller than wide
    expect(b.h).toBeGreaterThan(b.w);
  });

  it("centers horizontally and below the top bar on a large viewport", () => {
    const b = defaultBounds(1440, 900);
    // horizontal center: (1440 - 380) / 2 = 530
    expect(b.x).toBe(530);
    // vertical center within usable area below the 56px top bar
    expect(b.y).toBeGreaterThanOrEqual(56);
  });

  it("clamps to the viewport (with margin) on a short/narrow viewport", () => {
    const b = defaultBounds(400, 600);
    // width never exceeds vw - margin, height never exceeds usable - margin
    expect(b.w).toBeLessThanOrEqual(400 - 32);
    expect(b.h).toBeLessThanOrEqual(600 - 56 - 32);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(56);
  });
});
