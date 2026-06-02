import { sha256hex } from "../event/id.ts";
import type { GovEvent } from "../event/event.ts";
import { KIND, type CandidatePattern } from "./types.ts";
import { parseScope } from "./scope.ts";

export interface DetectOptions {
  minEvidence: number; // emit only scopes with >= this many commits
  confFull: number; // count at which confidence saturates to 1.0
  evidenceCap: number; // body display cap (does not affect detection)
}

export interface DetectResult {
  patterns: CandidatePattern[];
  droppedNoScope: number; // commit events with no parseable scope
  scopesConsidered: number; // distinct normalized scopes seen (pre-threshold)
}

/** The curated-set membership key for a (kind, normalizedScope). Also the id hash input. */
export function curatedKeyString(kind: string, normalizedScope: string): string {
  return `${kind}:${normalizedScope}`;
}

/** Namespace-scoped content-addressed id: pat_scope_<sha8("<kind>:<normalizedScope>")>. */
export function patternId(normalizedScope: string): string {
  return `pat_scope_${sha256hex(curatedKeyString(KIND, normalizedScope)).slice(0, 8)}`;
}

/** Transparent confidence: count/confFull, clamped to 1, rounded to 2 decimals. */
export function confidence(count: number, confFull: number): number {
  return Math.min(1, Math.round((count / confFull) * 100) / 100);
}

/** Pure: L0 events → candidate commit-scope-hotspot patterns. Deterministic. */
export function detectPatterns(
  events: readonly GovEvent[],
  curated: ReadonlySet<string>,
  opts: DetectOptions,
): DetectResult {
  const groups = new Map<string, string[]>(); // normalizedScope → event ids
  let droppedNoScope = 0;
  for (const e of events) {
    if (e.frontmatter.type !== "commit_recorded") continue;
    const scope = parseScope(e.body);
    if (scope === null) {
      droppedNoScope++;
      continue;
    }
    const key = scope.toLowerCase(); // parseScope already trimmed
    const ids = groups.get(key) ?? [];
    ids.push(e.frontmatter.id);
    groups.set(key, ids);
  }

  const patterns: CandidatePattern[] = [];
  for (const [scope, ids] of groups) {
    if (ids.length < opts.minEvidence) continue;
    if (curated.has(curatedKeyString(KIND, scope))) continue;
    patterns.push({
      id: patternId(scope),
      kind: KIND,
      scope,
      evidenceCount: ids.length,
      confidence: confidence(ids.length, opts.confFull),
      evidenceEventIds: [...ids].sort(), // stable ordering
    });
  }
  patterns.sort((a, b) => a.scope.localeCompare(b.scope));
  return { patterns, droppedNoScope, scopesConsidered: groups.size };
}
