import { describe, it, expect } from "vitest";
import { canAccept, canArchive } from "../../src/spec/guards.js";
import type { SpecState } from "../../src/spec/spec.js";

const st = (phase: SpecState["phase"], verdict: SpecState["verdict"] = null): SpecState => ({
  specId: "evt_s1", title: "t", phase, verdict,
});

describe("spec guards", () => {
  it("canAccept: draft ok, accepted refused, archived refused", () => {
    expect(canAccept(st("draft")).ok).toBe(true);
    expect(canAccept(st("accepted")).ok).toBe(false);
    expect(canAccept(st("archived", "archived")).ok).toBe(false);
  });
  it("canArchive: draft ok, accepted ok, archived refused", () => {
    expect(canArchive(st("draft")).ok).toBe(true);
    expect(canArchive(st("accepted")).ok).toBe(true);
    expect(canArchive(st("archived", "archived")).ok).toBe(false);
  });
});
