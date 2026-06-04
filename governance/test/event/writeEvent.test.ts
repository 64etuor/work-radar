import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

describe("writeEvent options", () => {
  const harvestEvt: GovEvent = {
    frontmatter: { id: "evt_x", type: "commit_recorded", source: "git", actor: "alice", tags: [] },
    body: "did a thing",
  };
  const at = new Date(Date.UTC(2026, 5, 1, 9, 8, 7));

  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "boule-we-")); });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("appends a disambiguator suffix to the filename", async () => {
    const p = await writeEvent(ws, harvestEvt, at, { disambiguator: "a1b2c3d" });
    expect(p.endsWith("09-08-07_commit_recorded_a1b2c3d.md")).toBe(true);
    expect(p).toContain("/events/2026-06-01/");
  });

  it("routes to an undated day bucket when dayBucket is set", async () => {
    const p = await writeEvent(ws, harvestEvt, new Date(0), { disambiguator: "deadbee", dayBucket: "undated" });
    expect(p).toContain("/events/undated/");
    expect(p.endsWith("00-00-00_commit_recorded_deadbee.md")).toBe(true);
  });

  it("is unchanged with no opts (back-compat) and immutable on re-write", async () => {
    const p = await writeEvent(ws, harvestEvt, at);
    expect(p.endsWith("09-08-07_commit_recorded.md")).toBe(true);
    await expect(writeEvent(ws, harvestEvt, at)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
