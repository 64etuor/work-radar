import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents, eventsForDecision } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-read-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function mk(id: string, type: GovEvent["frontmatter"]["type"], related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "hermes", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body: id };
}

describe("readAllEvents / eventsForDecision", () => {
  it("reads every written event back", async () => {
    await writeEvent(dir, mk("evt_20260531_120000_aaaa", "decision_proposed"), new Date(Date.UTC(2026, 4, 31, 12, 0, 0)));
    await writeEvent(dir, mk("evt_20260531_120100_bbbb", "task_created"), new Date(Date.UTC(2026, 4, 31, 12, 1, 0)));
    const all = await readAllEvents(dir);
    expect(all.map((e) => e.frontmatter.id).sort()).toEqual(["evt_20260531_120000_aaaa", "evt_20260531_120100_bbbb"]);
  });

  it("groups proposal + related, sorted chronologically by id", async () => {
    const PID = "evt_20260531_120000_aaaa";
    await writeEvent(dir, mk(PID, "decision_proposed"), new Date(Date.UTC(2026, 4, 31, 12, 0, 0)));
    await writeEvent(dir, mk("evt_20260531_120200_cccc", "decision_review_recorded", [PID]), new Date(Date.UTC(2026, 4, 31, 12, 2, 0)));
    await writeEvent(dir, mk("evt_20260531_120300_dddd", "task_created"), new Date(Date.UTC(2026, 4, 31, 12, 3, 0)));
    const all = await readAllEvents(dir);
    const grp = eventsForDecision(all, PID);
    expect(grp.proposal?.frontmatter.id).toBe(PID);
    expect(grp.related.map((e) => e.frontmatter.id)).toEqual(["evt_20260531_120200_cccc"]);
  });

  it("returns empty list for a fresh workspace", async () => {
    expect(await readAllEvents(dir)).toEqual([]);
  });
});
