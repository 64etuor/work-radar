import { machineUncertifiableSteps, type MachineUncertifiableStep } from "../conductor/conductor.ts";
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
 *     accept_plan/accept_spec. (Does NOT rely on env isolation.)
 *   - CHECKLESS AUTHORING GATE (P2a, fail-closed narrowing): a plan with ANY step no machine can
 *     certify (checkless, or explicit check:{kind:"human"}) is NEVER auto-accepted — it is demoted
 *     to the human accept_plan gate with ONE verdict-free `action_denied` naming the step indices
 *     (the same event vocabulary autoDispatch uses for denied actions; deduped per plan+reason).
 *     Without this, a full-auto plan silently dead-ends at needs_human mid-flight (live 2026-06-10). */
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

  // Existing denials (planId+reason), so repeated passes never re-record the same demotion —
  // mirrors autoDispatch's action_denied dedup.
  const denied = new Set<string>();
  for (const e of all) {
    if (e.frontmatter.type !== "action_denied") continue;
    const key = deniedKeyOf(e.body);
    if (key) denied.add(key);
  }

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
  // auto_plan | full → accept proposed plans, UNLESS a step lacks a machine check contract.
  for (const p of plansOf(all)) {
    const grp = eventsForDecision(all, p.frontmatter.id);
    const s = derivePlanState(grp.proposal!, grp.related);
    if (!canAcceptPlan(s).ok) continue;
    const uncertifiable = machineUncertifiableSteps(grp.proposal!.body);
    if (uncertifiable.length > 0) {
      const reason = checklessDenyReason(uncertifiable);
      const key = `${s.planId}\u0000${reason}`;
      if (!denied.has(key)) {
        await writeAutoDenied(workspaceDir, s.planId, uncertifiable, reason, stamp(), rand);
        denied.add(key);
      }
      continue; // human accept_plan remains available (with a warning) — see plan/handlers.ts
    }
    await writeAutoAccepted(workspaceDir, "plan_accepted", s.planId, "plan", level, stamp(), rand);
    summary.plansAccepted++;
  }
  return summary;
}

function deniedKeyOf(body: string): string | null {
  try {
    const b = JSON.parse(body) as { planId?: unknown; reason?: unknown };
    if (typeof b.planId === "string" && typeof b.reason === "string") return `${b.planId}\u0000${b.reason}`;
  } catch {
    /* foreign body shape — not ours */
  }
  return null;
}

function checklessDenyReason(steps: MachineUncertifiableStep[]): string {
  const indices = steps.map((s) => s.stepIndex).join(", ");
  return (
    `auto-accept denied: step(s) ${indices} have no machine-certifiable check ` +
    `(need a worktree-relative check.artifact; check:{"kind":"human"} = explicit human certification) — ` +
    `human accept_plan required`
  );
}

/** The demotion record: verdict-free `action_denied` (the SAME event type autoDispatch mints for
 *  denied actions — no new decision_* vocabulary), actor:system, explaining WHICH steps blocked
 *  auto-accept. The plan itself is untouched (stays proposed for the human gate). */
async function writeAutoDenied(
  workspaceDir: string,
  planId: string,
  steps: MachineUncertifiableStep[],
  reason: string,
  now: Date,
  rand: number,
): Promise<void> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "action_denied",
      source: "system",
      actor: "system",
      tags: ["plan", "autonomy-auto"],
      related_to: [planId],
    },
    body: JSON.stringify({ planId, stepIndices: steps.map((s) => s.stepIndex), reason }),
  };
  // Disambiguator: autoDispatch can mint its own action_denied for the SAME plan in the SAME tick
  // second (e.g. the still-draft plan is denied dispatch right after this demotion) — the filename
  // must not collide with it (writeEvent is wx-immutable).
  await writeEvent(workspaceDir, evt, now, { disambiguator: `autoaccept-${planId.slice(-4)}` });
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
