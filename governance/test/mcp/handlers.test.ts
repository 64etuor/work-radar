import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask, status, observations } from "../../src/mcp/handlers.js";

const now = new Date(Date.UTC(2026, 4, 16, 14, 32, 18));
let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "boule-mcp-")); });
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe("createTask", () => {
  it("writes a task_created event and returns its id+path", async () => {
    const r = await createTask(ws, { description: "뉴스 페처 PR B 재개" }, now, 0.64);
    expect(r.id).toBe("evt_20260516_143218_a3d7");
    const days = await readdir(join(ws, "events"));
    expect(days).toContain("2026-05-16");
  });
});

describe("status", () => {
  it("counts recorded events", async () => {
    await createTask(ws, { description: "a" }, now, 0.1);
    await createTask(ws, { description: "b" }, new Date(Date.UTC(2026, 4, 16, 14, 32, 19)), 0.2);
    const s = await status(ws);
    expect(s.eventCount).toBe(2);
  });
});

describe("observations", () => {
  it("returns active patterns (empty in P1)", async () => {
    const o = await observations(ws);
    expect(o.patterns).toEqual([]);
  });
});
