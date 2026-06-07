import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { completeTask } from "../../src/task/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { generateId } from "../../src/event/id.js";
import { deriveStalledTasks, listStalledTasks } from "../../src/orchestrator/stall.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 7, 12, 0, s));
const deps = { adapter: stubAdapter };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-stall-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function activePlan(): Promise<string> {
  const { planId } = await proposePlan(
    dir,
    { intent: "X", steps: ["step a", "step b"] },
    at(0),
    0.1,
  );
  await acceptPlan(dir, { planId }, at(1), 0.2);
  return planId;
}

/** Emit a session_crashed for a sessionId (mirrors what the live observer would write). */
async function crashSession(sessionId: string, stamp: Date): Promise<void> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", stamp, 0.9),
      type: "session_crashed",
      source: "system",
      actor: "system",
      tags: ["session", "observer"],
      related_to: [sessionId],
    },
    body: `Crashed ${sessionId}`,
  };
  await writeEvent(dir, evt, stamp);
}

function sessionIdOf(all: GovEvent[]): string {
  return all.find((e) => e.frontmatter.type === "session_spawned")!.frontmatter.id;
}
function taskIdOf(all: GovEvent[], text: string): string {
  return all.find((e) => e.frontmatter.type === "task_created" && e.body === text)!.frontmatter.id;
}

describe("deriveStalledTasks — active task whose session crashed", () => {
  it("surfaces an in-flight task once its bound session crashes", async () => {
    const planId = await activePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all1 = await readAllEvents(dir);
    await crashSession(sessionIdOf(all1), at(20));

    const stalled = deriveStalledTasks(await readAllEvents(dir));
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.taskId).toBe(taskIdOf(all1, "step a"));
    expect(stalled[0]!.taskPhase).toBe("active");
    expect(stalled[0]!.reason).toBe("session_crashed");
  });

  it("does NOT surface a task whose session is alive (no crash)", async () => {
    const planId = await activePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    expect(deriveStalledTasks(await readAllEvents(dir))).toHaveLength(0);
  });

  it("does NOT surface a completed task even if its session later crashes (terminal, not stuck)", async () => {
    const planId = await activePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all1 = await readAllEvents(dir);
    const t0 = taskIdOf(all1, "step a");
    await completeTask(dir, { taskId: t0 }, at(15), 0.4);
    await crashSession(sessionIdOf(all1), at(20));
    expect(deriveStalledTasks(await readAllEvents(dir))).toHaveLength(0);
  });

  it("listStalledTasks reads events and writes nothing", async () => {
    const planId = await activePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    await crashSession(sessionIdOf(await readAllEvents(dir)), at(20));
    const before = (await readAllEvents(dir)).length;
    const stalled = await listStalledTasks(dir);
    expect(stalled).toHaveLength(1);
    expect((await readAllEvents(dir)).length).toBe(before); // read-only
  });
});
