import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/event/writeEvent.js";
import { generateId } from "../../src/event/id.js";
import { readAllEvents, readEventsSince } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-since-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write a note event stamped at `d`; returns its id. */
async function note(d: Date, rand: number): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", d, rand),
      type: "note",
      source: "system",
      actor: "system",
      tags: ["t"],
      related_to: [],
    },
    body: "n",
  };
  await writeEvent(dir, evt, d);
  return evt.frontmatter.id;
}

const day = (dd: number, hh = 12, mm = 0, ss = 0) => new Date(Date.UTC(2026, 5, dd, hh, mm, ss));

describe("readEventsSince", () => {
  it("a null cursor returns exactly what readAllEvents returns (same ids, same order)", async () => {
    await note(day(7, 12, 0, 1), 0.1);
    await note(day(7, 12, 0, 2), 0.2);
    await note(day(8, 9, 0, 0), 0.3);

    const all = await readAllEvents(dir);
    const snap = await readEventsSince(dir, null);
    expect(snap.events.map((e) => e.frontmatter.id)).toEqual(all.map((e) => e.frontmatter.id));
  });

  it("returns only events strictly newer than the cursor", async () => {
    const a = await note(day(7, 12, 0, 1), 0.1);
    const b = await note(day(7, 12, 0, 2), 0.2);
    const c = await note(day(7, 12, 0, 3), 0.3);

    const snap = await readEventsSince(dir, a);
    expect(snap.events.map((e) => e.frontmatter.id)).toEqual([b, c]);
    expect(snap.cursor).toBe(c);
  });

  it("returns empty and preserves the cursor when nothing is newer", async () => {
    await note(day(7, 12, 0, 1), 0.1);
    const last = await note(day(7, 12, 0, 2), 0.2);

    const snap = await readEventsSince(dir, last);
    expect(snap.events).toHaveLength(0);
    expect(snap.cursor).toBe(last); // unchanged → next poll re-reads from here
  });

  it("skips entire day-dirs that predate the cursor's day", async () => {
    await note(day(7, 12, 0, 1), 0.1); // day 7
    const cut = await note(day(8, 0, 0, 0), 0.2); // day 8 (the cursor)
    const d9 = await note(day(9, 8, 0, 0), 0.3); // day 9

    const snap = await readEventsSince(dir, cut);
    // Only the day-9 event is newer than the cursor; the day-7 dir is skipped, day-8 id-filtered.
    expect(snap.events.map((e) => e.frontmatter.id)).toEqual([d9]);
  });

  it("an empty workspace yields an empty snapshot that preserves the cursor", async () => {
    const snap = await readEventsSince(dir, "evt_20260607_120000_0001");
    expect(snap.events).toHaveLength(0);
    expect(snap.cursor).toBe("evt_20260607_120000_0001");
  });
});
