import { describe, it, expect } from "vitest";
import { canAccept, canRevise, canComplete, canArchive, canSupersede } from "../../src/plan/guards.js";
import type { PlanState } from "../../src/plan/plan.js";

const st = (phase: PlanState["phase"], verdict: PlanState["verdict"] = null): PlanState => ({
  planId: "evt_p1", title: "t", phase, verdict,
});

describe("plan guards", () => {
  it("canAccept: draft ok, needs_revision ok, active refused, terminal refused", () => {
    expect(canAccept(st("draft")).ok).toBe(true);
    expect(canAccept(st("needs_revision")).ok).toBe(true);
    expect(canAccept(st("active")).ok).toBe(false);
    expect(canAccept(st("completed", "completed")).ok).toBe(false);
    expect(canAccept(st("archived", "archived")).ok).toBe(false);
  });
  it("canRevise: only from active", () => {
    expect(canRevise(st("active")).ok).toBe(true);
    expect(canRevise(st("draft")).ok).toBe(false);
    expect(canRevise(st("needs_revision")).ok).toBe(false);
    expect(canRevise(st("completed", "completed")).ok).toBe(false);
  });
  it("canComplete: only from active", () => {
    expect(canComplete(st("active")).ok).toBe(true);
    expect(canComplete(st("draft")).ok).toBe(false);
    expect(canComplete(st("superseded", "superseded")).ok).toBe(false);
  });
  it("canArchive: any non-terminal, refused when terminal", () => {
    expect(canArchive(st("draft")).ok).toBe(true);
    expect(canArchive(st("active")).ok).toBe(true);
    expect(canArchive(st("needs_revision")).ok).toBe(true);
    expect(canArchive(st("archived", "archived")).ok).toBe(false);
  });
  it("canSupersede: any non-terminal, refused when terminal", () => {
    expect(canSupersede(st("draft")).ok).toBe(true);
    expect(canSupersede(st("active")).ok).toBe(true);
    expect(canSupersede(st("completed", "completed")).ok).toBe(false);
  });
});
