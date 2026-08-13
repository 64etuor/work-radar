import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { derivePlanState, plansOf, type PlanState } from "./plan.ts";
import { canAccept, canRevise, canComplete, canArchive, canSupersede } from "./guards.ts";
import type { Difficulty } from "../backends/difficulty.ts";
import { machineUncertifiableSteps } from "../conductor/conductor.ts";

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

export interface PlanStepInput {
  text: string;
  difficulty?: Difficulty;
  /** kind:"human" = explicit "a human certifies this step" (see conductor.ts PlanStepCheck). */
  check?: { artifact?: string; kind?: "human" };
}
export interface ProposePlanInput { intent: string; steps: Array<string | PlanStepInput>; specId?: string; }
export interface ProposePlanResult { planId: string; }

function normalizeStep(input: string | PlanStepInput): PlanStepInput | null {
  if (typeof input === "string") {
    const text = input.trim();
    return text ? { text } : null;
  }
  const text = input.text?.trim();
  if (!text) return null;
  const artifact = input.check?.artifact?.trim();
  const kind = input.check?.kind === "human" ? ("human" as const) : undefined;
  const check = {
    ...(artifact ? { artifact } : {}),
    ...(kind ? { kind } : {}),
  };
  return {
    text,
    ...(input.difficulty ? { difficulty: input.difficulty } : {}),
    ...(Object.keys(check).length ? { check } : {}),
  };
}

function serializeStep(step: PlanStepInput, index: number): string {
  const difficulty = step.difficulty ? ` <!-- boule:difficulty ${step.difficulty} -->` : "";
  const check = step.check ? ` <!-- boule:check ${JSON.stringify(step.check)} -->` : "";
  return `${index + 1}. ${step.text}${difficulty}${check}`;
}

/** Planner — consumes a "load feature X" intent, emits EXACTLY ONE plan_proposed (draft).
 *  actor:"planner" (NOT a human, NOT a verdict). This is the ONLY write path here; there is no
 *  acceptance path, so the Planner cannot accept its own plan (structural INVARIANT #1). */
export async function proposePlan(
  workspaceDir: string, input: ProposePlanInput, now: Date, rand: number,
): Promise<ProposePlanResult> {
  const intent = input.intent?.trim();
  if (!intent) throw new Error("plan intent must be non-empty");
  const steps = (input.steps ?? []).map(normalizeStep).filter((s): s is PlanStepInput => s !== null);
  if (steps.length === 0) throw new Error("plan must have at least one step");
  const body = `${intent}\n\n${steps.map(serializeStep).join("\n")}`;
  const specId = input.specId?.trim();
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "plan_proposed", source: "hermes", actor: "planner",
      tags: ["plan"],
      ...(specId ? { related_to: [specId] } : {}),
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return { planId: evt.frontmatter.id };
}

/** The human-accept warning for steps no machine can certify (P2a): names the SILENTLY checkless
 *  step indices — an explicit check:{kind:"human"} step is excluded (the author already declared
 *  the human requirement). null = nothing to warn about (or the plan is unknown — the accept
 *  handler surfaces its own refusal). */
export async function checklessStepWarning(workspaceDir: string, planId: string): Promise<string | null> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, planId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "plan_proposed") return null;
  const silent = machineUncertifiableSteps(grp.proposal.body).filter((s) => !s.explicitHuman);
  if (silent.length === 0) return null;
  const indices = silent.map((s) => s.stepIndex).join(", ");
  return (
    `WARNING: step(s) ${indices} have no check.artifact contract — ` +
    `completion will require human certification (the step parks at needs_human until an operator certifies)`
  );
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

/** supersede_plan — any non-terminal → superseded (terminal). REQUIRES the replacing plan id so
 *  the supersession lineage is reconstructable from events. The ref is recorded as `supersededBy`
 *  on the plan_superseded event's frontmatter (NOT in related_to: related_to stays [oldPlanId] so
 *  the event is scoped to the OLD plan; the new id in related_to would wrongly mark the new plan
 *  superseded). Existence of the replacing plan is NOT validated here (dangling ref tolerated;
 *  owner follow-up). */
export async function supersedePlan(
  workspaceDir: string, input: { planId: string; supersededBy: string }, now: Date, rand: number,
): Promise<PlanGateResult> {
  const supersededBy = input.supersededBy?.trim();
  if (!supersededBy) return { ok: false, reason: "supersededBy (replacing plan id) is required" };
  const { state } = await loadPlan(workspaceDir, input.planId);
  const gate = canSupersede(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const id = generateId("evt", now, rand);
  const evt: GovEvent = {
    frontmatter: {
      id, type: "plan_superseded", source: "hermes", actor: "user",
      tags: ["plan"], related_to: [input.planId], supersededBy,
    },
    body: `Superseded ${input.planId} by ${supersededBy}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { ok: true, reason: gate.reason, eventId: id };
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
export interface PlanTrail { planId: string; title: string; phase: PlanState["phase"]; specId: string | null; supersededBy: string | null; chain: PlanTrailEntry[]; }

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
  const supersededEvt = grp.related.find((e) => e.frontmatter.type === "plan_superseded");
  const supersededBy = supersededEvt?.frontmatter.supersededBy ?? null;
  const specId = (grp.proposal.frontmatter.related_to ?? [])[0] ?? null;
  return { planId: s.planId, title: s.title, phase: s.phase, specId, supersededBy, chain };
}
