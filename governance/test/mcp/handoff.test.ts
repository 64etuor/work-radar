import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHandoff, draftHandoff, runValidateHandoff } from "../../src/handoff/handlers.js";
import { hydrate, type HydrateDeps } from "../../src/steward/hydrateIo.js";
import { computeContextPressure } from "../../src/steward/pressure.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nc`).join("\n\n");
const deps: HydrateDeps = { gitSummary: async () => ({ status: "", diffstat: "" }), readNeighbors: async () => [], principles: async () => [] };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-mcp-handoff-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("Phase G command surface (INVARIANT #1)", () => {
  it("the full handoff+hydrate path writes ZERO decision_/task_/session_ events", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    await draftHandoff(dir, { handoffId, body: complete }, at(1), 0.2);
    await runValidateHandoff(dir, { handoffId }, at(2), 0.3);
    await hydrate(dir, { handoffId }, deps, at(3), 0.4);

    const all = await readAllEvents(dir);
    const forbidden = all.filter((e) =>
      /^(decision_|task_|session_)/.test(e.frontmatter.type),
    );
    expect(forbidden).toEqual([]);
  });

  it("context_pressure is read-only (computing it writes nothing)", async () => {
    const before = (await readAllEvents(dir)).length;
    computeContextPressure({ estimatedTokenRatio: 0.9, turnCount: 10, wallClockMs: 0, filesTouched: 0 }, [], at(0));
    const after = (await readAllEvents(dir)).length;
    expect(after).toBe(before);
  });
});
