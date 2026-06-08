import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { completeTask } from "../../src/task/handlers.js";
import { escalate } from "../../src/escalate/escalate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const deps = { adapter: stubAdapter };

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-cond-neg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function taskIdForStep(all: GovEvent[], text: string): Promise<string> {
  return all.find((e) => e.frontmatter.type === "task_created" && e.body === text)!.frontmatter.id;
}

describe("ZERO-VERDICT isolation (done-criteria #6)", () => {
  it("a full conduct run emits ONLY task_*/step_bound/session_spawned/attempt hints — ZERO decision_* events", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load X", steps: ["step a", "step b"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);

    // conduct step 0, complete it, conduct step 1, complete it — a full two-step run.
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const t0 = await taskIdForStep(await readAllEvents(dir), "step a");
    await completeTask(dir, { taskId: t0 }, at(30), 0.4);
    await conductPlan(dir, { planId }, deps, at(50), 0.5);
    const t1 = await taskIdForStep(await readAllEvents(dir), "step b");
    await completeTask(dir, { taskId: t1 }, at(70), 0.6);

    const all = await readAllEvents(dir);
    // the conductor itself never authors a decision_* event.
    const conductorAuthored = all.filter((e) => e.frontmatter.actor === "conductor");
    expect(conductorAuthored.some((e) => e.frontmatter.type.startsWith("decision_"))).toBe(false);
    // every conductor event is in the verdict-free whitelist.
    const allowed = new Set([
      "task_created",
      "task_started",
      "step_bound",
      "session_spawned",
      "executor_attempt_started",
    ]);
    expect(conductorAuthored.every((e) => allowed.has(e.frontmatter.type))).toBe(true);
  });
});

describe("STRUCTURAL: src/conductor/** imports no decision write handlers (done-criteria #6)", () => {
  it("no conductor source file imports decision/handlers", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const conductorDir = join(here, "..", "..", "src", "conductor");
    const files = (await readdir(conductorDir)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = await readFile(join(conductorDir, f), "utf8");
      expect(src, `${f} must not import decision write handlers`).not.toMatch(
        /from\s+["'][^"']*decision\/handlers/,
      );
    }
  });
});

describe("COMPLETE-COUPLING: completeTask refused while a step's block is open (done-criteria #5)", () => {
  it("Phase-A canComplete (reused unchanged) refuses completion over the conductor session's open fork", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load X", steps: ["step a"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const t0 = await taskIdForStep(await readAllEvents(dir), "step a");

    // the spawned session escalates with relatedTaskId → decision_blocked binds t0
    await escalate(
      dir,
      { question: "fork?", options: [{ label: "x" }, { label: "y" }], actor: "stub-0", relatedTaskId: t0 },
      at(20), 0.4,
    );

    const r = await completeTask(dir, { taskId: t0 }, at(40), 0.5);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/decision_blocked|escalation/i);
  });
});
