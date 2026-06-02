import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeSessions,
  makeLiveAdapter,
  parseSurfaces,
  type ObserverAdapter,
  type SpawnResultLike,
} from "../../src/session/observer.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { listSessions, sessionTrail } from "../../src/session/handlers.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 14, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-sess-obs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fake adapter whose live surface set the test mutates between passes. */
function fakeAdapter(initial: string[]): ObserverAdapter & { set(s: string[]): void } {
  let surfaces = initial;
  return {
    async listSurfaces() {
      return surfaces.map((surface) => ({ surface }));
    },
    set(s) {
      surfaces = s;
    },
  };
}

/** Seed one Phase-C-style spawned session (orchestrator_owned, surface in body). */
async function seedSpawned(surface: string, id = "evt_20260603_140000_0001") {
  const e: GovEvent = {
    frontmatter: {
      id,
      type: "session_spawned",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor"],
      related_to: ["evt_task0"],
    },
    body: JSON.stringify({ surface, worktree: "/wt" }),
  };
  await writeEvent(dir, e, at(0));
  return id;
}

async function typesOf(): Promise<string[]> {
  return (await readAllEvents(dir)).map((e) => e.frontmatter.type);
}
function count(types: string[], t: string): number {
  return types.filter((x) => x === t).length;
}

describe("observeSessions — heartbeat on change (done-criteria #2)", () => {
  it("an alive opening session → exactly one session_observed across two passes", async () => {
    const id = await seedSpawned("7");
    const adapter = fakeAdapter(["7"]);
    await observeSessions(dir, { adapter }, at(10), 0.1); // opening → observed (active)
    await observeSessions(dir, { adapter }, at(20), 0.2); // active is alive-observed → nothing
    expect(count(await typesOf(), "session_observed")).toBe(1);
    expect((await sessionTrail(dir, { sessionId: id })).phase).toBe("active");
  });
});

describe("observeSessions — crash / recover (done-criteria #3)", () => {
  it("surface disappears → session_crashed; reappears → session_recovered", async () => {
    const id = await seedSpawned("7");
    const adapter = fakeAdapter(["7"]);
    await observeSessions(dir, { adapter }, at(10), 0.1); // → active
    adapter.set([]); // surface gone
    await observeSessions(dir, { adapter }, at(20), 0.2); // → crashed
    expect((await sessionTrail(dir, { sessionId: id })).phase).toBe("crashed");
    adapter.set(["7"]); // surface back
    await observeSessions(dir, { adapter }, at(30), 0.3); // → recovered (recovering)
    expect((await sessionTrail(dir, { sessionId: id })).phase).toBe("recovering");
    const types = await typesOf();
    expect(count(types, "session_crashed")).toBe(1);
    expect(count(types, "session_recovered")).toBe(1);
  });

  it("a gone session already crashed stays crashed (no second crash)", async () => {
    await seedSpawned("7");
    const adapter = fakeAdapter(["7"]);
    await observeSessions(dir, { adapter }, at(10), 0.1);
    adapter.set([]);
    await observeSessions(dir, { adapter }, at(20), 0.2);
    await observeSessions(dir, { adapter }, at(30), 0.3); // still gone
    expect(count(await typesOf(), "session_crashed")).toBe(1);
  });
});

describe("observeSessions — orphan auto-open (done-criteria #4)", () => {
  it("unknown live surface → one session_opened (external_owned), idempotent on re-observe", async () => {
    const adapter = fakeAdapter(["99"]);
    await observeSessions(dir, { adapter }, at(10), 0.1); // orphan → session_opened
    const after1 = await listSessions(dir);
    expect(after1).toHaveLength(1);
    expect(after1[0]!.ownership).toBe("external_owned");
    expect(after1[0]!.surface).toBe("99");
    await observeSessions(dir, { adapter }, at(20), 0.2); // known now → observed, NOT a 2nd open
    const types = await typesOf();
    expect(count(types, "session_opened")).toBe(1);
    expect(count(types, "session_observed")).toBe(1);
  });
});

describe("makeLiveAdapter — cmux list command (injected fake spawn, no real process)", () => {
  it("runs `cmux list` and parses surfaces from stdout", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      return { status: 0, stdout: "7\n9\n\n12\n", stderr: "" };
    };
    const adapter = makeLiveAdapter({ spawn: fakeSpawn, cmuxCmd: "cmux" });
    const surfaces = await adapter.listSurfaces();
    expect(calls).toEqual([{ cmd: "cmux", args: ["list"] }]);
    expect(surfaces.map((s) => s.surface)).toEqual(["7", "9", "12"]);
  });

  it("surfaces a terminal failure when cmux exits non-zero (no retry loop)", async () => {
    const fakeSpawn = (): SpawnResultLike => ({ status: 1, stdout: "", stderr: "boom" });
    const adapter = makeLiveAdapter({ spawn: fakeSpawn, cmuxCmd: "cmux" });
    await expect(adapter.listSurfaces()).rejects.toThrow(/failed/i);
  });

  it("parseSurfaces ignores blank lines + trims", () => {
    expect(parseSurfaces(" a \n\n b\n").map((s) => s.surface)).toEqual(["a", "b"]);
  });
});
