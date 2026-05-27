import { describe, expect, it } from "vitest";

import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  INBOX_FOOTER_HEIGHT,
  computeInboxHeight,
  computeZonePositions,
  rectContainsPoint,
} from "@/components/board/matrixGeometry";

describe("matrixGeometry", () => {
  it("computes responsive inbox height with footer space reserved", () => {
    expect(computeInboxHeight({ itemCount: 0, width: 320 })).toBe(
      40 + CARD_HEIGHT + CARD_GAP + 8 + INBOX_FOOTER_HEIGHT,
    );
    expect(computeInboxHeight({ itemCount: 5, width: 360 })).toBe(
      40 + 3 * (CARD_HEIGHT + CARD_GAP) + 8 + INBOX_FOOTER_HEIGHT,
    );
  });

  it("stacks single-column inbox cards with alternating offsets", () => {
    const positions = computeZonePositions({
      count: 3,
      zone: "unclassified",
      rect: { x: 10, y: 20, w: 170, h: 360 },
    });

    expect(positions).toEqual([
      { x: 26, y: 60, rotation: -2 },
      { x: 38, y: 118, rotation: 2 },
      { x: 26, y: 176, rotation: -2 },
    ]);
  });

  it("lays out multi-column inbox cards with the existing grid offsets", () => {
    const positions = computeZonePositions({
      count: 4,
      zone: "unclassified",
      rect: { x: 10, y: 20, w: 520, h: 360 },
    });

    expect(positions).toEqual([
      { x: 24, y: 60, rotation: 0 },
      { x: 186, y: 60, rotation: 0 },
      { x: 348, y: 60, rotation: 0 },
      { x: 24, y: 164, rotation: 0 },
    ]);
  });

  it("lays out matrix quadrant cards with the existing grid offsets", () => {
    const positions = computeZonePositions({
      count: 3,
      zone: "q1",
      rect: { x: 200, y: 100, w: 360, h: 260 },
    });

    expect(positions).toEqual([
      { x: 214, y: 138, rotation: 0 },
      { x: 376, y: 138, rotation: 0 },
      { x: 214, y: 242, rotation: 0 },
    ]);
  });

  it("hit-tests points against inclusive rect bounds", () => {
    const rect = { x: 10, y: 20, w: CARD_WIDTH, h: CARD_HEIGHT };

    expect(rectContainsPoint(rect, 10, 20)).toBe(true);
    expect(rectContainsPoint(rect, 160, 112)).toBe(true);
    expect(rectContainsPoint(rect, 161, 112)).toBe(false);
    expect(rectContainsPoint(rect, 160, 113)).toBe(false);
  });
});
