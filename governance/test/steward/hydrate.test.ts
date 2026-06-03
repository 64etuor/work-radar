import { describe, it, expect } from "vitest";
import { assembleBundle, type AssembleInputs } from "../../src/steward/hydrate.js";
import type { GovEvent } from "../../src/event/event.js";

const base: AssembleInputs = {
  handoff: { handoffId: "evt_h1", sessionId: "evt_s1", phase: "pending", verdict: null },
  handoffBody: "## Mission\nfinish X\n\n## Next exact steps\nrun build",
  log: [],
  principles: ["INVARIANT #1: automation must not penetrate the decision rail"],
  spec: "spec: build X",
  activePlan: "plan: 3 steps",
  currentTask: "task: step 2",
  indexNeighbors: [{ node_id: "task:evt_t1", title: "step 2" }],
  gitSummary: { status: "M src/foo.ts", diffstat: "1 file changed" },
  autonomyEnvelope: "read-only; no network",
};

describe("assembleBundle", () => {
  it("returns a structured bundle and a rendered markdown string", () => {
    const { bundle, markdown } = assembleBundle(base);
    expect(bundle.spec).toBe("spec: build X");
    expect(markdown).toContain("# Hydration Bundle");
    expect(markdown).toContain("run build");
  });

  it("LAUNDERING-PREVENTION: carries ONLY open decision_blocked (resolved excluded), surfaces it in markdown, no authority field", () => {
    const log: GovEvent[] = [
      // RESOLVED fork (blocked → chosen) → must NOT survive into the bundle.
      { frontmatter: { id: "evt_dp_r", type: "decision_proposed", source: "agent_run", actor: "a", tags: [] }, body: "resolved fork" },
      { frontmatter: { id: "evt_db_r", type: "decision_blocked", source: "agent_run", actor: "a", tags: [], related_to: ["evt_dp_r"] }, body: "resolved blocker" },
      { frontmatter: { id: "evt_ch", type: "decision_chosen", source: "hermes", actor: "user", tags: [], related_to: ["evt_dp_r"] }, body: "picked A" },
      // STILL-OPEN fork → MUST survive (laundering ban).
      { frontmatter: { id: "evt_dp_o", type: "decision_proposed", source: "agent_run", actor: "a", tags: [] }, body: "open fork" },
      { frontmatter: { id: "evt_db_o", type: "decision_blocked", source: "agent_run", actor: "a", tags: [], related_to: ["evt_dp_o"] }, body: "needs human now" },
    ];
    const { bundle, markdown } = assembleBundle({ ...base, log });
    expect(bundle.openBlockers.map((b) => b.decisionId)).toEqual(["evt_dp_o"]); // resolved one excluded
    expect(markdown).toContain("evt_dp_o"); // open blocker surfaced in the rendered bundle
    expect(bundle.autonomyEnvelope).toBe("read-only; no network"); // envelope field echoed (placeholder this slice)
    // No authority-granting field may exist on the bundle (laundering ban — informs, never empowers).
    const forbidden = /grant|approve|allow|permit|authori/i;
    expect(Object.keys(bundle).some((k) => forbidden.test(k))).toBe(false);
  });
});
