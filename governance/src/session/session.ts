import type { GovEvent } from "../event/event.ts";

export type SessionPhase =
  | "planned"
  | "opening"
  | "active"
  | "waiting"
  | "blocked"
  | "context_pressure_high"
  | "checkpoint_requested"
  | "handoff_ready"
  | "closing"
  | "closed"
  | "crashed"
  | "recovering";

export type Ownership = "user_owned" | "orchestrator_owned" | "external_owned";

export interface SessionState {
  sessionId: string;
  surface: string | null;
  ownership: Ownership;
  taskId: string | null; // the bound task (Phase C spawn related_to[0]), or null
  phase: SessionPhase;
  verdict: "closed" | null; // terminal marker (mirrors TaskState.verdict)
}

/** The three event types that can ORIGINATE a session (establish sessionId = own event id). */
export const ORIGIN_TYPES = [
  "session_open_requested",
  "session_opened",
  "session_spawned",
] as const;
type OriginType = (typeof ORIGIN_TYPES)[number];
const ORIGIN_TYPE_SET: ReadonlySet<string> = new Set(ORIGIN_TYPES);

export function isSessionOriginType(t: GovEvent["frontmatter"]["type"]): t is OriginType {
  return ORIGIN_TYPE_SET.has(t);
}

/** Parse a string field out of a session event's canonical-JSON body; null if absent/non-JSON. */
function bodyField(body: string, key: "surface" | "ownership" | "level"): string | null {
  try {
    const v = (JSON.parse(body) as Record<string, unknown>)[key];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

function birthOwnership(birth: GovEvent): Ownership {
  if (birth.frontmatter.type === "session_spawned") return "orchestrator_owned";
  const o = bodyField(birth.body, "ownership");
  return o === "orchestrator_owned" || o === "external_owned" || o === "user_owned"
    ? o
    : "user_owned";
}

/** Active-substate transitions, mapped to their resulting phase. The LATEST by id wins (§4.3). */
const SUBSTATE: Record<string, SessionPhase> = {
  session_observed: "active",
  session_waiting: "waiting",
  session_blocked: "blocked",
  session_checkpoint_requested: "checkpoint_requested",
  session_handoff_ready: "handoff_ready",
  session_close_requested: "closing",
  // session_context_pressure_changed is handled specially (only high|critical advances).
};

function substatePhaseOf(e: GovEvent): SessionPhase | null {
  const t = e.frontmatter.type;
  if (t === "session_context_pressure_changed") {
    const lvl = bodyField(e.body, "level");
    return lvl === "high" || lvl === "critical" ? "context_pressure_high" : null;
  }
  return SUBSTATE[t] ?? null;
}

/** Pure fold: a birth event + its related lifecycle events → SessionState.
 *  `related` = events whose related_to includes the session id (any order).
 *  Precedence (clone of deriveTaskState): terminal `closed` wins; else the latest crash/recover
 *  by id; else the latest active-substate transition by id; else the birth phase.
 *  ORDERING CONTRACT (Boule): event ids are display/tiebreak-only; same-second transitions on one
 *  session stream do not occur in practice (machine-paced observe + human-paced records), so the
 *  id tiebreak is a benign display nicety, not load-bearing. Fail-closed on foreign types. */
export function deriveSessionState(birth: GovEvent, related: GovEvent[]): SessionState {
  const sessionId = birth.frontmatter.id;
  const ownership = birthOwnership(birth);
  const surface = bodyField(birth.body, "surface");
  const taskId = (birth.frontmatter.related_to ?? [])[0] ?? null;
  const birthPhase: SessionPhase =
    birth.frontmatter.type === "session_open_requested" ? "planned" : "opening";

  const closed = related.some((e) => e.frontmatter.type === "session_closed");
  if (closed) return { sessionId, surface, ownership, taskId, phase: "closed", verdict: "closed" };

  // crash/recover override the active substate (a dead/returning surface is more significant).
  let latestLife: GovEvent | null = null;
  for (const e of related) {
    if (e.frontmatter.type !== "session_crashed" && e.frontmatter.type !== "session_recovered")
      continue;
    if (!latestLife || e.frontmatter.id.localeCompare(latestLife.frontmatter.id) > 0)
      latestLife = e;
  }
  if (latestLife) {
    const phase: SessionPhase =
      latestLife.frontmatter.type === "session_crashed" ? "crashed" : "recovering";
    return { sessionId, surface, ownership, taskId, phase, verdict: null };
  }

  // latest advancing active-substate transition by id.
  let latestSub: GovEvent | null = null;
  let latestSubPhase: SessionPhase | null = null;
  for (const e of related) {
    const p = substatePhaseOf(e);
    if (p === null) continue;
    if (!latestSub || e.frontmatter.id.localeCompare(latestSub.frontmatter.id) > 0) {
      latestSub = e;
      latestSubPhase = p;
    }
  }
  return {
    sessionId,
    surface,
    ownership,
    taskId,
    phase: latestSubPhase ?? birthPhase,
    verdict: null,
  };
}

/** All session birth events (chronological by id). A session_opened/session_open_requested that
 *  references an existing origin id is a TRANSITION (e.g. planned→opening), not a birth — so it is
 *  excluded to avoid double-counting (design §3). */
export function sessionsOf(all: GovEvent[]): GovEvent[] {
  const originIds = new Set<string>();
  const origins: GovEvent[] = [];
  for (const event of all) {
    if (!isSessionOriginType(event.frontmatter.type)) continue;
    origins.push(event);
    originIds.add(event.frontmatter.id);
  }
  return origins
    .filter((e) => !(e.frontmatter.related_to ?? []).some((r) => originIds.has(r)))
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
