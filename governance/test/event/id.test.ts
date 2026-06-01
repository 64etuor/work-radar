import { describe, it, expect } from "vitest";
import { generateId, stampUtc } from "../../src/event/id.js";
import { deriveEventId, sha256hex } from "../../src/event/id.js";

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

describe("sha256hex", () => {
  it("is stable and 64 hex chars", () => {
    expect(sha256hex("abc")).toBe(sha256hex("abc"));
    expect(sha256hex("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256hex("abc")).not.toBe(sha256hex("abd"));
  });
});

describe("deriveEventId", () => {
  it("embeds full source identity, never truncated", () => {
    const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334";
    expect(deriveEventId("commit", sha)).toBe(`evt_commit_${sha}`);
    expect(deriveEventId("adr", "ADR-0007")).toBe("evt_adr_ADR-0007");
  });
  it("hashes the normalized text for decision ids", () => {
    const key = "some decision bullet";
    expect(deriveEventId("decision", key)).toBe(`evt_decision_${sha256hex(key)}`);
  });
  it("is deterministic across calls", () => {
    expect(deriveEventId("commit", "deadbeef")).toBe(deriveEventId("commit", "deadbeef"));
  });
});
