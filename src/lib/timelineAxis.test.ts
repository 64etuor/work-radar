import { describe, expect, it } from "vitest";

import {
  clientToGrid,
  DAY_PX,
  HOUR_PX,
  LABEL_GUTTER_PX,
  MIN_BLOCK_PX,
  MIN_PER_DAY,
  minToPx,
  PX_PER_MIN,
  pxToMin,
  SNAP_MIN,
  totalPxForDays,
} from "./timelineAxis";

describe("timelineAxis constants", () => {
  it("pins the values the whole timeline relies on", () => {
    expect(HOUR_PX).toBe(60);
    expect(MIN_BLOCK_PX).toBe(20);
    expect(SNAP_MIN).toBe(15);
    expect(MIN_PER_DAY).toBe(1440);
    expect(PX_PER_MIN).toBe(1);
    expect(DAY_PX).toBe(1440);
    expect(LABEL_GUTTER_PX).toBe(60);
  });
});

describe("minToPx / pxToMin", () => {
  it("round-trips minutes through pixels", () => {
    for (const min of [0, 15, 90, 1439, 2880]) {
      expect(pxToMin(minToPx(min))).toBe(min);
    }
  });
  it("uses 1px == 1min (HOUR_PX/60)", () => {
    expect(minToPx(60)).toBe(60);
    expect(pxToMin(60)).toBe(60);
  });
});

describe("totalPxForDays", () => {
  it("is days * DAY_PX", () => {
    expect(totalPxForDays(1)).toBe(1440);
    expect(totalPxForDays(3)).toBe(4320);
  });
});

describe("clientToGrid", () => {
  const rect = { left: 100, top: 200, width: 800 };
  it("subtracts rect origin", () => {
    expect(clientToGrid({ x: 460, y: 560 }, rect, 4320)).toEqual({ x: 360, y: 360 });
  });
  it("clamps y to [0, totalPx]", () => {
    expect(clientToGrid({ x: 460, y: 100 }, rect, 4320).y).toBe(0);
    expect(clientToGrid({ x: 460, y: 999999 }, rect, 4320).y).toBe(4320);
  });
  it("clamps x to [LABEL_GUTTER_PX, rect.width]", () => {
    expect(clientToGrid({ x: 100, y: 560 }, rect, 4320).x).toBe(LABEL_GUTTER_PX);
    expect(clientToGrid({ x: 999999, y: 560 }, rect, 4320).x).toBe(800);
  });
});
