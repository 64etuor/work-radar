import type { EventType, EventSource } from "../event/event.ts";
import type { DecisionRow } from "../index/types.ts";
import type { RawCommit } from "./gitLog.ts";
import { deriveEventId, sha256hex } from "../event/id.ts";

export interface HarvestItem {
  id: string;
  type: EventType;
  source: EventSource;
  actor: string;
  body: string;
  tags: string[];
  refs?: string[];
  stampAt: Date; // historical date for path/time
  dayBucket?: string; // "undated" for dateless items; else derived from stampAt
  disambiguator: string; // short, collision-free filename suffix
}

const EPOCH = new Date(0);

export function commitItem(c: RawCommit): HarvestItem {
  return {
    id: deriveEventId("commit", c.sha),
    type: "commit_recorded",
    source: "git",
    actor: c.author || "unknown",
    body: c.subject,
    tags: [],
    stampAt: c.committedAt,
    disambiguator: c.sha.slice(0, 7),
  };
}

export function adrItem(row: DecisionRow): HarvestItem {
  const dated = row.date ? new Date(`${row.date}T00:00:00Z`) : null;
  const valid = dated && !Number.isNaN(dated.getTime()) ? dated : null;
  return {
    id: deriveEventId("adr", row.id),
    type: "decision_proposed",
    source: "adr",
    actor: "system",
    body: row.title,
    tags: row.tags,
    refs: row.refs.length ? row.refs : undefined,
    stampAt: valid ?? EPOCH,
    dayBucket: valid ? undefined : "undated",
    disambiguator: row.id,
  };
}

export function decisionItem(row: DecisionRow): HarvestItem {
  const key = row.title.trim().replace(/\s+/g, " ").toLowerCase(); // normalized bullet text
  return {
    id: deriveEventId("decision", key),
    type: "decision_recorded",
    source: "decisions_doc",
    actor: "system",
    body: row.title,
    tags: [],
    refs: row.refs.length ? row.refs : undefined,
    stampAt: EPOCH,
    dayBucket: "undated",
    disambiguator: sha256hex(key).slice(0, 7),
  };
}
