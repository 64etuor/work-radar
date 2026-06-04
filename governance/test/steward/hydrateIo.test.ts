import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrate, type HydrateDeps } from "../../src/steward/hydrateIo.js";
import { requestHandoff, draftHandoff, runValidateHandoff, handoffTrail } from "../../src/handoff/handlers.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nc ${h}`).join("\n\n");
const deps: HydrateDeps = {
  gitSummary: async () => ({ status: "clean", diffstat: "" }),
  readNeighbors: async () => [],
  principles: async () => ["INVARIANT #1"],
};

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-hydrate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("hydrate IO shell", () => {
  it("assembles a bundle and consumes the pending handoff", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    await draftHandoff(dir, { handoffId, body: complete }, at(1), 0.2);
    await runValidateHandoff(dir, { handoffId }, at(2), 0.3);

    const r = await hydrate(dir, { handoffId }, deps, at(3), 0.4);
    expect(r.ok).toBe(true);
    expect(r.markdown).toContain("# Hydration Bundle");
    expect((await handoffTrail(dir, { handoffId })).phase).toBe("consumed");

    // Idempotent / no double-spend: a second hydrate on a now-consumed handoff writes ZERO new
    // events (INVARIANT #1 — exactly one handoff_consumed, ever).
    const countAfter = (await readAllEvents(dir)).length;
    const second = await hydrate(dir, { handoffId }, deps, at(4), 0.5);
    expect(second.ok).toBe(false);
    expect((await readAllEvents(dir)).length).toBe(countAfter);

    // INVARIANT #1: the whole path wrote only handoff_* events.
    const all = await readAllEvents(dir);
    expect(all.every((e) => e.frontmatter.type.startsWith("handoff_"))).toBe(true);
  });

  it("refuses to hydrate a non-pending handoff", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    const r = await hydrate(dir, { handoffId }, deps, at(1), 0.2);
    expect(r.ok).toBe(false);
  });
});
