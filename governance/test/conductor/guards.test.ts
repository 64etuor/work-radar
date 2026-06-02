import { describe, it, expect } from "vitest";
import { canAdvance } from "../../src/conductor/guards.js";
import type { ConductorState } from "../../src/conductor/conductor.js";

function st(over: Partial<ConductorState>): ConductorState {
  return {
    planId: "evt_p1", planPhase: "active", steps: [], cursor: 0, halted: false, done: false, ...over,
  };
}

describe("canAdvance — conduct precondition", () => {
  it("refuses when the plan is not active (human accept_plan is the gate)", () => {
    expect(canAdvance(st({ planPhase: "draft" })).ok).toBe(false);
    expect(canAdvance(st({ planPhase: "needs_revision" })).ok).toBe(false);
    expect(canAdvance(st({ planPhase: "completed" })).ok).toBe(false);
  });

  it("refuses when halted (open decision_blocked — NO timeout/default/skip path)", () => {
    const g = canAdvance(st({ halted: true }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/halt/i);
  });

  it("refuses when done", () => {
    expect(canAdvance(st({ done: true })).ok).toBe(false);
  });

  it("refuses when cursor === null (a step is in-flight)", () => {
    const g = canAdvance(st({ cursor: null }));
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/in-flight/i);
  });

  it("ok when active, not halted/done, cursor set", () => {
    const g = canAdvance(st({ cursor: 2 }));
    expect(g.ok).toBe(true);
    expect(g.reason).toMatch(/2/);
  });

  it("PRECEDENCE: halted is reported before done/in-flight", () => {
    const g = canAdvance(st({ planPhase: "active", halted: true, done: true, cursor: null }));
    expect(g.reason).toMatch(/halt/i);
  });
});
