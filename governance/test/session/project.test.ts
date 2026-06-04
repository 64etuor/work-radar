import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/event/writeEvent.js";
import { projectSessions, renderSessions } from "../../src/session/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import type { GovEvent, EventType } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 12, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-sess-proj-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function evt(type: EventType, id: string, relatedTo: string[] | undefined, body: string): GovEvent {
  const frontmatter = { id, type, source: "system" as const, actor: "user", tags: ["session"] };
  // Omit related_to when absent — gray-matter (js-yaml) cannot serialize an `undefined` value.
  return { frontmatter: relatedTo ? { ...frontmatter, related_to: relatedTo } : frontmatter, body };
}

/** Lay down a small valid session corpus directly on disk (the projector only reads events). */
async function seed() {
  await writeEvent(
    dir,
    evt(
      "session_spawned",
      "evt_20260603_120000_0001",
      ["evt_task0"],
      JSON.stringify({ surface: "7" }),
    ),
    at(0),
  );
  await writeEvent(
    dir,
    evt("session_observed", "evt_20260603_120001_0002", ["evt_20260603_120000_0001"], ""),
    at(1),
  );
  await writeEvent(
    dir,
    evt(
      "session_opened",
      "evt_20260603_120002_0003",
      undefined,
      JSON.stringify({ surface: "9", ownership: "external_owned" }),
    ),
    at(2),
  );
  await writeEvent(
    dir,
    evt("session_waiting", "evt_20260603_120003_0004", ["evt_20260603_120002_0003"], ""),
    at(3),
  );
}

describe("session projector", () => {
  it("projectSessions is pure: no I/O, emits no events, stable across calls", async () => {
    await seed();
    const all = await readAllEvents(dir);
    const before = all.length;
    const r1 = projectSessions(all);
    const r2 = projectSessions(all);
    expect(r1).toEqual(r2);
    expect((await readAllEvents(dir)).length).toBe(before);
  });

  it("KEYSTONE: wipe state/ and re-render → byte-identical (projection = f(events))", async () => {
    await seed();
    const p = await renderSessions(dir);
    const first = await readFile(p, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    const p2 = await renderSessions(dir);
    const second = await readFile(p2, "utf8");
    expect(second).toBe(first);
  });

  it("projection reflects derived phases + ownership", async () => {
    await seed();
    const states = projectSessions(await readAllEvents(dir));
    const byId = Object.fromEntries(states.map((s) => [s.sessionId, s]));
    expect(byId["evt_20260603_120000_0001"]!.phase).toBe("active");
    expect(byId["evt_20260603_120000_0001"]!.ownership).toBe("orchestrator_owned");
    expect(byId["evt_20260603_120002_0003"]!.phase).toBe("waiting");
    expect(byId["evt_20260603_120002_0003"]!.ownership).toBe("external_owned");
  });
});
