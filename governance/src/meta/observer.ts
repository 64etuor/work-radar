import type { HypothesisView } from "../hypotheses/tester.ts";
import type { MetaObservationInput, MetaObservationResult } from "./types.ts";

export function buildMetaObservation(input: MetaObservationInput): MetaObservationResult {
  const verified = input.hypotheses
    .filter(
      (hypothesis) =>
        hypothesis.kind === "commit_scope_hotspot_persists" && hypothesis.status === "verified",
    )
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));

  if (verified.length === 0) {
    return {
      hasProposal: false,
      reason: "no verified hypotheses available for local P5 observation",
    };
  }

  return {
    hasProposal: true,
    markdown: renderDraft(verified),
  };
}

function renderDraft(hypotheses: readonly HypothesisView[]): string {
  const byScope = new Map<string, HypothesisView[]>();
  for (const hypothesis of hypotheses) {
    const group = byScope.get(hypothesis.scope) ?? [];
    group.push(hypothesis);
    byScope.set(hypothesis.scope, group);
  }
  const sections = [...byScope.entries()].map(([scope, group]) => {
    const bullets = group
      .map(
        (hypothesis) =>
          `- Source hypothesis: ${hypothesis.id}\n` +
          `- Source pattern: ${hypothesis.from_pattern}\n` +
          `- Baseline: ${hypothesis.baseline}\n` +
          `- Threshold: ${hypothesis.threshold}\n` +
          `- Test method: ${hypothesis.test_method}`,
      )
      .join("\n\n");
    return `## Scope: ${scope}\n\n${bullets}`;
  });

  return `${[
    "# Principle proposal draft: recurring commit-scope hotspots",
    "This is a local Meta Observer draft. It does not edit decision rails, ADRs, or decision logs.",
    ...sections,
    "## External residual\n\nConvert this draft into a human-reviewed PR before changing docs/areas/decision-rails.md.",
  ].join("\n\n")}\n`;
}
