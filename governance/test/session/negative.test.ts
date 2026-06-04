import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { observeSessions, type ObserverAdapter } from "../../src/session/observer.js";
import {
  requestSessionOpen,
  markWaiting,
  recordPressure,
  requestSessionClose,
  closeSession,
} from "../../src/session/handlers.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 15, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-sess-neg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeAdapter(surfaces: string[]): ObserverAdapter {
  return {
    async listSurfaces() {
      return surfaces.map((surface) => ({ surface }));
    },
  };
}
async function seedSpawned(surface: string, id = "evt_20260603_150000_0001") {
  const e: GovEvent = {
    frontmatter: {
      id,
      type: "session_spawned",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor"],
      related_to: ["evt_task0"],
    },
    body: JSON.stringify({ surface }),
  };
  await writeEvent(dir, e, at(0));
  return id;
}

describe("ZERO-VERDICT isolation (done-criteria #6)", () => {
  it("a full observe + record run emits ONLY session_* — ZERO decision_*", async () => {
    const id = await seedSpawned("7");
    const adapter = fakeAdapter(["7"]);
    await observeSessions(dir, { adapter }, at(10), 0.1);
    await recordPressure(dir, { sessionId: id, level: "high" }, at(20), 0.2);
    await markWaiting(dir, { sessionId: id }, at(30), 0.3);
    await requestSessionClose(dir, { sessionId: id }, at(40), 0.4);
    await closeSession(dir, { sessionId: id }, at(50), 0.5);

    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type.startsWith("decision_"))).toBe(false);
    // every session-module-authored event uses source:system/actor:system or the seeded spawn.
    const sessionAuthored = all.filter((e) => e.frontmatter.tags.includes("session"));
    expect(sessionAuthored.every((e) => e.frontmatter.type.startsWith("session_"))).toBe(true);
    expect(sessionAuthored.some((e) => e.frontmatter.actor === "user")).toBe(false);
  });
});

describe("STRUCTURAL: src/session/** imports no decision write handlers (done-criteria #6)", () => {
  it("no session source file imports decision/handlers", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sessionDir = join(here, "..", "..", "src", "session");
    const files = (await readdir(sessionDir)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = await readFile(join(sessionDir, f), "utf8");
      expect(src, `${f} must not import decision write handlers`).not.toMatch(
        /from\s+["'][^"']*decision\/handlers/,
      );
      // Defense-in-depth (critic MINOR #1): no session file may write a decision_* event LITERAL
      // via the generic writeEvent primitive — catches a future edit even without a handler import.
      expect(src, `${f} must not write a decision_* event literal`).not.toMatch(/["']decision_/);
    }
  });
});

describe("NO-AUTO-CLOSE is structural (done-criteria #5, §18.3)", () => {
  it("observer.ts contains no session_closed write literal", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, "..", "..", "src", "session", "observer.ts"), "utf8");
    // the only allowed occurrence is the NOTE comment; assert no quoted event literal is written.
    expect(src).not.toMatch(/["']session_closed["']/);
  });

  it("no observe pass (alive, gone, returned) ever emits session_closed", async () => {
    const adapter = (() => {
      let s: string[] = ["7"];
      return {
        adp: {
          async listSurfaces() {
            return s.map((surface) => ({ surface }));
          },
        } as ObserverAdapter,
        set: (x: string[]) => {
          s = x;
        },
      };
    })();
    await seedSpawned("7");
    await observeSessions(dir, { adapter: adapter.adp }, at(10), 0.1); // observed
    adapter.set([]);
    await observeSessions(dir, { adapter: adapter.adp }, at(20), 0.2); // crashed
    adapter.set(["7"]);
    await observeSessions(dir, { adapter: adapter.adp }, at(30), 0.3); // recovered
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "session_closed")).toBe(false);
  });

  it("close_session is the ONLY session_closed path, and only after session_close_requested", async () => {
    const { sessionId } = await requestSessionOpen(dir, { surface: "7" }, at(0), 0.1);
    // refuse before request
    expect((await closeSession(dir, { sessionId }, at(1), 0.2)).ok).toBe(false);
    expect((await readAllEvents(dir)).some((e) => e.frontmatter.type === "session_closed")).toBe(
      false,
    );
    // request → close
    await requestSessionClose(dir, { sessionId }, at(2), 0.3);
    expect((await closeSession(dir, { sessionId }, at(3), 0.4)).ok).toBe(true);
    const closed = (await readAllEvents(dir)).filter(
      (e) => e.frontmatter.type === "session_closed",
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.frontmatter.related_to).toEqual([sessionId]);
  });
});
