import matter from "gray-matter";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256hex } from "../event/id.ts";
import type { GovEvent } from "../event/event.ts";
import { parseScope } from "../patterns/scope.ts";
import { parseHypothesisMarkdown } from "./hypothesis.ts";
import type { HypothesisRecord } from "./types.ts";
import type { WriteOutcome } from "./write.ts";

export interface SupportedPattern {
  id: string;
  kind: "commit_scope_hotspot";
  scope: string;
  evidenceCount: number;
}

export interface HypothesisTesterSummary {
  proposed: number;
  verified: number;
  refuted: number;
  skipped: number;
}

export interface HypothesisTesterDeps {
  readEvents: () => Promise<readonly GovEvent[]>;
  readPatterns: () => Promise<readonly SupportedPattern[]>;
  readTestingHypotheses: () => Promise<readonly HypothesisRecord[]>;
  writeHypothesis: (record: HypothesisRecord) => Promise<WriteOutcome>;
  now: () => Date;
}

export interface HypothesisView {
  id: string;
  from_pattern: string;
  kind: string;
  scope: string;
  status: string;
  test_method: string;
  baseline: number;
  threshold: number;
  expires: string;
}

const PATTERN_SUBDIRS = ["candidates", "active"] as const;
const HYPOTHESIS_SUBDIRS = ["testing", "archived"] as const;
const SAFE_ID = /^[A-Za-z0-9_]+$/;

export function hypothesisId(patternId: string): string {
  return `hyp_${sha256hex(patternId).slice(0, 8)}`;
}

export function hypothesisFromPattern(
  pattern: SupportedPattern,
  opts: { expires: string },
): HypothesisRecord {
  return {
    id: hypothesisId(pattern.id),
    fromPattern: pattern.id,
    kind: "commit_scope_hotspot_persists",
    scope: pattern.scope,
    status: "testing",
    testMethod: "current_l0_scope_count",
    baseline: pattern.evidenceCount,
    threshold: pattern.evidenceCount,
    expires: opts.expires,
    body: `Commit scope \`${pattern.scope}\` should recur at least ${pattern.evidenceCount} times in the current L0 corpus.\n`,
  };
}

export function evaluateHypothesis(
  hypothesis: HypothesisRecord,
  events: readonly GovEvent[],
): HypothesisRecord {
  if (hypothesis.kind !== "commit_scope_hotspot_persists") return hypothesis;

  let count = 0;
  for (const event of events) {
    if (event.frontmatter.type !== "commit_recorded") continue;
    const scope = parseScope(event.body);
    if (scope !== null && scope.toLowerCase() === hypothesis.scope.toLowerCase()) count++;
  }

  return {
    ...hypothesis,
    status: count >= hypothesis.threshold ? "verified" : "refuted",
    body:
      hypothesis.body.trimEnd() +
      `\n\nResult: observed ${count} current L0 commit events for scope \`${hypothesis.scope}\` against threshold ${hypothesis.threshold}.\n`,
  };
}

export async function runHypothesisTester(deps: HypothesisTesterDeps): Promise<HypothesisTesterSummary> {
  const events = await safeRead(deps.readEvents, []);
  const patterns = await safeRead(deps.readPatterns, []);
  const existing = await safeRead(deps.readTestingHypotheses, []);
  const existingIds = new Set(existing.map((hypothesis) => hypothesis.id));
  const expires = addDays(deps.now(), 30);

  const summary: HypothesisTesterSummary = { proposed: 0, verified: 0, refuted: 0, skipped: 0 };

  for (const pattern of patterns) {
    const hypothesis = hypothesisFromPattern(pattern, { expires });
    if (existingIds.has(hypothesis.id)) {
      summary.skipped++;
      continue;
    }
    try {
      const outcome = await deps.writeHypothesis(hypothesis);
      if (outcome === "written") summary.proposed++;
      else summary.skipped++;
    } catch {
      summary.skipped++;
    }
  }

  for (const hypothesis of existing) {
    const evaluated = evaluateHypothesis(hypothesis, events);
    if (evaluated.status === hypothesis.status) {
      summary.skipped++;
      continue;
    }
    try {
      const outcome = await deps.writeHypothesis(evaluated);
      if (outcome === "skipped") {
        summary.skipped++;
      } else if (evaluated.status === "verified") {
        summary.verified++;
      } else if (evaluated.status === "refuted") {
        summary.refuted++;
      }
    } catch {
      summary.skipped++;
    }
  }

  return summary;
}

export async function readSupportedPatterns(workspaceDir: string): Promise<SupportedPattern[]> {
  const patterns: SupportedPattern[] = [];
  for (const subdir of PATTERN_SUBDIRS) {
    const dir = join(workspaceDir, "patterns", subdir);
    for (const file of await markdownFiles(dir)) {
      try {
        const { data } = matter(await readFile(join(dir, file), "utf8"));
        if (data.kind !== "commit_scope_hotspot") continue;
        const id = String(data.id ?? file.replace(/\.md$/, ""));
        if (!SAFE_ID.test(id)) continue;
        patterns.push({
          id,
          kind: "commit_scope_hotspot",
          scope: String(data.scope ?? "").trim().toLowerCase(),
          evidenceCount: Number(data.evidence_count ?? 0),
        });
      } catch {
        // malformed pattern -> skip
      }
    }
  }
  return patterns
    .filter((pattern) => pattern.scope.length > 0 && Number.isFinite(pattern.evidenceCount))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function readTestingHypotheses(workspaceDir: string): Promise<HypothesisRecord[]> {
  const dir = join(workspaceDir, "hypotheses", "testing");
  const hypotheses: HypothesisRecord[] = [];
  for (const file of await markdownFiles(dir)) {
    try {
      hypotheses.push(parseHypothesisMarkdown(await readFile(join(dir, file), "utf8")));
    } catch {
      // malformed hypothesis -> skip
    }
  }
  return hypotheses.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listHypotheses(workspaceDir: string): Promise<HypothesisView[]> {
  const out: HypothesisView[] = [];
  for (const subdir of HYPOTHESIS_SUBDIRS) {
    const dir = join(workspaceDir, "hypotheses", subdir);
    for (const file of await markdownFiles(dir)) {
      try {
        const parsed = parseHypothesisMarkdown(await readFile(join(dir, file), "utf8"));
        out.push({
          id: parsed.id,
          from_pattern: parsed.fromPattern,
          kind: parsed.kind,
          scope: parsed.scope,
          status: parsed.status,
          test_method: parsed.testMethod,
          baseline: parsed.baseline,
          threshold: parsed.threshold,
          expires: parsed.expires,
        });
      } catch {
        // malformed hypothesis -> skip
      }
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

async function safeRead<T>(read: () => Promise<readonly T[]>, fallback: readonly T[]): Promise<readonly T[]> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

function addDays(date: Date, days: number): string {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
