import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveHandoffState, handoffsOf, type HandoffState } from "./handoff.ts";
import { validateHandoff } from "./validate.ts";
import { canDraft, canValidate, canConsume } from "./guards.ts";

export interface HandoffGateResult { ok: boolean; reason: string; eventId?: string; }

async function loadHandoff(
  workspaceDir: string, handoffId: string,
): Promise<{ state: HandoffState; all: GovEvent[]; related: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, handoffId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "handoff_requested")
    throw new Error(`unknown handoff: ${handoffId}`);
  return { state: deriveHandoffState(grp.proposal, grp.related), all, related: grp.related };
}

/** Write one verdict-free handoff lifecycle event. source/actor = "system" (registry record). */
async function writeLifecycle(
  workspaceDir: string, type: EventType, handoffId: string, body: string, now: Date, rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type, source: "system", actor: "system",
      tags: ["handoff"], related_to: [handoffId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

/** request_handoff — births a handoff (handoff_requested). The event id is the new handoff id;
 *  related_to[0] = the session being handed off from. */
export async function requestHandoff(
  workspaceDir: string, input: { sessionId: string }, now: Date, rand: number,
): Promise<{ handoffId: string }> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "handoff_requested", source: "system", actor: "system",
      tags: ["handoff"], related_to: [input.sessionId],
    },
    body: `Handoff requested for ${input.sessionId}`,
  };
  await writeEvent(workspaceDir, evt, now);
  return { handoffId: evt.frontmatter.id };
}

/** draft_handoff — submit a draft markdown body (→ validating). The body IS the handoff content. */
export async function draftHandoff(
  workspaceDir: string, input: { handoffId: string; body: string }, now: Date, rand: number,
): Promise<HandoffGateResult> {
  const { state } = await loadHandoff(workspaceDir, input.handoffId);
  const gate = canDraft(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "handoff_drafted", input.handoffId, input.body, now, rand);
  return { ok: true, reason: "", eventId };
}

export interface ValidateResult extends HandoffGateResult { valid?: boolean; missing?: string[]; }

/** validate_handoff — run the pure structural check on the LATEST draft and emit
 *  handoff_validated (→pending) or handoff_invalid (→invalid, carries missing[]). ok=false means
 *  the command itself could not run (wrong phase / no draft); valid is the structural verdict. */
export async function runValidateHandoff(
  workspaceDir: string, input: { handoffId: string }, now: Date, rand: number,
): Promise<ValidateResult> {
  const { state, related } = await loadHandoff(workspaceDir, input.handoffId);
  const gate = canValidate(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const drafts = related
    .filter((e) => e.frontmatter.type === "handoff_drafted")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  const latest = drafts[drafts.length - 1];
  const result = validateHandoff(latest?.body ?? "");
  if (result.ok) {
    const eventId = await writeLifecycle(workspaceDir, "handoff_validated", input.handoffId, `Validated ${input.handoffId}`, now, rand);
    return { ok: true, reason: "", valid: true, eventId };
  }
  const eventId = await writeLifecycle(
    workspaceDir, "handoff_invalid", input.handoffId, JSON.stringify({ missing: result.missing }), now, rand,
  );
  return { ok: true, reason: "", valid: false, missing: result.missing, eventId };
}

/** consume — mark a pending handoff consumed (handoff_consumed, terminal). The hydration IO shell
 *  (hydrateIo.ts) calls this after assembling the bundle; exposed directly for the no-bundle path. */
export async function consumeHandoff(
  workspaceDir: string, input: { handoffId: string }, now: Date, rand: number,
): Promise<HandoffGateResult> {
  const { state } = await loadHandoff(workspaceDir, input.handoffId);
  const gate = canConsume(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "handoff_consumed", input.handoffId, `Consumed ${input.handoffId}`, now, rand);
  return { ok: true, reason: "", eventId };
}

export interface HandoffSummary { handoffId: string; sessionId: string | null; phase: HandoffState["phase"]; }

/** handoff_status — non-consumed handoffs. */
export async function listHandoffs(workspaceDir: string): Promise<HandoffSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: HandoffSummary[] = [];
  for (const birth of handoffsOf(all)) {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    const s = deriveHandoffState(grp.proposal!, grp.related);
    if (s.phase !== "consumed") out.push({ handoffId: s.handoffId, sessionId: s.sessionId, phase: s.phase });
  }
  return out;
}

export interface HandoffTrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface HandoffTrail { handoffId: string; sessionId: string | null; phase: HandoffState["phase"]; chain: HandoffTrailEntry[]; }

/** handoff <id> — full chronological trail. */
export async function handoffTrail(workspaceDir: string, input: { handoffId: string }): Promise<HandoffTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.handoffId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "handoff_requested")
    throw new Error(`unknown handoff: ${input.handoffId}`);
  const s = deriveHandoffState(grp.proposal, grp.related);
  const chain: HandoffTrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { handoffId: s.handoffId, sessionId: s.sessionId, phase: s.phase, chain };
}
