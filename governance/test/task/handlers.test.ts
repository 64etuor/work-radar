import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../../src/mcp/handlers.js";
import { startTask, blockTask, completeTask, cancelTask, listTasks, taskTrail } from "../../src/task/handlers.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const rand = () => (n++ % 16) / 16;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-task-")); n = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("task handlers", () => {
  it("create → start → complete writes 3 immutable events; trail shows ready→active→done", async () => {
    const { id } = await createTask(dir, { description: "Build the thing" }, at(0), 0.1);
    expect((await startTask(dir, { taskId: id }, at(1), 0.2)).ok).toBe(true);
    expect((await completeTask(dir, { taskId: id }, at(2), 0.3)).ok).toBe(true);
    const trail = await taskTrail(dir, { taskId: id });
    expect(trail.phase).toBe("done");
    expect(trail.chain.map((c) => c.type)).toEqual(["task_created", "task_started", "task_completed"]);
  });

  it("NEGATIVE: task commands write ZERO decision_* events", async () => {
    const { id } = await createTask(dir, { description: "t" }, at(0), 0.1);
    await startTask(dir, { taskId: id }, at(1), 0.2);
    await blockTask(dir, { taskId: id, reason: "waiting" }, at(2), 0.3);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type.startsWith("decision_"))).toBe(false);
  });

  it("INVARIANT #1: complete is REFUSED while a related decision_blocked is unresolved, and writes nothing", async () => {
    const { id } = await createTask(dir, { description: "t" }, at(0), 0.1);
    await startTask(dir, { taskId: id }, at(1), 0.2);
    await writeEvent(dir, { frontmatter: { id: "evt_decX", type: "decision_proposed", source: "hermes", actor: "user", tags: ["decision"] }, body: "Fork?" }, at(2));
    await writeEvent(dir, { frontmatter: { id: "evt_blkX", type: "decision_blocked", source: "agent_run", actor: "session:1", tags: ["type0"], related_to: ["evt_decX", id] }, body: '{"question":"q","options":[]}' }, at(3));
    const r = await completeTask(dir, { taskId: id }, at(4), 0.4);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/decision_blocked|escalation/i);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "task_completed")).toBe(false);
  });

  it("listTasks omits terminal tasks", async () => {
    const a = await createTask(dir, { description: "alive" }, at(0), 0.1);
    const b = await createTask(dir, { description: "gone" }, at(1), 0.2);
    await cancelTask(dir, { taskId: b.id }, at(2), 0.3);
    const open = await listTasks(dir);
    expect(open.map((t) => t.taskId)).toEqual([a.id]);
  });
});
