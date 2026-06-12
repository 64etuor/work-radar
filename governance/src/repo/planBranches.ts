import type { SpawnSyncLike } from "./spawn.ts";

// P4(a) — unmerged plan-branch surfacing (master plan 2026-06-12 §2-R5). Completed plan steps
// accumulate on local `boule/<planId>` branches (step worktree chaining, adapter.planBranchName);
// merge-back is HUMAN-ONLY by design, but nothing surfaced the finished work — it silently
// stranded. This module LISTS those branches (read-only git plumbing, injected spawn seam) so the
// tick report / `boule snapshot` / Control Room can show "merge 대기 N". It never merges, never
// pushes, never writes events — fail-soft observability, not a gate.

export interface UnmergedPlanBranch {
  /** Short branch name, e.g. `boule/evt_20260610_075405_4553`. */
  branch: string;
  /** Abbreviated tip SHA. */
  tip: string;
  /** Tip commit subject (single line by git's definition). */
  subject: string;
  /** Commits on the branch not reachable from HEAD (`rev-list --count HEAD..branch`);
   *  null when the cheap per-branch count failed (the branch row still surfaces). */
  aheadCount: number | null;
}

/** Bounded spawn budget: 1 listing + at most this many per-branch ahead-counts (INVARIANT #5 —
 *  a pathological branch pile must not turn an observability read into an unbounded scan). */
export const MAX_UNMERGED_BRANCHES = 20;

/** NUL field separator: a subject can contain anything except newline/NUL, so `%00`-separated
 *  `for-each-ref --format` output is porcelain-safe to split (no fragile `git branch` decoration
 *  parsing). */
const FOR_EACH_REF_FORMAT = "%(refname:short)%00%(objectname:short)%00%(subject)";

/** List local `boule/*` branches NOT merged into the repo's CURRENT branch (HEAD), each with tip
 *  SHA + subject + a cheap ahead-count. Returns `null` on listing failure (caller omits the field
 *  — fail-soft: this is observability, never a tick/snapshot gate) and `[]` when there are
 *  genuinely none. Bounded: one `for-each-ref` + ≤maxBranches `rev-list --count` spawns, no retry. */
export function listUnmergedPlanBranches(
  repoRoot: string,
  deps: { spawn: SpawnSyncLike; maxBranches?: number },
): UnmergedPlanBranch[] | null {
  const max = boundedMax(deps.maxBranches);
  let listed: { status: number | null; stdout: string };
  try {
    listed = deps.spawn("git", [
      "-C",
      repoRoot,
      "for-each-ref",
      `--format=${FOR_EACH_REF_FORMAT}`,
      "--no-merged=HEAD",
      "refs/heads/boule/*",
    ]);
  } catch {
    return null;
  }
  if (listed.status !== 0) return null;

  const out: UnmergedPlanBranch[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (out.length >= max) break;
    if (!line.trim()) continue;
    const [branch, tip, subject] = line.split("\u0000");
    if (!branch || !tip) continue; // malformed row — skip, never throw
    out.push({
      branch,
      tip,
      subject: subject ?? "",
      aheadCount: aheadCount(repoRoot, branch, deps.spawn),
    });
  }
  return out;
}

function boundedMax(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw < 1) return MAX_UNMERGED_BRANCHES;
  return Math.min(raw, MAX_UNMERGED_BRANCHES);
}

function aheadCount(repoRoot: string, branch: string, spawn: SpawnSyncLike): number | null {
  try {
    const r = spawn("git", [
      "-C",
      repoRoot,
      "rev-list",
      "--count",
      `HEAD..refs/heads/${branch}`,
    ]);
    if (r.status !== 0) return null;
    const n = Number(r.stdout.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}
