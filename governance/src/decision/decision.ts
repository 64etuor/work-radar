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
 *  `related` = events whose related_to includes the proposal id (any order).
 *  @param quorum minimum number of DISTINCT reviewer models required to reach `reviewed`;
 *    callers must pass >= 1. The server boundary clamps untrusted input — this fold does not
 *    (a quorum of 0 would make the gate vacuously true). */
export function deriveDecisionState(
  proposal: GovEvent,
  related: GovEvent[],
  quorum = 1,
): DecisionState {
  const decisionId = proposal.frontmatter.id;
  const title = proposal.body.split("\n", 1)[0]?.trim() || decisionId;
  // §7: count DISTINCT normalized reviewer models (not events). A review qualifies only
  // when its recorded reviewer model ≠ author_model (normalized); a forged same-model
  // event, or one missing the author tag, does not satisfy the gate (fail-closed).
  const distinctModels = new Set<string>();
  for (const e of related) {
    if (e.frontmatter.type !== "decision_review_recorded") continue;
    const author = reviewAuthorModel(e);
    if (author === null) continue; // fail-closed
    const reviewer = normalizeModelId(e.frontmatter.actor);
    if (reviewer !== normalizeModelId(author)) distinctModels.add(reviewer);
  }
  const reviewCount = distinctModels.size;
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
  } else if (reviewCount >= quorum) {
    phase = "reviewed";
    verdict = null;
  } else {
    phase = "proposed";
    verdict = null;
  }
  return { decisionId, title, phase, reviewCount, reviewed: reviewCount >= quorum, verdict };
}
