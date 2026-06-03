import matter from "gray-matter";

export type EventType =
  | "commit_recorded"
  | "pr_opened"
  | "pr_merged"
  | "ci_failed"
  | "agent_run_completed"
  | "decision_recorded"
  | "decision_proposed"
  | "decision_review_recorded" // P2a: External Reviewer wrote a review for a decision
  | "decision_approved"        // P2a: human gate passed (actor=user)
  | "decision_rejected"        // P2a: human gate rejected (actor=user)
  | "decision_blocked"         // v2 slice1: Type 0 escalation — a fork that needs a human (source=agent_run|hermes)
  | "decision_chosen"          // v2 slice1: human picked an option for a Type 0 (actor=user, NOT review-gated)
  | "task_created"
  | "task_started"      // v3 Phase A: task ready/blocked → active
  | "task_blocked"      // v3 Phase A: task active → blocked (carries reason)
  | "task_completed"    // v3 Phase A: task active → done (guarded: no open decision_blocked)
  | "task_cancelled"    // v3 Phase A: task → cancelled (terminal)
  | "plan_proposed"     // v3 Phase B: Planner emits one draft plan (actor=planner, propose-only)
  | "plan_accepted"     // v3 Phase B: human gate — draft/needs_revision → active (actor=user)
  | "plan_revised"      // v3 Phase B: active → needs_revision (revision requested, carries reason)
  | "plan_completed"    // v3 Phase B: plan → completed (terminal)
  | "plan_archived"     // v3 Phase B: plan → archived (terminal)
  | "plan_superseded"   // v3 Phase B: plan replaced by a newer plan (terminal)
  | "spec_proposed"     // v3 Phase B2: a spec is drafted (actor=author, propose-only)
  | "spec_accepted"     // v3 Phase B2: human gate — draft → accepted (actor=user)
  | "spec_archived"     // v3 Phase B2: spec → archived (terminal)
  | "step_bound"        // v3 Phase C: Conductor binds a plan step index ↔ a task (actor=conductor); NO verdict
  | "session_spawned"   // v3 Phase C: Conductor records one cmux session spawn for a task (actor=conductor); NO verdict
  // v3 Phase D: Session Registry + cmux Observer — ALL verdict-free (source: system|hermes|agent_run).
  // A session's id = its birth event id (session_open_requested|session_opened|session_spawned).
  | "session_open_requested"            // born planned (request to open; carries optional ownership/surface)
  | "session_opened"                    // born opening (orphan auto-register = external_owned; else user_owned)
  | "session_observed"                  // observer saw the surface alive → active
  | "session_waiting"                   // session is waiting (idle/blocked-on-human)
  | "session_blocked"                   // session is blocked (carries reason)
  | "session_context_pressure_changed"  // context pressure level changed (body .level low|medium|high|critical)
  | "session_checkpoint_requested"      // a checkpoint was requested (pre-handoff)
  | "session_handoff_ready"             // handoff artifact is ready
  | "session_close_requested"           // close requested → closing (gate for close_session)
  | "session_closed"                    // session closed (terminal) — ONLY via close_session, never the observer
  | "session_crashed"                   // observer saw a known surface disappear (NOT a close)
  | "session_recovered"                 // observer saw a crashed surface return → recovering
  // v3 Phase E: Orchestrator emits an advisory suggestion. suggestion-class — source/actor=system,
  // NO verdict. The ONLY new write permission in Phase E (master §4.1); dispatch events → Phase I.
  | "orchestrator_suggestion_created";

export type EventSource =
  | "git" | "github" | "agent_run" | "decisions_doc" | "adr" | "hermes" | "system"
  | "reviewer"; // P2a: External Reviewer agent

export interface EventFrontmatter {
  id: string;
  type: EventType;
  source: EventSource;
  actor: string;
  tags: string[];
  related_to?: string[];
  supersededBy?: string;   // v3: plan_superseded → the replacing plan id (supersession lineage ref)
  confidence?: number;
  expires?: string;
}

export interface GovEvent {
  frontmatter: EventFrontmatter;
  body: string;
}

const REQUIRED = ["id", "type", "source", "actor", "tags"] as const;

function assertRequired(data: Record<string, unknown>): void {
  for (const k of REQUIRED) {
    if (data[k] === undefined) {
      throw new Error(`event frontmatter missing required field: ${k}`);
    }
  }
}

export function serializeEvent(evt: GovEvent): string {
  assertRequired(evt.frontmatter as unknown as Record<string, unknown>);
  return matter.stringify(evt.body, evt.frontmatter);
}

export function parseEvent(raw: string): GovEvent {
  const { data, content } = matter(raw);
  assertRequired(data);
  return { frontmatter: data as EventFrontmatter, body: content.trim() };
}
