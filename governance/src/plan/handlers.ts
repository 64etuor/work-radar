import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { derivePlanState, plansOf, type PlanState } from "./plan.ts";
import { canAccept, canRevise, canComplete, canArchive, canSupersede } from "./guards.ts";

export interface PlanGateResult { ok: boolean; reason: string; eventId?: string; }

async function loadPlan(workspaceDir: string, planId: string): Promise<{ state: PlanState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, planId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "plan_proposed")
    throw new Error(`unknown plan: ${planId}`);
  return { state: derivePlanState(grp.proposal, grp.related), all };
}

/** A human-gated lifecycle write: every non-propose transition is actor:"user" in this slice
 *  (Conductor agent-driven advancement lands in Phase C). Mirrors task/handlers writeLifecycle. */
async function writeLifecycle(
  workspaceDir: string, type: EventType, planId: string, body: string, now: Date, rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type, source: "hermes", actor: "user",
      tags: ["plan"], related_to: [planId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

export interface ProposePlanInput { intent: string; steps: string[]; }
export interface ProposePlanResult { planId: string; }

/** Planner — consumes a "load feature X" intent, emits EXACTLY ONE plan_proposed (draft).
 *  actor:"planner" (NOT a human, NOT a verdict). This is the ONLY write path here; there is no
 *  acceptance path, so the Planner cannot accept its own plan (structural INVARIANT #1). */
export async function proposePlan(
  workspaceDir: string, input: ProposePlanInput, now: Date, rand: number,
): Promise<ProposePlanResult> {
  const intent = input.intent?.trim();
  if (!intent) throw new Error("plan intent must be non-empty");
  const steps = (input.steps ?? []).map((s) => s.trim()).filter(Boolean);
  if (steps.length === 0) throw new Error("plan must have at least one step");
  const body = `${intent}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "plan_proposed", source: "hermes", actor: "planner",
      tags: ["plan"],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return { planId: evt.frontmatter.id };
}

/** accept_plan — HUMAN GATE: draft/needs_revision → active (actor:"user"). */
export async function acceptPlan(workspaceDir: string, input: { planId: string }, now: Date, rand: number): Promise<PlanGateResult> {
  const { state } = await loadPlan(workspaceDir, input.planId);
  const gate = canAccept(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "plan_accepted", input.planId, `Accepted ${input.planId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** revise_plan — active → needs_revision (records reason). */
export async function revisePlan(workspaceDir: string, input: { planId: string; reason: string }, now: Date, rand: number): Promise<PlanGateResult> {
  const { state } = await loadPlan(workspaceDir, input.planId);
  const gate = canRevise(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "plan_revised", input.planId, `Revision requested for ${input.planId}: ${input.reason}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** complete_plan — active → completed (terminal). */
export async function completePlan(workspaceDir: string, input: { planId: string }, now: Date, rand: number): Promise<PlanGateResult> {
  const { state } = await loadPlan(workspaceDir, input.planId);
  const gate = canComplete(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "plan_completed", input.planId, `Completed ${input.planId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** archive_plan — any non-terminal → archived (terminal). */
export async function archivePlan(workspaceDir: string, input: { planId: string }, now: Date, rand: number): Promise<PlanGateResult> {
  const { state } = await loadPlan(workspaceDir, input.planId);
  const gate = canArchive(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "plan_archived", input.planId, `Archived ${input.planId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** supersede_plan — any non-terminal → superseded (terminal). */
export async function supersedePlan(workspaceDir: string, input: { planId: string }, now: Date, rand: number): Promise<PlanGateResult> {
  const { state } = await loadPlan(workspaceDir, input.planId);
  const gate = canSupersede(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "plan_superseded", input.planId, `Superseded ${input.planId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

export interface PlanSummary { planId: string; title: string; phase: PlanState["phase"]; }

/** plans — non-terminal plans. */
export async function listPlans(workspaceDir: string): Promise<PlanSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: PlanSummary[] = [];
  for (const p of plansOf(all)) {
    const grp = eventsForDecision(all, p.frontmatter.id);
    const s = derivePlanState(grp.proposal!, grp.related);
    if (s.verdict === null) out.push({ planId: s.planId, title: s.title, phase: s.phase });
  }
  return out;
}

export interface PlanTrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface PlanTrail { planId: string; title: string; phase: PlanState["phase"]; chain: PlanTrailEntry[]; }

/** plan <id> — full chronological trail. */
export async function planTrail(workspaceDir: string, input: { planId: string }): Promise<PlanTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.planId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "plan_proposed") throw new Error(`unknown plan: ${input.planId}`);
  const s = derivePlanState(grp.proposal, grp.related);
  const chain: PlanTrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { planId: s.planId, title: s.title, phase: s.phase, chain };
}
