import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdTick } from "../../src/cli/boule.js";
import { writeConfig } from "../../src/repo/configIo.js";
import { boulePaths } from "../../src/repo/paths.js";
import { acquireTickLock, TICK_LOCK_FILENAME } from "../../src/orchestrator/tickLock.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { escalate } from "../../src/escalate/escalate.js";
import type { EnvSpawnLike } from "../../src/cli/escalationSync.js";
import type { ChildLike } from "../../src/decision/liveReviewer.js";

// cmdTick wiring tests (P3a mutex + P3c sync hook). The temp repo is NOT a git repo, so every
// real tick deterministically gates at infra_failed (exit 1) — which is exactly what we want:
// these tests pin the wrapper behavior (lock, report fields, exit-code invariance), not conduct.

let repo: string;
let out: string[];
let stdoutSpy: { mockRestore(): void };
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boule-tickcli-"));
  out = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as never);
});
afterEach(async () => {
  stdoutSpy.mockRestore();
  await rm(repo, { recursive: true, force: true });
});

function lastReport(): Record<string, unknown> {
  return JSON.parse(out.join("").trim().split("\n").at(-1)!) as Record<string, unknown>;
}

function fakeSyncSpawn(exitCode: number): {
  spawn: EnvSpawnLike;
  spawns: Array<{ command: string; env: Record<string, string | undefined> }>;
} {
  const spawns: Array<{ command: string; env: Record<string, string | undefined> }> = [];
  return {
    spawns,
    spawn: (command, _args, opts) => {
      spawns.push({ command, env: opts.env });
      const listeners: Array<(c: number | null) => void> = [];
      queueMicrotask(() => {
        for (const l of listeners) l(exitCode);
      });
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        stdin: { write: () => {}, end: () => {} },
        on(event: string, listener: (arg: never) => void) {
          if (event === "close") listeners.push(listener as (c: number | null) => void);
        },
        kill: () => {},
      } as ChildLike;
    },
  };
}

describe("cmdTick — tick mutex (P3a)", () => {
  it("locked tick = benign no-op: outcome 'locked', exit 0, ZERO events, zero sync spawns", async () => {
    await cmdInit({ repo, kind: "personal" });
    const ws = boulePaths(repo).workspace;
    // a pending escalation + a configured hook that must NOT fire on a locked tick
    await writeConfig(repo, {
      schemaVersion: 1,
      kind: "personal",
      escalationSync: { command: ["sync-bin"] },
    });
    await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date(),
      0.5,
    );
    const before = (await readAllEvents(ws)).map((e) => e.frontmatter.id);
    // another (fresh) tick holds the lock
    const holder = await acquireTickLock(ws, new Date(), { pid: 424242 });
    expect(holder.acquired).toBe(true);

    const sync = fakeSyncSpawn(0);
    const code = await cmdTick({ repo, json: true }, { escalationSync: { spawn: sync.spawn } });

    expect(code).toBe(0); // benign — cron must NOT alert
    const report = lastReport();
    expect(report.outcome).toBe("locked");
    expect(report.conducted).toBe(0);
    expect(report.escalationSync).toBeUndefined(); // hook only runs after a REAL tick
    expect(sync.spawns).toHaveLength(0);
    const after = (await readAllEvents(ws)).map((e) => e.frontmatter.id);
    expect(after).toEqual(before); // ZERO events written
    // and the holder's lock was not stolen or released by the no-op tick
    if (holder.acquired) await holder.release();
  });

  it("releases the lock in finally — the next tick is NOT locked (even after an exit-1 tick)", async () => {
    await cmdInit({ repo, kind: "personal" });
    const ws = boulePaths(repo).workspace;

    const first = await cmdTick({ repo, json: true });
    expect(first).toBe(1); // temp dir is not a git repo → infra_failed (the non-happy path)
    expect(lastReport().outcome).toBe("infra_failed");
    await expect(stat(join(ws, TICK_LOCK_FILENAME))).rejects.toThrow(); // released

    const second = await cmdTick({ repo, json: true });
    expect(lastReport().outcome).toBe("infra_failed"); // not "locked" — lock was released
    expect(second).toBe(1);
  });
});

describe("cmdTick — escalation sync hook (P3c)", () => {
  it("configured + pending ⇒ runs ONCE with BOULE_WORKSPACE; outcome in report; exit code unchanged", async () => {
    await cmdInit({ repo, kind: "personal" });
    const ws = boulePaths(repo).workspace;
    await writeConfig(repo, {
      schemaVersion: 1,
      kind: "personal",
      escalationSync: { command: ["sync-bin", "--once"] },
    });
    await escalate(
      ws,
      { question: "ship?", options: [{ label: "y" }, { label: "n" }] },
      new Date(),
      0.5,
    );

    const ok = fakeSyncSpawn(0);
    const code = await cmdTick({ repo, json: true }, { escalationSync: { spawn: ok.spawn } });
    expect(code).toBe(1); // infra_failed exit code — sync NEVER changes it
    expect(lastReport().escalationSync).toBe("ok");
    expect(ok.spawns).toHaveLength(1);
    expect(ok.spawns[0].command).toBe("sync-bin");
    expect(ok.spawns[0].env.BOULE_WORKSPACE).toBe(ws);

    const bad = fakeSyncSpawn(7);
    const code2 = await cmdTick({ repo, json: true }, { escalationSync: { spawn: bad.spawn } });
    expect(code2).toBe(1); // failure recorded, NOT escalated into the exit code
    expect(lastReport().escalationSync).toBe("failed");
    expect(bad.spawns).toHaveLength(1); // zero retry
  });

  it("unconfigured ⇒ no escalationSync field; configured + nothing pending ⇒ 'skipped'", async () => {
    await cmdInit({ repo, kind: "personal" });
    const sync = fakeSyncSpawn(0);
    await cmdTick({ repo, json: true }, { escalationSync: { spawn: sync.spawn } });
    expect("escalationSync" in lastReport()).toBe(false);
    expect(sync.spawns).toHaveLength(0);

    await writeConfig(repo, {
      schemaVersion: 1,
      kind: "personal",
      escalationSync: { command: ["sync-bin"] },
    });
    await cmdTick({ repo, json: true }, { escalationSync: { spawn: sync.spawn } });
    expect(lastReport().escalationSync).toBe("skipped");
    expect(sync.spawns).toHaveLength(0); // nothing pending — no spawn
  });
});

describe("cmdTick — unmerged plan-branch surfacing (P4a)", () => {
  const NUL = "\u0000";
  function fixtureSpawn(listing: string): {
    spawn: (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
    calls: string[][];
  } {
    const calls: string[][] = [];
    return {
      calls,
      spawn: (_cmd, args) => {
        calls.push(args);
        if (args.includes("for-each-ref")) return { status: 0, stdout: listing, stderr: "" };
        if (args.includes("rev-list")) return { status: 0, stdout: "4\n", stderr: "" };
        return { status: 1, stdout: "", stderr: "" };
      },
    };
  }

  it("surfaces completed-but-unmerged boule/* branches in the JSON report (additive field)", async () => {
    await cmdInit({ repo, kind: "personal" });
    const git = fixtureSpawn(`boule/evt_p1${NUL}abc1234${NUL}step 6: finish slice\n`);
    const code = await cmdTick({ repo, json: true }, { unmergedBranches: { spawn: git.spawn } });
    expect(code).toBe(1); // infra_failed in a non-git temp repo — surfacing NEVER changes the exit
    expect(lastReport().unmergedPlanBranches).toEqual([
      { branch: "boule/evt_p1", tip: "abc1234", subject: "step 6: finish slice", aheadCount: 4 },
    ]);
  });

  it("fail-soft: a failed git listing OMITS the field — tick outcome and exit code unchanged", async () => {
    await cmdInit({ repo, kind: "personal" });
    // default spawn runs real git against a non-repo temp dir ⇒ listing fails ⇒ field absent
    const code = await cmdTick({ repo, json: true });
    expect(code).toBe(1);
    expect(lastReport().outcome).toBe("infra_failed");
    expect("unmergedPlanBranches" in lastReport()).toBe(false);
  });

  it("a locked tick stays a TOTAL no-op — no branch-listing spawns either", async () => {
    await cmdInit({ repo, kind: "personal" });
    const ws = boulePaths(repo).workspace;
    const holder = await acquireTickLock(ws, new Date(), { pid: 424242 });
    expect(holder.acquired).toBe(true);
    const git = fixtureSpawn(`boule/evt_p1${NUL}abc1234${NUL}s\n`);
    await cmdTick({ repo, json: true }, { unmergedBranches: { spawn: git.spawn } });
    expect(lastReport().outcome).toBe("locked");
    expect("unmergedPlanBranches" in lastReport()).toBe(false);
    expect(git.calls).toHaveLength(0);
    if (holder.acquired) await holder.release();
  });
});
