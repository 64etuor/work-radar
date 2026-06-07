import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { writeEvent } from "../event/writeEvent.ts";
import { generateId } from "../event/id.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { plansOf, derivePlanState } from "../plan/plan.ts";
import { canAccept as canAcceptPlan } from "../plan/guards.ts";
import { specsOf, deriveSpecState } from "../spec/spec.ts";
import { canAccept as canAcceptSpec } from "../spec/guards.ts";
import { autonomyAllows, type AutonomyLevel } from "../repo/config.ts";

export interface AutoAcceptSummary {
  specsAccepted: number;
  plansAccepted: number;
}

/** Orchestrator-level auto-acceptance, gated by autonomyLevel (per-repo config). This is the ONLY
 *  thing that opens INVARIANT #1's acceptance gate, and ONLY when the config explicitly sets
 *  auto_plan/full (test/dev). Properties that keep it honest + bounded:
 *   - actor:"system" + an "autonomy-auto" tag — NEVER forged as actor:"user" (a machine-opened gate
 *     stays visible in the audit chain).
 *   - reuses the SAME canAccept guard as the human path; idempotent (already-active/terminal skipped),
 *     so repeated passes (e.g. per tick) don't double-accept.
 *   - acceptance ONLY — it never resolves a decision_blocked or recovers a stall (those stay human
 *     even at `full`); Type-1 mid-execution still halts.
 *   - a spawned EXECUTOR session can NOT reach this: it is invoked ONLY from the `auto_dispatch` MCP
 *     tool, which is structurally NOT registered for executor role (server.ts gates it on
 *     SESSION_ALLOWS_VERDICTS) and is in SESSION_DENIED_TOOLS — same two-layer barrier as
 *     accept_plan/accept_spec. (Does NOT rely on env isolation.) */
export async function autoAccept(
  workspaceDir: string,
  level: AutonomyLevel,
  now: Date,
  rand: number,
): Promise<AutoAcceptSummary> {
  const summary: AutoAcceptSummary = { specsAccepted: 0, plansAccepted: 0 };
  if (!autonomyAllows.autoAcceptPlan(level)) return summary; // manual / dispatch → no auto-accept

  const all = await readAllEvents(workspaceDir);
  let offset = 0;
  const stamp = () => new Date(now.getTime() + offset++ * 1000); // distinct chronological ids

  // full → accept proposed specs first (so auto-accepted plans sit on accepted specs).
  if (autonomyAllows.autoAcceptSpec(level)) {
    for (const sp of specsOf(all)) {
      const grp = eventsForDecision(all, sp.frontmatter.id);
      const s = deriveSpecState(grp.proposal!, grp.related);
      if (canAcceptSpec(s).ok) {
        await writeAutoAccepted(workspaceDir, "spec_accepted", s.specId, "spec", level, stamp(), rand);
        summary.specsAccepted++;
      }
    }
  }
  // auto_plan | full → accept proposed plans.
  for (const p of plansOf(all)) {
    const grp = eventsForDecision(all, p.frontmatter.id);
    const s = derivePlanState(grp.proposal!, grp.related);
    if (canAcceptPlan(s).ok) {
      await writeAutoAccepted(workspaceDir, "plan_accepted", s.planId, "plan", level, stamp(), rand);
      summary.plansAccepted++;
    }
  }
  return summary;
}

async function writeAutoAccepted(
  workspaceDir: string,
  type: EventType,
  id: string,
  tag: string,
  level: AutonomyLevel,
  now: Date,
  rand: number,
): Promise<void> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type,
      source: "system",
      actor: "system", // NOT "user" — an auto-accept must never masquerade as a human approval.
      tags: [tag, "autonomy-auto"],
      related_to: [id],
    },
    body: `Auto-accepted ${id} (autonomyLevel=${level})`,
  };
  await writeEvent(workspaceDir, evt, now);
}
