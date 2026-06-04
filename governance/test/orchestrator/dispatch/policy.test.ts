import { describe, expect, it } from "vitest";
import { evaluateAutoDispatch, isTerminalPlanPhase } from "../../../src/orchestrator/dispatch/policy.js";
import type { ConductorState } from "../../../src/conductor/conductor.js";

function cs(overrides: Partial<ConductorState>): ConductorState {
  return {
    planId: "plan_x",
    planPhase: "active",
    steps: [],
    cursor: 0,
    halted: false,
    done: false,
    ...overrides,
  };
}

function reasonOf(verdict: ReturnType<typeof evaluateAutoDispatch>): string {
  expect(verdict.decision).toBe("deny");
  return verdict.decision === "deny" ? verdict.reason : "";
}

describe("evaluateAutoDispatch (deny-by-default)", () => {
  it("allows an active, not-halted, not-done plan with a ready cursor", () => {
    expect(evaluateAutoDispatch(cs({ cursor: 2 }), "type2")).toEqual({
      decision: "allow",
      planId: "plan_x",
      stepIndex: 2,
    });
  });

  it("denies when mode is off", () => {
    expect(evaluateAutoDispatch(cs({}), "off")).toEqual({
      decision: "deny",
      planId: "plan_x",
      reason: "mode_off",
    });
  });

  it("denies a non-accepted plan", () => {
    expect(reasonOf(evaluateAutoDispatch(cs({ planPhase: "draft" }), "type2"))).toBe("plan_not_accepted");
    expect(reasonOf(evaluateAutoDispatch(cs({ planPhase: "needs_revision" }), "type2"))).toBe("plan_not_accepted");
  });

  it("denies a halted plan before done or in-flight", () => {
    expect(reasonOf(evaluateAutoDispatch(cs({ halted: true, done: true, cursor: null }), "type2"))).toBe("halted");
  });

  it("denies a fully-conducted plan as done", () => {
    expect(reasonOf(evaluateAutoDispatch(cs({ done: true, cursor: null }), "type2"))).toBe("done");
  });

  it("denies an in-flight plan when cursor is null", () => {
    expect(reasonOf(evaluateAutoDispatch(cs({ cursor: null }), "type2"))).toBe("in_flight");
  });

  it("checks mode first", () => {
    expect(reasonOf(evaluateAutoDispatch(cs({ planPhase: "draft", halted: true, cursor: null }), "off"))).toBe("mode_off");
  });
});

describe("isTerminalPlanPhase", () => {
  it("treats completed, archived, and superseded as terminal", () => {
    expect(isTerminalPlanPhase("completed")).toBe(true);
    expect(isTerminalPlanPhase("archived")).toBe(true);
    expect(isTerminalPlanPhase("superseded")).toBe(true);
    expect(isTerminalPlanPhase("active")).toBe(false);
    expect(isTerminalPlanPhase("draft")).toBe(false);
  });
});
