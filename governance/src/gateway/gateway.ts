import { generateId } from "../event/id.js";
import type { EventSource, EventType, GovEvent } from "../event/event.js";

export interface RawActivity {
  kind: "git_commit" | "pr_merged" | "adr_added" | "decisions_line" | "hermes_command";
  actor: string;
  summary: string;
  tags?: string[];
  refs?: string[];
}

const KIND_MAP: Record<RawActivity["kind"], { type: EventType; source: EventSource }> = {
  git_commit:     { type: "commit_recorded",  source: "git" },
  pr_merged:      { type: "pr_merged",         source: "github" },
  adr_added:      { type: "decision_proposed", source: "adr" },
  decisions_line: { type: "decision_recorded", source: "decisions_doc" },
  hermes_command: { type: "task_created",      source: "hermes" },
};

/** Pure: raw repo activity → normalized L0 event (not yet written). */
export function ingest(raw: RawActivity, now: Date, rand: number): GovEvent {
  const m = KIND_MAP[raw.kind];
  if (!m) throw new Error(`unknown activity kind: ${raw.kind}`);
  return {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: m.type,
      source: m.source,
      actor: raw.actor,
      tags: raw.tags ?? [],
      ...(raw.refs ? { related_to: raw.refs } : {}),
    },
    body: raw.summary,
  };
}

/** Type 1(비가역) 후보 = 새 결정 제안(ADR). P2 Guardian이 소비. */
export function isType1Candidate(evt: GovEvent): boolean {
  return evt.frontmatter.type === "decision_proposed";
}
