import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { derivePlanState, plansOf, type PlanState } from "./plan.ts";

/** PURE: events → plan states (sorted by plan id via plansOf). No I/O, emits no events. */
export function projectPlans(all: GovEvent[]): PlanState[] {
  return plansOf(all).map((p) => {
    const grp = eventsForDecision(all, p.frontmatter.id);
    return derivePlanState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/plans.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable output. This is the ONLY writer
 *  of plan status; no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderPlans(workspaceDir: string): Promise<string> {
  const states = projectPlans(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "plans.json");
  const rows = states.map((s) => ({ planId: s.planId, title: s.title, phase: s.phase }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
