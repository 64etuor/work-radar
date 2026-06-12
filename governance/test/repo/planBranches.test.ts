import { describe, it, expect } from "vitest";
import {
  listUnmergedPlanBranches,
  MAX_UNMERGED_BRANCHES,
} from "../../src/repo/planBranches.js";
import type { SpawnResultLike } from "../../src/repo/spawn.js";

const NUL = "\u0000";

interface Call {
  cmd: string;
  args: string[];
}

function fakeGit(
  listing: SpawnResultLike,
  counts: Record<string, SpawnResultLike> = {},
): { spawn: (cmd: string, args: string[]) => SpawnResultLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    spawn: (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes("for-each-ref")) return listing;
      if (args.includes("rev-list")) {
        const range = args.at(-1)!;
        return counts[range] ?? { status: 0, stdout: "0\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unexpected" };
    },
  };
}

describe("listUnmergedPlanBranches (P4a — R5 unmerged plan-branch surfacing)", () => {
  it("parses NUL-separated rows into branch/tip/subject + per-branch ahead counts", () => {
    const listing = {
      status: 0,
      stdout:
        `boule/evt_a${NUL}abc1234${NUL}feat: step 3 — add usage parse\n` +
        `boule/evt_b${NUL}def5678${NUL}fix tail\n`,
      stderr: "",
    };
    const git = fakeGit(listing, {
      "HEAD..refs/heads/boule/evt_a": { status: 0, stdout: "3\n", stderr: "" },
      "HEAD..refs/heads/boule/evt_b": { status: 0, stdout: "1\n", stderr: "" },
    });
    const out = listUnmergedPlanBranches("/repo", { spawn: git.spawn });
    expect(out).toEqual([
      {
        branch: "boule/evt_a",
        tip: "abc1234",
        subject: "feat: step 3 — add usage parse",
        aheadCount: 3,
      },
      { branch: "boule/evt_b", tip: "def5678", subject: "fix tail", aheadCount: 1 },
    ]);
    // porcelain-safe plumbing: for-each-ref + --no-merged=HEAD scoped to refs/heads/boule/*
    expect(git.calls[0]!.args).toContain("--no-merged=HEAD");
    expect(git.calls[0]!.args).toContain("refs/heads/boule/*");
    expect(git.calls[0]!.args).toContain("-C");
    expect(git.calls[0]!.args).toContain("/repo");
  });

  it("returns [] (not null) when there are genuinely no unmerged boule/* branches", () => {
    const git = fakeGit({ status: 0, stdout: "", stderr: "" });
    expect(listUnmergedPlanBranches("/repo", { spawn: git.spawn })).toEqual([]);
    expect(git.calls).toHaveLength(1); // no per-branch spawns
  });

  it("fail-soft: listing failure (non-repo / git absent) returns null, never throws", () => {
    const failing = fakeGit({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    expect(listUnmergedPlanBranches("/tmp/nope", { spawn: failing.spawn })).toBeNull();
    const throwing = () => {
      throw new Error("spawn ENOENT");
    };
    expect(listUnmergedPlanBranches("/repo", { spawn: throwing })).toBeNull();
  });

  it("a failed ahead-count degrades that field to null but still surfaces the branch row", () => {
    const listing = {
      status: 0,
      stdout: `boule/evt_a${NUL}abc1234${NUL}subject\n`,
      stderr: "",
    };
    const git = fakeGit(listing, {
      "HEAD..refs/heads/boule/evt_a": { status: 1, stdout: "", stderr: "boom" },
    });
    expect(listUnmergedPlanBranches("/repo", { spawn: git.spawn })).toEqual([
      { branch: "boule/evt_a", tip: "abc1234", subject: "subject", aheadCount: null },
    ]);
  });

  it("malformed rows are skipped; the spawn budget is bounded by maxBranches", () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) => `boule/evt_${i}${NUL}sha${i}${NUL}s${i}`,
    ).join("\n");
    const git = fakeGit({ status: 0, stdout: `garbage-no-nul\n${rows}\n`, stderr: "" });
    const out = listUnmergedPlanBranches("/repo", { spawn: git.spawn })!;
    expect(out).toHaveLength(MAX_UNMERGED_BRANCHES);
    // 1 listing + exactly MAX ahead-counts — a branch pile cannot unbound the scan (INVARIANT #5)
    expect(git.calls).toHaveLength(1 + MAX_UNMERGED_BRANCHES);
    const small = fakeGit({ status: 0, stdout: rows, stderr: "" });
    expect(listUnmergedPlanBranches("/repo", { spawn: small.spawn, maxBranches: 2 })).toHaveLength(2);
  });
});
