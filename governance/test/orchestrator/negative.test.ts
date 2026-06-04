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
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-orch-neg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body };
}

describe("suggest — INVARIANT #1: no verdict, no advance (negative)", () => {
  it("emits no decision/task/session event even when every rule fires", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "active no-session"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "S", ["evt_t1"]), at(1)); // rule 2
    await writeEvent(dir, ev("evt_t2", "task_created", "blocked task"), at(2));
    await writeEvent(dir, ev("evt_t2s", "task_started", "S", ["evt_t2"]), at(3));
    await writeEvent(dir, ev("evt_t2b", "task_blocked", "B", ["evt_t2"]), at(4));
    await writeEvent(dir, ev("evt_b1", "decision_blocked", JSON.stringify({ question: "?" }), ["evt_decX", "evt_t2"]), at(5)); // rule 4
    await writeEvent(dir, ev("evt_t3", "task_created", "done task"), at(6));
    await writeEvent(dir, ev("evt_t3s", "task_started", "S", ["evt_t3"]), at(7));
    await writeEvent(dir, ev("evt_t3d", "task_completed", "D", ["evt_t3"]), at(8));
    await writeEvent(dir, ev("evt_s1", "session_spawned", JSON.stringify({ surface: "9" }), ["evt_t3"]), at(9));
    await writeEvent(dir, ev("evt_s1o", "session_observed", "obs", ["evt_s1"]), at(10)); // active, bound to done task → rule 3
    await writeEvent(dir, ev("evt_s2", "session_opened", JSON.stringify({ surface: "8", ownership: "external_owned" })), at(11));
    await writeEvent(dir, ev("evt_s2o", "session_observed", "obs", ["evt_s2"]), at(12)); // orphan active → rule 5
    await writeEvent(dir, ev("evt_s3", "session_opened", JSON.stringify({ surface: "7", ownership: "user_owned" })), at(13));
    await writeEvent(dir, ev("evt_s3p", "session_context_pressure_changed", JSON.stringify({ level: "high" }), ["evt_s3"]), at(14)); // rule 1

    const before = await readAllEvents(dir);
    const r = await suggest(dir, at(20), 0.5);
    const after = await readAllEvents(dir);

    const newEvents = after.slice(before.length);
    expect(newEvents.length).toBe(r.created);
    expect(newEvents.length).toBeGreaterThanOrEqual(5); // all 5 rules fired
    for (const e of newEvents) {
      expect(e.frontmatter.type).toBe("orchestrator_suggestion_created");
      expect(e.frontmatter.actor).toBe("system"); // never actor=user — mints no verdict
    }
    const forbidden = (t: string) => t.startsWith("decision_") || t.startsWith("task_") || t.startsWith("session_");
    expect(newEvents.some((e) => forbidden(e.frontmatter.type))).toBe(false);
  });
});
