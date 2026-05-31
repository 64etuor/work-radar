import type { GovEvent } from "../event/event.ts";

export type DecisionPhase = "proposed" | "reviewed" | "approved" | "rejected";

export interface DecisionState {
  decisionId: string;
  title: string;
  phase: DecisionPhase;
  reviewCount: number;
  reviewed: boolean;
  verdict: "approved" | "rejected" | null;
}

/** Pure fold: a proposal event + its related lifecycle events → gate-state.
 *  `related` = events whose related_to includes the proposal id (any order). */
export function deriveDecisionState(proposal: GovEvent, related: GovEvent[]): DecisionState {
  const decisionId = proposal.frontmatter.id;
  const title = proposal.body.split("\n", 1)[0]?.trim() || decisionId;
  const reviewCount = related.filter((e) => e.frontmatter.type === "decision_review_recorded").length;
  const rejected = related.some((e) => e.frontmatter.type === "decision_rejected");
  const approved = related.some((e) => e.frontmatter.type === "decision_approved");

  let phase: DecisionPhase;
  let verdict: DecisionState["verdict"];
  if (rejected) {
    phase = "rejected";
    verdict = "rejected";
  } else if (approved) {
    phase = "approved";
    verdict = "approved";
  } else if (reviewCount >= 1) {
    phase = "reviewed";
    verdict = null;
  } else {
    phase = "proposed";
    verdict = null;
  }
  return { decisionId, title, phase, reviewCount, reviewed: reviewCount >= 1, verdict };
}
