import matter from "gray-matter";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readAllEvents } from "../decision/readEvents.ts";
import type { GovEvent } from "../event/event.ts";

export interface ArchivePolicy {
  today: string;
  staleEventAgeDays: number;
  maxEventsPerType: number;
  stalePatternAgeDays: number;
  maxCandidatePatternsPerKindScope: number;
}

export interface RetentionRow {
  id: string;
  classification: "retain" | "stale";
  reasons: string[];
}

export interface PatternRetentionInput {
  id: string;
  kind: string;
  scope: string;
  status: string;
  createdAt: string | null;
  evidenceCount: number;
}

export interface ArchivePolicyStatus {
  policy: ArchivePolicy;
  summary: {
    staleEvents: number;
    retainedEvents: number;
    stalePatterns: number;
    retainedPatterns: number;
  };
  events: RetentionRow[];
  patterns: RetentionRow[];
}

const PATTERN_SUBDIRS = ["active", "archived", "candidates"] as const;

export function defaultArchivePolicy(today = isoDate(new Date())): ArchivePolicy {
  return {
    today,
    staleEventAgeDays: 90,
    maxEventsPerType: 200,
    stalePatternAgeDays: 45,
    maxCandidatePatternsPerKindScope: 20,
  };
}

export function classifyEventRetention(events: GovEvent[], policy: ArchivePolicy): RetentionRow[] {
  const sorted = [...events].sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
  const staleByAge = sorted.filter((event) => {
    const age = ageDays(eventDate(event.frontmatter.id), policy.today);
    return age !== null && age > policy.staleEventAgeDays;
  });
  const keepIds = keepNewestBy(staleByAge, (event) => event.frontmatter.type, policy.maxEventsPerType).map(
    (event) => event.frontmatter.id,
  );
  const keep = new Set(keepIds);
  return sorted.map((event) => {
    const age = ageDays(eventDate(event.frontmatter.id), policy.today);
    if (age === null) {
      return { id: event.frontmatter.id, classification: "retain", reasons: ["unknown_age"] };
    }
    if (age <= policy.staleEventAgeDays) {
      return { id: event.frontmatter.id, classification: "retain", reasons: [`recent:${age}d`] };
    }
    if (keep.has(event.frontmatter.id)) {
      return { id: event.frontmatter.id, classification: "retain", reasons: [`age:${age}d`, "count_floor"] };
    }
    return {
      id: event.frontmatter.id,
      classification: "stale",
      reasons: [`age:${age}d`, `count_overflow:${event.frontmatter.type}`],
    };
  });
}

export function classifyPatternRetention(patterns: PatternRetentionInput[], policy: ArchivePolicy): RetentionRow[] {
  const sorted = [...patterns].sort((a, b) => a.id.localeCompare(b.id));
  const candidates = sorted.filter((pattern) => pattern.status === "candidate");
  const keepCandidateIds = keepNewestBy(
    candidates,
    (pattern) => `${pattern.kind}:${pattern.scope}`,
    policy.maxCandidatePatternsPerKindScope,
  ).map((pattern) => pattern.id);
  const keepCandidates = new Set(keepCandidateIds);

  return sorted.map((pattern) => {
    if (pattern.status !== "candidate") {
      return { id: pattern.id, classification: "retain", reasons: [`curated:${pattern.status}`] };
    }
    const age = ageDays(pattern.createdAt, policy.today);
    if (age === null) {
      return { id: pattern.id, classification: "retain", reasons: ["unknown_age"] };
    }
    if (age <= policy.stalePatternAgeDays) {
      return { id: pattern.id, classification: "retain", reasons: [`recent:${age}d`] };
    }
    if (keepCandidates.has(pattern.id)) {
      return { id: pattern.id, classification: "retain", reasons: [`age:${age}d`, "count_floor"] };
    }
    return {
      id: pattern.id,
      classification: "stale",
      reasons: [`age:${age}d`, `count_overflow:${pattern.kind}:${pattern.scope}`],
    };
  });
}

export async function readArchivePolicyStatus(
  workspaceDir: string,
  policy = defaultArchivePolicy(),
): Promise<ArchivePolicyStatus> {
  const events = classifyEventRetention(await readAllEvents(workspaceDir), policy);
  const patterns = classifyPatternRetention(await readPatterns(workspaceDir), policy);
  return {
    policy,
    summary: {
      staleEvents: events.filter((row) => row.classification === "stale").length,
      retainedEvents: events.filter((row) => row.classification === "retain").length,
      stalePatterns: patterns.filter((row) => row.classification === "stale").length,
      retainedPatterns: patterns.filter((row) => row.classification === "retain").length,
    },
    events,
    patterns,
  };
}

async function readPatterns(workspaceDir: string): Promise<PatternRetentionInput[]> {
  const out: PatternRetentionInput[] = [];
  for (const subdir of PATTERN_SUBDIRS) {
    const dir = join(workspaceDir, "patterns", subdir);
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const { data } = matter(await readFile(join(dir, file), "utf8"));
        const id = String(data.id ?? file.replace(/\.md$/, ""));
        const status = String(data.status ?? (subdir === "candidates" ? "candidate" : subdir));
        out.push({
          id,
          kind: String(data.kind ?? ""),
          scope: String(data.scope ?? "").trim().toLowerCase(),
          status,
          createdAt: typeof data.created_at === "string" ? data.created_at : null,
          evidenceCount: Number(data.evidence_count ?? 0),
        });
      } catch {
        // malformed pattern files are ignored by read-only policy status.
      }
    }
  }
  return out;
}

function keepNewestBy<T>(rows: T[], key: (row: T) => string, count: number): T[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return [...groups.values()].flatMap((group) => group.slice(-Math.max(0, count)));
}

function eventDate(id: string): string | null {
  const m = /^evt_(\d{4})(\d{2})(\d{2})_/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function ageDays(date: string | null, today: string): number | null {
  if (!date) return null;
  const then = Date.parse(`${date}T00:00:00.000Z`);
  const now = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
