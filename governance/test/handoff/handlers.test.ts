import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  requestHandoff, draftHandoff, runValidateHandoff, consumeHandoff, listHandoffs, handoffTrail,
} from "../../src/handoff/handlers.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\ncontent ${h}`).join("\n\n");

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-handoff-h-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("handoff handlers round-trip", () => {
  it("request → draft(incomplete) → invalid → draft(complete) → pending → consumed", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_session_1" }, at(0), 0.1);

    const bad = await runValidateHandoff(dir, { handoffId }, at(1), 0.2);
    expect(bad.ok).toBe(false); // no draft yet → cannot validate

    await draftHandoff(dir, { handoffId, body: "## Mission\nonly one" }, at(2), 0.3);
    const inv = await runValidateHandoff(dir, { handoffId }, at(3), 0.4);
    expect(inv.ok).toBe(true);
    expect(inv.valid).toBe(false); // structurally invalid → handoff_invalid emitted

    await draftHandoff(dir, { handoffId, body: complete }, at(4), 0.5);
    const ok = await runValidateHandoff(dir, { handoffId }, at(5), 0.6);
    expect(ok.valid).toBe(true); // handoff_validated → pending

    const open = await listHandoffs(dir);
    expect(open.find((h) => h.handoffId === handoffId)?.phase).toBe("pending");

    const con = await consumeHandoff(dir, { handoffId }, at(6), 0.7);
    expect(con.ok).toBe(true);

    const trail = await handoffTrail(dir, { handoffId });
    expect(trail.phase).toBe("consumed");

    // Only handoff_* events were ever written.
    const all = await readAllEvents(dir);
    expect(all.every((e) => e.frontmatter.type.startsWith("handoff_"))).toBe(true);
  });

  it("consume refuses a non-pending handoff", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_session_1" }, at(0), 0.1);
    const r = await consumeHandoff(dir, { handoffId }, at(1), 0.2);
    expect(r.ok).toBe(false);
  });
});
