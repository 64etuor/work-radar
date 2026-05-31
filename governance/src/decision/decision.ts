import type { GovEvent } from "../event/event.ts";
import { normalizeModelId } from "./modelId.ts";

export type DecisionPhase = "proposed" | "reviewed" | "approved" | "rejected";

export interface DecisionState {
  decisionId: string;
  title: string;
  phase: DecisionPhase;
  reviewCount: number;
  reviewed: boolean;
  verdict: "approved" | "rejected" | null;
}

/** Read the normalized author model recorded on a review event (tag `author_model:<id>`). */
function reviewAuthorModel(e: GovEvent): string | null {
  const tag = e.frontmatter.tags.find((t) => t.startsWith("author_model:"));
  return tag ? tag.slice("author_model:".length) : null;
}

/** Pure fold: a proposal event + its related lifecycle events → gate-state.
 *  `related` = events whose related_to includes the proposal id (any order). */
export function deriveDecisionState(proposal: GovEvent, related: GovEvent[]): DecisionState {
  const decisionId = proposal.frontmatter.id;
  const title = proposal.body.split("\n", 1)[0]?.trim() || decisionId;
  // MINOR b: count a review ONLY when its recorded reviewer_model ≠ author_model (normalized).
  // A forged same-model review event, or one missing the author tag, does not satisfy the gate.
  const reviewCount = related.filter((e) => {
    if (e.frontmatter.type !== "decision_review_recorded") return false;
    const author = reviewAuthorModel(e);
    if (author === null) return false; // fail-closed
    return normalizeModelId(e.frontmatter.actor) !== normalizeModelId(author);
  }).length;
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
