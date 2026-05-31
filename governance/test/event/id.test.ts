import { describe, it, expect } from "vitest";
import { generateId, stampUtc } from "../../src/event/id.js";

describe("stampUtc", () => {
  it("formats UTC as YYYYMMDD_HHMMSS", () => {
    const d = new Date(Date.UTC(2026, 4, 16, 14, 32, 18));
    expect(stampUtc(d)).toBe("20260516_143218");
  });
});

describe("generateId", () => {
  it("builds prefix_stamp_4hex deterministically", () => {
    const d = new Date(Date.UTC(2026, 4, 16, 14, 32, 18));
    // 0.64 * 0x10000 = 41943 = 0xa3d7
    expect(generateId("evt", d, 0.64)).toBe("evt_20260516_143218_a3d7");
  });

  it("zero-pads the hex suffix to 4 chars", () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    expect(generateId("ptn", d, 0)).toBe("ptn_20260101_000000_0000");
  });
});
