import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggest } from "../../src/orchestrator/suggest.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 14, 0, s));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-orch-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body };
}
async function typesOf(): Promise<string[]> { return (await readAllEvents(dir)).map((e) => e.frontmatter.type); }
function count(types: string[], t: string): number { return types.filter((x) => x === t).length; }

describe("suggest — emit + dedup", () => {
  it("an active task with no session → one orchestrator_suggestion_created", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    const r = await suggest(dir, at(10), 0.1);
    expect(r.created).toBe(1);
    expect(count(await typesOf(), "orchestrator_suggestion_created")).toBe(1);
  });

  it("is idempotent — second pass with no state change creates 0", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    await suggest(dir, at(10), 0.1);
    const r2 = await suggest(dir, at(20), 0.2);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(count(await typesOf(), "orchestrator_suggestion_created")).toBe(1);
  });

  it("emits ONLY orchestrator_suggestion_created (no other new type)", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    const before = await typesOf();
    await suggest(dir, at(10), 0.1);
    const after = await typesOf();
    const newTypes = new Set(after.filter((t, i) => i >= before.length));
    expect([...newTypes]).toEqual(["orchestrator_suggestion_created"]);
  });
});
