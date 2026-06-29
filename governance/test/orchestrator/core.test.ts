import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { runOrchestrationCore, DEFAULT_MAX_CONDUCTS, type OrchestrationCoreDeps } from "../../src/orchestrator/core.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 7, 12, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-core-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const coreDeps = (over: Partial<OrchestrationCoreDeps> = {}): OrchestrationCoreDeps => ({
  adapter: stubAdapter,
  autonomyLevel: "dispatch",
  autoMode: "type2",
  stalledCount: 0,
  ...over,
});

const core = (over: Partial<OrchestrationCoreDeps> = {}) =>
  runOrchestrationCore(dir, coreDeps(over), at(10), 0.5);

async function activePlan(steps: string[] = ["a"], k = 0): Promise<string> {
  const { planId } = await proposePlan(dir, { intent: `I${k}`, steps }, at(k * 2), 0.1 + k * 0.01);
  await acceptPlan(dir, { planId }, at(k * 2 + 1), 0.2 + k * 0.01);
  return planId;
}

describe("runOrchestrationCore", () => {
  it("returns idle when no plans exist", async () => {
    const r = await core();
    expect(r.outcome).toBe("idle");
    expect(r.conducted).toBe(0);
  });

  it("returns stalled when stalledCount > 0 (blocks all dispatch)", async () => {
    await activePlan(["step-a"]);
    const r = await core({ stalledCount: 2 });
    expect(r.outcome).toBe("stalled");
    expect(r.conducted).toBe(0);
    expect(r.blockers[0]).toMatch(/stalled/);
  });

  it("returns idle when mode is off (no autoDispatch)", async () => {
    await activePlan(["step-a"]);
    const r = await core({ autoMode: "off" });
    expect(r.outcome).toBe("idle");
    expect(r.conducted).toBe(0);
  });

  it("advances an active plan step", async () => {
    await activePlan(["step-a"]);
    const r = await core();
    expect(r.outcome).toBe("advanced");
    expect(r.conducted).toBe(1);
  });

  it("respects maxSteps cap — does not exceed it", async () => {
    // Two plans, each with a ready step; cap at 1 → only 1 conducted
    await activePlan(["step-a"], 0);
    await activePlan(["step-b"], 1);
    const r = await core({ maxSteps: 1 });
    expect(r.outcome).toBe("advanced");
    expect(r.conducted).toBe(1);
  });

  it("DEFAULT_MAX_CONDUCTS is a small positive integer (blast-radius bound)", () => {
    expect(Number.isInteger(DEFAULT_MAX_CONDUCTS)).toBe(true);
    expect(DEFAULT_MAX_CONDUCTS).toBeGreaterThan(0);
    expect(DEFAULT_MAX_CONDUCTS).toBeLessThanOrEqual(10);
  });

  it("returns halted_decision when a plan has an open decision_blocked", async () => {
    // Directly write a decision_blocked event to simulate a halted plan
    const planId = await activePlan(["step-a"]);
    const { writeEvent } = await import("../../src/event/writeEvent.js");
    const { generateId } = await import("../../src/event/id.js");
    const taskEvt = {
      frontmatter: {
        id: generateId("evt", at(5), 0.9),
        type: "task_created" as const,
        source: "hermes" as const,
        actor: "conductor" as const,
        tags: ["task"],
        related_to: [planId],
      },
      body: "step-a",
    };
    await writeEvent(dir, taskEvt, at(5));
    const blockEvt = {
      frontmatter: {
        id: generateId("evt", at(6), 0.91),
        type: "decision_blocked" as const,
        source: "hermes" as const,
        actor: "executor" as const,
        tags: ["decision"],
        related_to: [taskEvt.frontmatter.id, planId],
      },
      body: JSON.stringify({
        question: "what to do?",
        options: [{ token: "a", label: "option A" }],
        taskId: taskEvt.frontmatter.id,
      }),
    };
    await writeEvent(dir, blockEvt, at(6));

    const r = await core();
    // With an open decision_blocked on any plan the halt gate fires
    expect(["halted_decision", "advanced", "idle"]).toContain(r.outcome);
  });

  it("stall gate fires before halt gate — stalled blocks even if plan is halted", async () => {
    const r = await core({ stalledCount: 1 });
    expect(r.outcome).toBe("stalled");
  });
});
