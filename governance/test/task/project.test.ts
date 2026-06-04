import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../../src/mcp/handlers.js";
import { startTask, blockTask, completeTask } from "../../src/task/handlers.js";
import { projectTasks, renderTasks } from "../../src/task/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const rand = () => (n++ % 16) / 16;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-proj-")); n = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function seed() {
  const a = await createTask(dir, { description: "alpha" }, at(0), 0.1);
  await startTask(dir, { taskId: a.id }, at(1), 0.2);
  const b = await createTask(dir, { description: "beta" }, at(2), 0.3);
  await startTask(dir, { taskId: b.id }, at(3), 0.4);
  await blockTask(dir, { taskId: b.id, reason: "x" }, at(4), 0.5);
  return { a, b };
}

describe("task projector", () => {
  it("projectTasks is pure: no I/O, emits no events, stable across calls", async () => {
    await seed();
    const all = await readAllEvents(dir);
    const before = all.length;
    const r1 = projectTasks(all);
    const r2 = projectTasks(all);
    expect(r1).toEqual(r2);
    expect((await readAllEvents(dir)).length).toBe(before); // projecting wrote nothing
  });

  it("KEYSTONE: wipe state/ and re-render → byte-identical (projection = f(events))", async () => {
    await seed();
    const p = await renderTasks(dir);
    const first = await readFile(p, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    const p2 = await renderTasks(dir);
    const second = await readFile(p2, "utf8");
    expect(second).toBe(first);
  });

  it("projection reflects derived phases", async () => {
    const { a, b } = await seed();
    await completeTask(dir, { taskId: a.id }, at(5), 0.6);
    const states = projectTasks(await readAllEvents(dir));
    const byId = Object.fromEntries(states.map((s) => [s.taskId, s.phase]));
    expect(byId[a.id]).toBe("done");
    expect(byId[b.id]).toBe("blocked");
  });
});
