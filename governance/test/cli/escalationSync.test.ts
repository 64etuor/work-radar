import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampSyncTimeoutMs,
  maybeRunEscalationSync,
  runEscalationSyncCommand,
  type EnvSpawnLike,
} from "../../src/cli/escalationSync.js";
import type { ChildLike } from "../../src/decision/liveReviewer.js";
import { cmdInit } from "../../src/cli/boule.js";
import { writeConfig } from "../../src/repo/configIo.js";
import { boulePaths } from "../../src/repo/paths.js";
import { escalate } from "../../src/escalate/escalate.js";

/** Scriptable fake child (mirrors evaluateLive.test): closes with the scripted code, or never. */
function fakeChild(script: { exitCode?: number | null; neverClose?: boolean; onKill?: () => void }): ChildLike {
  const listeners: Record<string, Array<(arg: never) => void>> = {};
  const child: ChildLike = {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    stdin: { write: () => {}, end: () => {} },
    on(event, listener) {
      (listeners[event] ??= []).push(listener as (arg: never) => void);
    },
    kill() {
      script.onKill?.();
    },
  };
  if (!script.neverClose) {
    queueMicrotask(() => {
      for (const l of listeners["close"] ?? []) (l as (c: number | null) => void)(script.exitCode ?? 0);
    });
  }
  return child;
}

interface SpawnRecord {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

function recordingSpawn(
  child: () => ChildLike,
): { spawn: EnvSpawnLike; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = [];
  return {
    spawns,
    spawn: (command, args, opts) => {
      spawns.push({ command, args, env: opts.env });
      return child();
    },
  };
}

describe("clampSyncTimeoutMs", () => {
  it("defaults to 60s and clamps malformed/negative/huge values", () => {
    expect(clampSyncTimeoutMs(undefined)).toBe(60_000);
    expect(clampSyncTimeoutMs("garbage")).toBe(60_000);
    expect(clampSyncTimeoutMs("-1")).toBe(60_000);
    expect(clampSyncTimeoutMs("5000")).toBe(5_000);
    expect(clampSyncTimeoutMs("99999999")).toBe(600_000);
  });
});

describe("runEscalationSyncCommand — one bounded spawn, never throws", () => {
  it("spawns the argv ONCE with BOULE_WORKSPACE injected; exit 0 ⇒ ok", async () => {
    const { spawn, spawns } = recordingSpawn(() => fakeChild({ exitCode: 0 }));
    const r = await runEscalationSyncCommand(
      ["python3", "sync.py", "--live"],
      "/ws/path",
      { PATH: "/usr/bin", HOME: "/home/u" },
      { spawn },
    );
    expect(r).toBe("ok");
    expect(spawns).toHaveLength(1);
    expect(spawns[0].command).toBe("python3");
    expect(spawns[0].args).toEqual(["sync.py", "--live"]);
    expect(spawns[0].env.BOULE_WORKSPACE).toBe("/ws/path");
    expect(spawns[0].env.PATH).toBe("/usr/bin"); // caller env carried through
  });

  it("non-zero exit ⇒ failed (no throw, no retry)", async () => {
    const { spawn, spawns } = recordingSpawn(() => fakeChild({ exitCode: 3 }));
    const r = await runEscalationSyncCommand(["sync"], "/ws", {}, { spawn });
    expect(r).toBe("failed");
    expect(spawns).toHaveLength(1); // zero retry
  });

  it("timeout ⇒ kill + failed (bounded, non-blocking)", async () => {
    let killed = false;
    const { spawn } = recordingSpawn(() => fakeChild({ neverClose: true, onKill: () => (killed = true) }));
    const timers: Array<() => void> = [];
    const r = await runEscalationSyncCommand(["hang"], "/ws", {}, {
      spawn,
      timeoutMs: 60_000,
      setTimer: (cb) => {
        timers.push(cb);
        queueMicrotask(cb); // fire the timeout immediately
        return () => {};
      },
    });
    expect(r).toBe("failed");
    expect(killed).toBe(true);
    expect(timers).toHaveLength(1);
  });

  it("spawn throw ⇒ failed (never propagates into the tick)", async () => {
    const r = await runEscalationSyncCommand(["nope"], "/ws", {}, {
      spawn: () => {
        throw new Error("ENOENT");
      },
    });
    expect(r).toBe("failed");
  });
});

describe("maybeRunEscalationSync — config-gated, pending-gated", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "boule-escsync-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function configureHook(): Promise<void> {
    await cmdInit({ repo, kind: "personal" });
    await writeConfig(repo, {
      schemaVersion: 1,
      kind: "personal",
      escalationSync: { command: ["sync-bin", "--once"] },
    });
  }

  it("unconfigured ⇒ undefined (absent from the report), zero spawns", async () => {
    await cmdInit({ repo, kind: "personal" });
    const { spawn, spawns } = recordingSpawn(() => fakeChild({}));
    const r = await maybeRunEscalationSync({
      repoRoot: repo,
      workspace: boulePaths(repo).workspace,
      now: new Date(),
      env: {},
      deps: { spawn },
    });
    expect(r).toBeUndefined();
    expect(spawns).toHaveLength(0);
  });

  it("configured + zero pending ⇒ skipped, zero spawns", async () => {
    await configureHook();
    const { spawn, spawns } = recordingSpawn(() => fakeChild({}));
    const r = await maybeRunEscalationSync({
      repoRoot: repo,
      workspace: boulePaths(repo).workspace,
      now: new Date(),
      env: {},
      deps: { spawn },
    });
    expect(r).toBe("skipped");
    expect(spawns).toHaveLength(0);
  });

  it("configured + pending ⇒ spawned ONCE with the workspace env; failure stays non-blocking", async () => {
    await configureHook();
    const ws = boulePaths(repo).workspace;
    await escalate(
      ws,
      { question: "ship?", options: [{ label: "yes" }, { label: "no" }] },
      new Date("2026-06-12T10:00:00Z"),
      0.5,
    );
    const ok = recordingSpawn(() => fakeChild({ exitCode: 0 }));
    const r = await maybeRunEscalationSync({
      repoRoot: repo,
      workspace: ws,
      now: new Date("2026-06-12T10:05:00Z"),
      env: { HOME: "/home/u" },
      deps: { spawn: ok.spawn },
    });
    expect(r).toBe("ok");
    expect(ok.spawns).toHaveLength(1);
    expect(ok.spawns[0].env.BOULE_WORKSPACE).toBe(ws);

    const bad = recordingSpawn(() => fakeChild({ exitCode: 1 }));
    const r2 = await maybeRunEscalationSync({
      repoRoot: repo,
      workspace: ws,
      now: new Date("2026-06-12T10:06:00Z"),
      env: {},
      deps: { spawn: bad.spawn },
    });
    expect(r2).toBe("failed"); // recorded, never thrown
    expect(bad.spawns).toHaveLength(1);
  });

  it("an EXPIRED-but-unresolved escalation still counts as pending (P3d: the halt persists)", async () => {
    await configureHook();
    const ws = boulePaths(repo).workspace;
    await escalate(
      ws,
      { question: "old?", options: [{ label: "a" }, { label: "b" }], ttlHours: 1 },
      new Date("2026-06-10T10:00:00Z"),
      0.5,
    );
    const { spawn, spawns } = recordingSpawn(() => fakeChild({ exitCode: 0 }));
    const r = await maybeRunEscalationSync({
      repoRoot: repo,
      workspace: ws,
      now: new Date("2026-06-12T10:00:00Z"), // 2 days later, far past the 1h TTL
      env: {},
      deps: { spawn },
    });
    expect(r).toBe("ok");
    expect(spawns).toHaveLength(1);
  });
});
