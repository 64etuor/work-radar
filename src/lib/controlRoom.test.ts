import { describe, expect, it } from "vitest";

import type { SessionRow } from "../bindings";
import { bucketSessions, relativeAgo, statusTone } from "./controlRoom";

const sess = (sessionId: string, phase: SessionRow["phase"]): SessionRow => ({
  sessionId,
  surface: null,
  ownership: "user_owned",
  taskId: null,
  phase,
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

describe("bucketSessions", () => {
  it("groups sessions by lifecycle bucket", () => {
    const out = bucketSessions([
      sess("a", "active"),
      sess("b", "waiting"),
      sess("c", "context_pressure_high"),
      sess("d", "closed"),
    ]);
    expect(out.active.map((s) => s.sessionId)).toEqual(["a"]);
    expect(out.waiting.map((s) => s.sessionId)).toEqual(["b"]);
    expect(out.pressure.map((s) => s.sessionId)).toEqual(["c"]);
    expect(out.terminal.map((s) => s.sessionId)).toEqual(["d"]);
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
