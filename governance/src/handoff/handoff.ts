import type { GovEvent } from "../event/event.ts";

export type HandoffPhase = "requested" | "validating" | "pending" | "invalid" | "consumed";

export interface HandoffState {
  handoffId: string;
  sessionId: string | null; // the session being handed off FROM (birth related_to[0])
  phase: HandoffPhase;
  verdict: "consumed" | null; // terminal marker (mirrors SessionState.verdict)
}

/** Advancing active-substate transitions, mapped to their resulting phase. LATEST by id wins. */
const SUBSTATE: Record<string, HandoffPhase> = {
  handoff_drafted: "validating",
  handoff_validated: "pending",
  handoff_invalid: "invalid",
};

/** Pure fold: a birth (handoff_requested) + its related lifecycle events → HandoffState.
 *  Precedence (clone of deriveSessionState): terminal `consumed` wins; else the latest advancing
 *  substate transition by id; else the birth phase `requested`. Fail-closed on foreign types.
 *  ORDERING CONTRACT (Boule): ids are display/tiebreak-only; same-second transitions on one
 *  handoff stream do not occur in practice, so the id tiebreak is a benign display nicety. */
export function deriveHandoffState(birth: GovEvent, related: GovEvent[]): HandoffState {
  const handoffId = birth.frontmatter.id;
  const sessionId = (birth.frontmatter.related_to ?? [])[0] ?? null;

  const consumed = related.some((e) => e.frontmatter.type === "handoff_consumed");
  if (consumed) return { handoffId, sessionId, phase: "consumed", verdict: "consumed" };

  let latest: GovEvent | null = null;
  let latestPhase: HandoffPhase | null = null;
  for (const e of related) {
    const p = SUBSTATE[e.frontmatter.type];
    if (!p) continue;
    if (!latest || e.frontmatter.id.localeCompare(latest.frontmatter.id) > 0) {
      latest = e;
      latestPhase = p;
    }
  }
  return { handoffId, sessionId, phase: latestPhase ?? "requested", verdict: null };
}

/** All handoff birth events (chronological by id). A handoff_requested referencing an existing
 *  handoff birth is excluded (defensive double-count guard, clone of sessionsOf). */
export function handoffsOf(all: GovEvent[]): GovEvent[] {
  const birthIds = new Set<string>();
  for (const e of all) {
    if (e.frontmatter.type === "handoff_requested") birthIds.add(e.frontmatter.id);
  }
  return all
    .flatMap((e) =>
      e.frontmatter.type === "handoff_requested" &&
      !(e.frontmatter.related_to ?? []).some((r) => birthIds.has(r))
        ? [e]
        : [],
    )
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
