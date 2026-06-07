import { describe, expect, it } from "vitest";

import { relativeAgo, statusTone } from "./controlRoom";

describe("statusTone", () => {
  it("maps phases to the master §12 color buckets", () => {
    expect(statusTone("done")).toBe("done");
    expect(statusTone("active")).toBe("active");
    expect(statusTone("waiting")).toBe("waiting");
    expect(statusTone("context_pressure_high")).toBe("pressure");
    expect(statusTone("blocked")).toBe("blocked");
    expect(statusTone("closed")).toBe("muted");
    expect(statusTone("unknown")).toBe("muted");
  });
});

describe("relativeAgo", () => {
  it("returns a placeholder when never projected", () => {
    expect(relativeAgo(null, 1_000_000)).toBe("아직 프로젝션 없음");
  });
  it("formats minutes since the projection mtime", () => {
    const now = Date.parse("2026-06-03T00:10:00Z");
    expect(relativeAgo("2026-06-03T00:00:00Z", now)).toBe("10분 전 프로젝션");
  });
});
