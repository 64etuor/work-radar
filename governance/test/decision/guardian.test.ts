import { describe, it, expect } from "vitest";
import { canApprove, canReject, gateLabel } from "../../src/decision/guardian.js";
import type { DecisionState } from "../../src/decision/decision.js";

function state(over: Partial<DecisionState>): DecisionState {
  return { decisionId: "evt_x", title: "t", phase: "proposed", reviewCount: 0, reviewed: false, verdict: null, ...over };
}

describe("Type 1 Guardian", () => {
  it("REFUSES approval of an un-reviewed decision (the INVARIANT #1 mechanization)", () => {
    const r = canApprove(state({ phase: "proposed", reviewed: false }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/external review/i);
  });

  it("ALLOWS approval once at least one external review exists", () => {
    const r = canApprove(state({ phase: "reviewed", reviewed: true, reviewCount: 1 }));
    expect(r.ok).toBe(true);
  });

  it("REFUSES re-approval after a terminal verdict", () => {
    expect(canApprove(state({ verdict: "approved", reviewed: true })).ok).toBe(false);
    expect(canApprove(state({ verdict: "rejected", reviewed: true })).ok).toBe(false);
  });

  it("ALLOWS rejection before a verdict, REFUSES after", () => {
    expect(canReject(state({ phase: "proposed" })).ok).toBe(true);
    expect(canReject(state({ verdict: "approved" })).ok).toBe(false);
  });

  it("gateLabel summarizes the pending gate", () => {
    expect(gateLabel(state({ phase: "proposed" }))).toMatch(/review/i);
    expect(gateLabel(state({ phase: "reviewed", reviewed: true }))).toMatch(/human|approval/i);
  });
});
