import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import {
  deriveSessionState,
  sessionsOf,
  ORIGIN_TYPES,
  type SessionState,
  type Ownership,
} from "./session.ts";
import {
  canWait,
  canBlock,
  canPressure,
  canCheckpoint,
  canHandoffReady,
  canRequestClose,
  canClose,
} from "./guards.ts";

export interface SessionGateResult {
  ok: boolean;
  reason: string;
  eventId?: string;
}

const isOriginType = (t: EventType): boolean => (ORIGIN_TYPES as readonly string[]).includes(t);

async function loadSession(
  workspaceDir: string,
  sessionId: string,
): Promise<{ state: SessionState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, sessionId);
  if (!grp.proposal || !isOriginType(grp.proposal.frontmatter.type))
    throw new Error(`unknown session: ${sessionId}`);
  return { state: deriveSessionState(grp.proposal, grp.related), all };
}

/** Write one verdict-free lifecycle event bound to a session. source/actor = "system" (registry
 *  record, NOT a verdict — the actor:"user" verdict hardpin lives only in decision handlers). */
async function writeLifecycle(
  workspaceDir: string,
  type: EventType,
  sessionId: string,
  body: string,
  now: Date,
  rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type,
      source: "system",
      actor: "system",
      tags: ["session"],
      related_to: [sessionId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

export interface RequestSessionOpenInput {
  ownership?: Ownership;
  surface?: string;
}

/** request_session_open — births a PLANNED session (session_open_requested). The event id is the
 *  new session id. Carries optional ownership/surface in a canonical-JSON body. */
export async function requestSessionOpen(
  workspaceDir: string,
  input: RequestSessionOpenInput,
  now: Date,
  rand: number,
): Promise<{ sessionId: string }> {
  const body: Record<string, string> = {};
  if (input.ownership) body.ownership = input.ownership;
  if (input.surface) body.surface = input.surface;
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "session_open_requested",
      source: "system",
      actor: "system",
      tags: ["session"],
    },
    body: JSON.stringify(body),
  };
  await writeEvent(workspaceDir, evt, now);
  return { sessionId: evt.frontmatter.id };
}

export async function markWaiting(
  workspaceDir: string,
  input: { sessionId: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canWait(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_waiting",
    input.sessionId,
    `Waiting ${input.sessionId}`,
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

export async function markBlocked(
  workspaceDir: string,
  input: { sessionId: string; reason: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canBlock(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_blocked",
    input.sessionId,
    `Blocked ${input.sessionId}: ${input.reason}`,
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

export async function recordPressure(
  workspaceDir: string,
  input: { sessionId: string; level: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canPressure(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_context_pressure_changed",
    input.sessionId,
    JSON.stringify({ level: input.level }),
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

export async function requestCheckpoint(
  workspaceDir: string,
  input: { sessionId: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canCheckpoint(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_checkpoint_requested",
    input.sessionId,
    `Checkpoint requested ${input.sessionId}`,
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

export async function markHandoffReady(
  workspaceDir: string,
  input: { sessionId: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canHandoffReady(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_handoff_ready",
    input.sessionId,
    `Handoff ready ${input.sessionId}`,
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

export async function requestSessionClose(
  workspaceDir: string,
  input: { sessionId: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canRequestClose(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_close_requested",
    input.sessionId,
    `Close requested ${input.sessionId}`,
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

/** close_session — the ONLY path that writes session_closed, and ONLY after a close request
 *  (canClose requires phase===closing). The observer has no such path (no-auto-close, §8). */
export async function closeSession(
  workspaceDir: string,
  input: { sessionId: string },
  now: Date,
  rand: number,
): Promise<SessionGateResult> {
  const { state } = await loadSession(workspaceDir, input.sessionId);
  const gate = canClose(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(
    workspaceDir,
    "session_closed",
    input.sessionId,
    `Closed ${input.sessionId}`,
    now,
    rand,
  );
  return { ok: true, reason: gate.reason, eventId };
}

export interface SessionSummary {
  sessionId: string;
  surface: string | null;
  ownership: Ownership;
  phase: SessionState["phase"];
}

/** sessions — non-terminal sessions. */
export async function listSessions(workspaceDir: string): Promise<SessionSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: SessionSummary[] = [];
  for (const birth of sessionsOf(all)) {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    const s = deriveSessionState(grp.proposal!, grp.related);
    if (s.phase !== "closed")
      out.push({
        sessionId: s.sessionId,
        surface: s.surface,
        ownership: s.ownership,
        phase: s.phase,
      });
  }
  return out;
}

export interface SessionTrailEntry {
  id: string;
  type: GovEvent["frontmatter"]["type"];
  actor: string;
  summary: string;
}
export interface SessionTrail {
  sessionId: string;
  surface: string | null;
  ownership: Ownership;
  phase: SessionState["phase"];
  chain: SessionTrailEntry[];
}

/** session <id> — full chronological trail. */
export async function sessionTrail(
  workspaceDir: string,
  input: { sessionId: string },
): Promise<SessionTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.sessionId);
  if (!grp.proposal || !isOriginType(grp.proposal.frontmatter.type))
    throw new Error(`unknown session: ${input.sessionId}`);
  const s = deriveSessionState(grp.proposal, grp.related);
  const chain: SessionTrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id,
    type: e.frontmatter.type,
    actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return {
    sessionId: s.sessionId,
    surface: s.surface,
    ownership: s.ownership,
    phase: s.phase,
    chain,
  };
}
