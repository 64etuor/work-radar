import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderOrchestrator, listSuggestions } from "../../src/orchestrator/project.js";
import { suggest } from "../../src/orchestrator/suggest.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 14, 0, s));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-orch-proj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body };
}

describe("renderOrchestrator — keystone property", () => {
  it("render is byte-identical after wiping state/ (derived, not authored)", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    const path = await renderOrchestrator(dir);
    const first = await readFile(path, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    await renderOrchestrator(dir);
    const second = await readFile(path, "utf8");
    expect(second).toBe(first);
  });
});

describe("listSuggestions", () => {
  it("returns every emitted suggestion (all open in this slice)", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    await suggest(dir, at(10), 0.1);
    const list = await listSuggestions(dir);
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe("task_needs_session");
    expect(list[0].subject).toBe("evt_t1");
  });
});
