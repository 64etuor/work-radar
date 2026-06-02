import matter from "gray-matter";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidatePattern } from "./types.ts";

export type WriteOutcome = "written" | "skipped";

export interface WritePatternOptions {
  evidenceCap: number; // max evidence ids listed in the body
}

/** Deterministic markdown for a candidate pattern (frontmatter + capped evidence body). */
export function serializePattern(p: CandidatePattern, opts: WritePatternOptions): string {
  const shown = p.evidenceEventIds.slice(0, opts.evidenceCap);
  const body =
    `Commit scope \`${p.scope}\` recurred ${p.evidenceCount} times in the L0 corpus.\n\n` +
    `Evidence (first ${shown.length} of ${p.evidenceCount}):\n` +
    shown.map((id) => `- ${id}`).join("\n") +
    "\n";
  return matter.stringify(body, {
    id: p.id,
    kind: p.kind,
    scope: p.scope,
    evidence_count: p.evidenceCount,
    confidence: p.confidence,
    status: "candidate",
    generated_by: "pattern-detector",
  });
}

/** Idempotent writer. WRITE-PATH INVARIANT (spec §4): every path is joined under a fixed
 *  patterns/candidates/ base; this function never references active/ or archived/. */
export function makeWritePattern(
  workspaceDir: string,
  opts: WritePatternOptions,
): (p: CandidatePattern) => Promise<WriteOutcome> {
  const dir = join(workspaceDir, "patterns", "candidates");
  return async (p) => {
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${p.id}.md`); // id is pat_scope_<8hex> — no path separators
    const next = serializePattern(p, opts);
    try {
      if ((await readFile(file, "utf8")) === next) return "skipped";
    } catch {
      // missing → fall through to write
    }
    await writeFile(file, next, "utf8");
    return "written";
  };
}
