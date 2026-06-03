import { serializeEvent, type EventType, type GovEvent } from "../event/event.ts";
import { sha256hex } from "../event/id.ts";
import { projectTasks } from "../task/project.ts";
import { projectPlans } from "../plan/project.ts";
import { projectSessions } from "../session/project.ts";
import { projectSpecs } from "../spec/project.ts";
import { deriveDecisionState } from "../decision/decision.ts";
import { proposalsOf, eventsForDecision } from "../decision/readEvents.ts";
import type { EventRow, NodeRow, NodeType } from "./types.ts";

/** Which graph subject a given event type belongs to (null = no node subject in this cut). */
const SUBJECT_TYPE_OF: Partial<Record<EventType, NodeType>> = {
  task_created: "task", task_started: "task", task_blocked: "task", task_completed: "task", task_cancelled: "task",
  plan_proposed: "plan", plan_accepted: "plan", plan_revised: "plan", plan_completed: "plan", plan_archived: "plan", plan_superseded: "plan",
  spec_proposed: "spec", spec_accepted: "spec", spec_archived: "spec",
  decision_recorded: "decision", decision_proposed: "decision", decision_review_recorded: "decision",
  decision_approved: "decision", decision_rejected: "decision", decision_blocked: "decision", decision_chosen: "decision",
  session_open_requested: "session", session_opened: "session", session_spawned: "session", session_observed: "session",
  session_waiting: "session", session_blocked: "session", session_context_pressure_changed: "session",
  session_checkpoint_requested: "session", session_handoff_ready: "session", session_close_requested: "session",
  session_closed: "session", session_crashed: "session", session_recovered: "session",
};

/** Event types whose own id ESTABLISHES the subject (vs. lifecycle events that point via related_to[0]). */
const BIRTH_TYPES = new Set<EventType>([
  "task_created", "plan_proposed", "spec_proposed", "decision_proposed", "decision_recorded",
  "session_open_requested", "session_opened", "session_spawned",
]);

export interface Subject {
  type: NodeType | null;
  id: string | null;
  /** related_to entries that are real relations (subject anchor excluded for lifecycle events). */
  relations: string[];
}

/** Pure: which subject an event belongs to, and its non-anchor relations. */
export function subjectOf(e: GovEvent): Subject {
  const t = SUBJECT_TYPE_OF[e.frontmatter.type] ?? null;
  const rel = e.frontmatter.related_to ?? [];
  if (!t) return { type: null, id: null, relations: rel };
  if (BIRTH_TYPES.has(e.frontmatter.type)) return { type: t, id: e.frontmatter.id, relations: rel };
  return { type: t, id: rel[0] ?? null, relations: rel.slice(1) };
}

/** Best-effort UTC timestamp parsed from an id stamp YYYYMMDD_HHMMSS; null if absent. */
function occurredAt(id: string): string | null {
  const m = id.match(/(\d{8})_(\d{6})/);
  if (!m) return null;
  const [, d, t] = m;
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}

/** L0 1:1 rows. content_hash over the serialized markdown; authority = first related decision id. */
export function toEventRows(events: GovEvent[]): EventRow[] {
  const decisionIds = new Set(
    events.filter((e) => SUBJECT_TYPE_OF[e.frontmatter.type] === "decision").map((e) => subjectOf(e).id),
  );
  return events.map((e) => {
    const fm = e.frontmatter;
    const subj = subjectOf(e);
    const authority = (fm.related_to ?? []).find((r) => decisionIds.has(r)) ?? null;
    return {
      event_id: fm.id,
      content_hash: sha256hex(serializeEvent(e)),
      event_type: fm.type,
      occurred_at: occurredAt(fm.id),
      actor: fm.actor,
      source: fm.source,
      subject_type: subj.type,
      subject_id: subj.id,
      authority_decision_id: authority,
      payload_jsonb: {
        tags: fm.tags,
        related_to: fm.related_to ?? [],
        supersededBy: fm.supersededBy ?? null,
        confidence: fm.confidence ?? null,
        body: e.body,
      },
    };
  });
}

function node(type: NodeType, canonicalId: string, title: string, state: Record<string, unknown>): NodeRow {
  return { node_id: `${type}:${canonicalId}`, node_type: type, canonical_id: canonicalId, title, state_jsonb: state };
}

/** Reuse the existing per-axis folds (god-fold ban, master §8). One node per live subject. */
export function toNodeRows(events: GovEvent[]): NodeRow[] {
  const rows: NodeRow[] = [];
  for (const s of projectTasks(events)) rows.push(node("task", s.taskId, s.title, { phase: s.phase, verdict: s.verdict }));
  for (const s of projectPlans(events)) rows.push(node("plan", s.planId, s.title, { phase: s.phase }));
  for (const s of projectSessions(events)) rows.push(node("session", s.sessionId, s.sessionId, { phase: s.phase, ownership: s.ownership, taskId: s.taskId }));
  for (const s of projectSpecs(events)) rows.push(node("spec", s.specId, s.title, { phase: s.phase }));
  for (const p of proposalsOf(events)) {
    const s = deriveDecisionState(p, eventsForDecision(events, p.frontmatter.id).related, 1);
    rows.push(node("decision", s.decisionId, s.title, { phase: s.phase, verdict: s.verdict }));
  }
  return rows;
}
