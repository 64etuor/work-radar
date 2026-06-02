import type { GovEvent } from "../event/event.ts";

export type PlanPhase = "draft" | "active" | "needs_revision" | "completed" | "archived" | "superseded";

export interface PlanState {
  planId: string;
  title: string;
  phase: PlanPhase;
  verdict: "completed" | "archived" | "superseded" | null; // terminal marker (mirrors TaskState.verdict)
}

/** Pure fold: a plan_proposed event + its related lifecycle events → phase.
 *  `related` = events whose related_to includes the plan id (any order).
 *  Precedence: archived > superseded > completed (terminal markers); otherwise the LATEST
 *  accepted/revised transition wins (active vs needs_revision) by the id tiebreak. ORDERING
 *  CONTRACT (Boule, docs/decisions.md): event ids (prefix_YYYYMMDD_HHMMSS_<4hex-random>) are
 *  display/tiebreak-only — the random suffix is NOT monotonic within a second, so causality is
 *  carried by explicit references, never id-order. Two same-second accepted/revised transitions
 *  on one plan do not occur in practice (human-paced), so this tiebreak is a benign display
 *  nicety, not load-bearing. Ignores every event type it does not own (god-fold ban). */
export function derivePlanState(created: GovEvent, related: GovEvent[]): PlanState {
  const planId = created.frontmatter.id;
  const title = created.body.split("\n", 1)[0]?.trim() || planId;
  const archived = related.some((e) => e.frontmatter.type === "plan_archived");
  const superseded = related.some((e) => e.frontmatter.type === "plan_superseded");
  const completed = related.some((e) => e.frontmatter.type === "plan_completed");

  let phase: PlanPhase;
  let verdict: PlanState["verdict"];
  if (archived) {
    phase = "archived";
    verdict = "archived";
  } else if (superseded) {
    phase = "superseded";
    verdict = "superseded";
  } else if (completed) {
    phase = "completed";
    verdict = "completed";
  } else {
    let latest: GovEvent | null = null;
    for (const e of related) {
      if (e.frontmatter.type !== "plan_accepted" && e.frontmatter.type !== "plan_revised") continue;
      if (!latest || e.frontmatter.id.localeCompare(latest.frontmatter.id) > 0) latest = e;
    }
    phase = !latest ? "draft" : latest.frontmatter.type === "plan_revised" ? "needs_revision" : "active";
    verdict = null;
  }
  return { planId, title, phase, verdict };
}

/** All plan_proposed events (chronological by id). */
export function plansOf(all: GovEvent[]): GovEvent[] {
  return all
    .filter((e) => e.frontmatter.type === "plan_proposed")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
