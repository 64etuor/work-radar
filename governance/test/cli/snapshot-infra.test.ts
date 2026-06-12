import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSnapshot } from "../../src/cli/boule.ts";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "cr-snap-infra-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("cmdSnapshot infra/readiness", () => {
  it("emits infra checks + readiness gates even with zero events", async () => {
    const json = await cmdSnapshot({ repo });
    const snap = JSON.parse(json);
    expect(snap.tasks).toEqual([]);
    expect(snap.generatedAt).toBeNull();
    expect(Array.isArray(snap.infra)).toBe(true);
    const ids = snap.infra.map((c: { id: string }) => c.id);
    expect(ids).toContain("cmux_socket");
    expect(ids).toContain("git_worktree");
    expect(snap.readiness).toMatchObject({
      ready: expect.any(Boolean),
      blockers: expect.any(Array),
      warnings: expect.any(Array),
      gates: {
        preflight: expect.any(Boolean),
        conductor: expect.any(Boolean),
        observer: expect.any(Boolean),
        auto: expect.any(Boolean),
        stall: expect.any(Boolean),
      },
    });
  });
});

describe("cmdSnapshot — unmerged plan-branch surfacing (P4a)", () => {
  const NUL = "\u0000";

  it("includes unmergedPlanBranches (additive field) when the git listing succeeds", async () => {
    const spawn = (_cmd: string, args: string[]) => {
      if (args.includes("for-each-ref"))
        return {
          status: 0,
          stdout: `boule/evt_p1${NUL}abc1234${NUL}step 6: finish slice\n`,
          stderr: "",
        };
      if (args.includes("rev-list")) return { status: 0, stdout: "2\n", stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    };
    const snap = JSON.parse(await cmdSnapshot({ repo }, { unmergedBranches: { spawn } }));
    expect(snap.unmergedPlanBranches).toEqual([
      { branch: "boule/evt_p1", tip: "abc1234", subject: "step 6: finish slice", aheadCount: 2 },
    ]);
    // the established axes are untouched — strictly additive
    expect(snap.tasks).toEqual([]);
    expect(Array.isArray(snap.infra)).toBe(true);
  });

  it("fail-soft: a failed listing (non-git temp dir, real spawn) OMITS the field — snapshot still emits", async () => {
    const snap = JSON.parse(await cmdSnapshot({ repo }));
    expect("unmergedPlanBranches" in snap).toBe(false);
    expect(snap.tasks).toEqual([]); // the snapshot itself is unbroken
  });
});
