import { serializeEvent, type EventType, type GovEvent } from "../event/event.ts";
import { sha256hex } from "../event/id.ts";
import { projectTasks } from "../task/project.ts";
import { projectPlans } from "../plan/project.ts";
import { projectSessions } from "../session/project.ts";
import { projectSpecs } from "../spec/project.ts";
import { deriveDecisionState } from "../decision/decision.ts";
import { proposalsOf, eventsForDecision } from "../decision/readEvents.ts";
import type { EdgeRow, EdgeType, EventRow, GraphProjection, NodeRow, NodeType } from "./types.ts";

/** Which graph subject a given event type belongs to (null = no node subject in this cut). */
const SUBJECT_TYPE_OF: Partial<Record<EventType, NodeType>> = {
  task_created: "task", task_started: "task", task_blocked: "task", task_completed: "task", task_cancelled: "task",
  executor_reported_done: "task",
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
  const decisionIds = new Set<string>();
  for (const e of events) {
    if (SUBJECT_TYPE_OF[e.frontmatter.type] !== "decision") continue;
    const id = subjectOf(e).id;
    if (id !== null) decisionIds.add(id);
  }
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
  for (const s of projectPlans(events)) rows.push(node("plan", s.planId, s.title, { phase: s.phase, verdict: s.verdict }));
  for (const s of projectSessions(events)) rows.push(node("session", s.sessionId, s.sessionId, { phase: s.phase, ownership: s.ownership, taskId: s.taskId }));
  for (const s of projectSpecs(events)) rows.push(node("spec", s.specId, s.title, { phase: s.phase }));
  for (const p of proposalsOf(events)) {
    const s = deriveDecisionState(p, eventsForDecision(events, p.frontmatter.id).related, 1);
    rows.push(node("decision", s.decisionId, s.title, { phase: s.phase, verdict: s.verdict }));
  }
  return rows;
}

/** Derive reference edges from event relations. Endpoints must resolve to emitted nodes
 *  (except refs, which retain a possibly-dangling raw target — never silently dropped). */
export function toEdgeRows(events: GovEvent[], nodes: NodeRow[]): EdgeRow[] {
  const byCanon = new Map<string, NodeRow>();
  for (const n of nodes) byCanon.set(n.canonical_id, n);
  const edges: EdgeRow[] = [];
  const push = (from: string, to: string, type: EdgeType, src: string) =>
    edges.push({ edge_id: sha256hex(`${from}|${type}|${to}|${src}`), from_node_id: from, to_node_id: to, edge_type: type, source_event_id: src });

  for (const e of events) {
    const fm = e.frontmatter;

    // step_bound binds two existing nodes but mints no subject node of its own (§3.2).
    if (fm.type === "step_bound") {
      let task: NodeRow | undefined;
      let plan: NodeRow | undefined;
      for (const ref of fm.related_to ?? []) {
        const target = byCanon.get(ref);
        if (!target) continue;
        if (target.node_type === "task") task = target;
        if (target.node_type === "plan") plan = target;
      }
      if (task && plan) push(task.node_id, plan.node_id, "step_of", fm.id);
      continue;
    }

    const subj = subjectOf(e);
    const fromNode = subj.type && subj.id ? byCanon.get(subj.id) : undefined;
    if (!fromNode) continue; // no resolvable subject → no edge endpoint in this cut
    const from = fromNode.node_id;

    if (fm.supersededBy) {
      const target = byCanon.get(fm.supersededBy);
      push(from, target ? target.node_id : fm.supersededBy, "supersedes", fm.id);
    }
    for (const r of subj.relations) {
      const target = byCanon.get(r);
      const type: EdgeType = fm.type === "decision_blocked" ? "blocks" : target ? "related_to" : "refs";
      push(from, target ? target.node_id : r, type, fm.id);
    }
  }
  return edges;
}

/** PURE: events → derived graph projection. Reuses per-axis folds; no I/O, emits no events.
 *  Output rows are PK-sorted so the projection (and its checksum) is order-independent. */
export function projectGraph(events: GovEvent[]): GraphProjection {
  const nodes = toNodeRows(events);
  return {
    events: toEventRows(events).sort((a, b) => a.event_id.localeCompare(b.event_id)),
    nodes: nodes.sort((a, b) => a.node_id.localeCompare(b.node_id)),
    edges: toEdgeRows(events, nodes).sort((a, b) => a.edge_id.localeCompare(b.edge_id)),
  };
}
