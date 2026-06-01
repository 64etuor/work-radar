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
  | "task_created";

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
