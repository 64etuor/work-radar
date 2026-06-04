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

      Evidence group: scope=governance, verified_hypotheses=2

      ### Evidence: hyp_a

      - Source hypothesis id: hyp_a
      - Source hypothesis link: hypotheses/testing/hyp_a.md
      - Source pattern id: pat_scope_a
      - Source pattern link: patterns/candidates/pat_scope_a.md
      - Baseline: 5
      - Threshold: 5
      - Test method: current_l0_scope_count

      ### Evidence: hyp_c

      - Source hypothesis id: hyp_c
      - Source hypothesis link: hypotheses/testing/hyp_c.md
      - Source pattern id: pat_scope_c
      - Source pattern link: patterns/candidates/pat_scope_c.md
      - Baseline: 6
      - Threshold: 6
      - Test method: current_l0_scope_count

      ## Scope: shell

      Evidence group: scope=shell, verified_hypotheses=1

      ### Evidence: hyp_b

      - Source hypothesis id: hyp_b
      - Source hypothesis link: hypotheses/testing/hyp_b.md
      - Source pattern id: pat_scope_b
      - Source pattern link: patterns/candidates/pat_scope_b.md
      - Baseline: 7
      - Threshold: 7
      - Test method: current_l0_scope_count

      ## Limitations

      - This draft is generated only from verified local hypotheses currently visible to P5.
      - It does not prove the proposed principle is globally true across all projects or time.
      - It does not edit L3/L4 docs, create PRs, approve decisions, or change decision rails.

      ## External residual

      External residual: human-reviewed PR converting this draft into L3/L4 changes.
      "
    `);
  });
});
