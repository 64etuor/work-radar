import type { GovEvent } from "../event/event.ts";

export type SpecPhase = "draft" | "accepted" | "archived";

export interface SpecState {
  specId: string;
  title: string;
  phase: SpecPhase;
  verdict: "archived" | null; // terminal marker (mirrors PlanState.verdict)
}

/** Pure fold: a spec_proposed event + its related lifecycle events → phase.
 *  `related` = events whose related_to includes the spec id (any order).
 *  Precedence: archived (terminal) > accepted > draft. `accepted` is a live, non-terminal
 *  phase (a spec stays accepted until retired). Ignores every event type it does not own
 *  (god-fold ban). */
export function deriveSpecState(created: GovEvent, related: GovEvent[]): SpecState {
  const specId = created.frontmatter.id;
  const title = created.body.split("\n", 1)[0]?.trim() || specId;
  const archived = related.some((e) => e.frontmatter.type === "spec_archived");
  const accepted = related.some((e) => e.frontmatter.type === "spec_accepted");

  let phase: SpecPhase;
  let verdict: SpecState["verdict"];
  if (archived) {
    phase = "archived";
    verdict = "archived";
  } else if (accepted) {
    phase = "accepted";
    verdict = null;
  } else {
    phase = "draft";
    verdict = null;
  }
  return { specId, title, phase, verdict };
}

/** All spec_proposed events (chronological by id). */
export function specsOf(all: GovEvent[]): GovEvent[] {
  return all
    .filter((e) => e.frontmatter.type === "spec_proposed")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
