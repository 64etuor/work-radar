import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeEvent } from "../../src/event/writeEvent.js";
import type { GovEvent } from "../../src/event/event.js";

const evt: GovEvent = {
  frontmatter: { id: "evt_20260516_143218_a3d7", type: "task_created", source: "hermes", actor: "user", tags: ["task"] },
  body: "test",
};
const now = new Date(Date.UTC(2026, 4, 16, 14, 32, 18));

let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "boule-")); });

describe("writeEvent", () => {
  it("writes to events/YYYY-MM-DD/HH-MM-SS_<type>.md and returns the path", async () => {
    const p = await writeEvent(ws, evt, now);
    expect(p).toBe(join(ws, "events", "2026-05-16", "14-32-18_task_created.md"));
    const raw = await readFile(p, "utf8");
    expect(raw).toContain("id: evt_20260516_143218_a3d7");
    await rm(ws, { recursive: true, force: true });
  });

  it("is immutable: refuses to overwrite an existing event file", async () => {
    await writeEvent(ws, evt, now);
    await expect(writeEvent(ws, evt, now)).rejects.toThrow(/EEXIST|exist/i);
    await rm(ws, { recursive: true, force: true });
  });
});
