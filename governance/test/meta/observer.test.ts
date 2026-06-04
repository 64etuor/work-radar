import { describe, expect, it } from "vitest";
import { buildMetaObservation } from "../../src/meta/observer.ts";
import type { HypothesisView } from "../../src/hypotheses/tester.ts";

function hypothesis(overrides: Partial<HypothesisView>): HypothesisView {
  return {
    id: "hyp_a",
    from_pattern: "pat_scope_a",
    kind: "commit_scope_hotspot_persists",
    scope: "governance",
    status: "verified",
    test_method: "current_l0_scope_count",
    baseline: 5,
    threshold: 5,
    expires: "2026-07-04",
    ...overrides,
  };
}

describe("buildMetaObservation", () => {
  it("returns no proposal when there are no verified hypotheses", () => {
    expect(
      buildMetaObservation({
        hypotheses: [hypothesis({ id: "hyp_refuted", status: "refuted" })],
      }),
    ).toEqual({
      hasProposal: false,
      reason: "no verified hypotheses available for local P5 observation",
    });
  });

  it("renders one deterministic proposal draft with per-scope sections", () => {
    const result = buildMetaObservation({
      hypotheses: [
        hypothesis({ id: "hyp_b", from_pattern: "pat_scope_b", scope: "shell", baseline: 7, threshold: 7 }),
        hypothesis({ id: "hyp_a", from_pattern: "pat_scope_a", scope: "governance", baseline: 5, threshold: 5 }),
        hypothesis({ id: "hyp_c", from_pattern: "pat_scope_c", scope: "governance", baseline: 6, threshold: 6 }),
        hypothesis({ id: "hyp_refuted", scope: "governance", status: "refuted" }),
      ],
    });

    expect(result.hasProposal).toBe(true);
    if (!result.hasProposal) throw new Error("expected proposal");
    expect(result.markdown).toMatchInlineSnapshot(`
      "# Principle proposal draft: recurring commit-scope hotspots

      This is a local Meta Observer draft. It does not edit decision rails, ADRs, or decision logs.

      ## Scope: governance

      - Source hypothesis: hyp_a
      - Source pattern: pat_scope_a
      - Baseline: 5
      - Threshold: 5
      - Test method: current_l0_scope_count

      - Source hypothesis: hyp_c
      - Source pattern: pat_scope_c
      - Baseline: 6
      - Threshold: 6
      - Test method: current_l0_scope_count

      ## Scope: shell

      - Source hypothesis: hyp_b
      - Source pattern: pat_scope_b
      - Baseline: 7
      - Threshold: 7
      - Test method: current_l0_scope_count

      ## External residual

      Convert this draft into a human-reviewed PR before changing docs/areas/decision-rails.md.
      "
    `);
  });
});
