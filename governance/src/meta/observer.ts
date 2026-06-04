import type { HypothesisView } from "../hypotheses/tester.ts";
import type { MetaObservationInput, MetaObservationResult } from "./types.ts";

export function buildMetaObservation(input: MetaObservationInput): MetaObservationResult {
  const verified = input.hypotheses
    .filter((hypothesis) => hypothesis.kind === "commit_scope_hotspot_persists")
    .filter((hypothesis) => hypothesis.status === "verified")
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
          `### Evidence: ${hypothesis.id}\n\n` +
          `- Source hypothesis id: ${hypothesis.id}\n` +
          `- Source hypothesis link: hypotheses/testing/${hypothesis.id}.md\n` +
          `- Source pattern id: ${hypothesis.from_pattern}\n` +
          `- Source pattern link: patterns/candidates/${hypothesis.from_pattern}.md\n` +
          `- Baseline: ${hypothesis.baseline}\n` +
          `- Threshold: ${hypothesis.threshold}\n` +
          `- Test method: ${hypothesis.test_method}`,
      )
      .join("\n\n");
    return `## Scope: ${scope}\n\nEvidence group: scope=${scope}, verified_hypotheses=${group.length}\n\n${bullets}`;
  });

  return `${[
    "# Principle proposal draft: recurring commit-scope hotspots",
    "This is a local Meta Observer draft. It does not edit decision rails, ADRs, or decision logs.",
    ...sections,
    "## Limitations\n\n" +
      "- This draft is generated only from verified local hypotheses currently visible to P5.\n" +
      "- It does not prove the proposed principle is globally true across all projects or time.\n" +
      "- It does not edit L3/L4 docs, create PRs, approve decisions, or change decision rails.",
    "## External residual\n\nExternal residual: human-reviewed PR converting this draft into L3/L4 changes.",
  ].join("\n\n")}\n`;
}
