import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestHandoff, draftHandoff, runValidateHandoff } from "../../src/handoff/handlers.js";
import { REQUIRED_SECTIONS } from "../../src/handoff/validate.js";
import { projectHandoffs, renderHandoffs } from "../../src/handoff/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 13, 0, s));
const complete = REQUIRED_SECTIONS.map((h) => `## ${h}\nc`).join("\n\n");

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-handoff-p-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("handoff projector", () => {
  it("projectHandoffs reflects pending phase; renderHandoffs is rebuildable", async () => {
    const { handoffId } = await requestHandoff(dir, { sessionId: "evt_s1" }, at(0), 0.1);
    await draftHandoff(dir, { handoffId, body: complete }, at(1), 0.2);
    await runValidateHandoff(dir, { handoffId }, at(2), 0.3);

    const states = projectHandoffs(await readAllEvents(dir));
    expect(states.find((s) => s.handoffId === handoffId)?.phase).toBe("pending");

    const path = await renderHandoffs(dir);
    const a = await readFile(path, "utf8");
    const b = await readFile(await renderHandoffs(dir), "utf8");
    expect(a).toBe(b); // byte-stable / rebuildable from events
    expect(JSON.parse(a)[0].phase).toBe("pending");
  });
});
