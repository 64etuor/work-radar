import { describe, expect, it } from "vitest";

import { pickActiveProjectId, relativeAgo, statusTone } from "./controlRoom";

describe("pickActiveProjectId", () => {
  it("defaults to the first project when nothing is selected", () => {
    expect(pickActiveProjectId(["a", "b"], null)).toBe("a");
  });

  it("honors a still-present selection", () => {
    expect(pickActiveProjectId(["a", "b"], "b")).toBe("b");
  });

  it("falls back to the first project when the selection disappeared", () => {
    expect(pickActiveProjectId(["a", "b"], "gone")).toBe("a");
  });

  it("returns null when there are no projects", () => {
    expect(pickActiveProjectId([], "a")).toBeNull();
    expect(pickActiveProjectId([], null)).toBeNull();
  });
});

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
