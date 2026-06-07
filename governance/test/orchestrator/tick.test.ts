import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { proposeSpec } from "../../src/spec/handlers.js";
import { escalate } from "../../src/escalate/escalate.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { evaluateReadiness } from "../../src/live/readiness.js";
import type { PreflightSignals } from "../../src/live/preflight.js";
import { runTick, clampMaxSteps, tickExitCode, type TickDeps } from "../../src/orchestrator/tick.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 7, 12, 0, s));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-tick-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ARMED: PreflightSignals = {
  env: {
    CMUX_SOCKET_PATH: "/tmp/c.sock",
    BOULE_CONDUCTOR_MODE: "live",
    BOULE_OBSERVER_MODE: "live",
    BOULE_AUTO_MODE: "type2",
  },
  cmuxBinaryOk: true,
  gitWorktreeOk: true,
};
const ready = (stalledCount = 0) => evaluateReadiness({ signals: ARMED, stalledCount });
const deps = (over: Partial<TickDeps> = {}): TickDeps => ({
  adapter: stubAdapter,
  readiness: ready(),
  autonomyLevel: "dispatch",
  autoMode: "type2",
  maxSteps: 1,
  stalledCount: 0,
  ...over,
});
const tick = (over: Partial<TickDeps> = {}) => runTick(dir, deps(over), at(10), 0.5);

// k seeds distinct timestamps/rand so multiple plans get distinct event ids.
async function activePlan(steps: string[] = ["a"], k = 0): Promise<string> {
  const { planId } = await proposePlan(dir, { intent: `I${k}`, steps }, at(k * 2), 0.1 + k * 0.01);
  await acceptPlan(dir, { planId }, at(k * 2 + 1), 0.2 + k * 0.01);
  return planId;
}
async function boundTaskId(): Promise<string> {
  const all = await readAllEvents(dir);
  const sb = all.find((e) => e.frontmatter.type === "step_bound")!;
  return JSON.parse(sb.body).taskId as string;
}

describe("runTick — gates + bounded conduct + stable outcomes", () => {
  it("infra not ready → infra_failed (exit 1)", async () => {
    const r = await tick({
      readiness: evaluateReadiness({ signals: { ...ARMED, cmuxBinaryOk: false }, stalledCount: 0 }),
    });
    expect(r.outcome).toBe("infra_failed");
    expect(tickExitCode(r.outcome)).toBe(1);
  });

  it("infra ok but posture unsafe (observer not live) → readiness_failed (exit 1)", async () => {
    const r = await tick({
      readiness: evaluateReadiness({
        signals: { ...ARMED, env: { ...ARMED.env, BOULE_OBSERVER_MODE: "" } },
        stalledCount: 0,
      }),
    });
    expect(r.outcome).toBe("readiness_failed");
  });

  it("stalled tasks → stalled (exit 10), never advances", async () => {
    await activePlan();
    const r = await tick({ readiness: ready(2), stalledCount: 2 });
    expect(r.outcome).toBe("stalled");
    expect(r.stalledCount).toBe(2);
    expect(r.conducted).toBe(0);
    expect(tickExitCode(r.outcome)).toBe(10);
  });

  it("open decision_blocked → halted_decision (exit 10), refuses to advance", async () => {
    const planId = await activePlan(["x", "y"]);
    await tick(); // conduct step 0 (stub) → materializes a task
    const t0 = await boundTaskId();
    await escalate(
      dir,
      { question: "fork?", options: [{ label: "a" }, { label: "b" }], relatedTaskId: t0 },
      at(5),
      0.7,
    );
    const r = await runTick(dir, deps(), at(20), 0.6);
    expect(r.outcome).toBe("halted_decision");
    expect(r.haltedPlans).toContain(planId);
    expect(r.conducted).toBe(0);
    expect(tickExitCode(r.outcome)).toBe(10);
  });

  it("ready + a ready step → advanced (conducted=1, exit 0)", async () => {
    await activePlan();
    const r = await tick();
    expect(r.outcome).toBe("advanced");
    expect(r.conducted).toBe(1);
    expect(tickExitCode(r.outcome)).toBe(0);
  });

  it("no plans → idle (exit 0)", async () => {
    const r = await tick();
    expect(r.outcome).toBe("idle");
    expect(r.conducted).toBe(0);
  });

  it("a running step (active task) → in_flight on the next tick, no re-conduct", async () => {
    await activePlan();
    expect((await tick()).outcome).toBe("advanced"); // tick 1 conducts step 0 (task now active)
    const r = await runTick(dir, deps(), at(20), 0.6); // step 0 still running (stub never completes)
    expect(r.outcome).toBe("in_flight");
    expect(r.conducted).toBe(0);
    expect(tickExitCode(r.outcome)).toBe(0);
  });

  it("an UNACCEPTED draft plan at dispatch → idle, NOT in_flight (locks the no-active-task rule)", async () => {
    await proposePlan(dir, { intent: "I", steps: ["a"] }, at(0), 0.1); // proposed, NOT accepted
    const r = await tick({ autonomyLevel: "dispatch" });
    expect(r.outcome).toBe("idle"); // awaiting human accept = not "running"
    expect(r.conducted).toBe(0);
  });

  it("maxSteps caps total conducts across plans (2 ready plans, max-steps 1 → conduct 1)", async () => {
    await activePlan(["a"], 0);
    await activePlan(["a"], 1);
    const r = await tick({ maxSteps: 1 });
    expect(r.conducted).toBe(1); // the cap held; the other waits for the next tick
  });

  it("autonomyLevel=full auto-accepts spec+plan then advances (no human gate)", async () => {
    const { specId } = await proposeSpec(dir, { title: "S", summary: "s" }, at(0), 0.1);
    await proposePlan(dir, { intent: "I", steps: ["a"], specId }, at(1), 0.2); // NOT accepted
    const r = await tick({ autonomyLevel: "full" });
    expect(r.specsAccepted).toBe(1);
    expect(r.plansAccepted).toBe(1);
    expect(r.outcome).toBe("advanced");
  });

  it("manual/dispatch do NOT auto-accept (an unaccepted plan stays idle)", async () => {
    const { specId } = await proposeSpec(dir, { title: "S", summary: "s" }, at(0), 0.1);
    await proposePlan(dir, { intent: "I", steps: ["a"], specId }, at(1), 0.2); // NOT accepted
    const r = await tick({ autonomyLevel: "dispatch" });
    expect(r.plansAccepted).toBe(0);
    expect(r.conducted).toBe(0);
    expect(r.outcome).toBe("idle"); // not in_flight — the draft has no active task
  });
});

describe("clampMaxSteps / tickExitCode", () => {
  it("clampMaxSteps defaults to 1 and is bounded to a finite ceiling", () => {
    expect(clampMaxSteps(undefined)).toBe(1);
    expect(clampMaxSteps("3")).toBe(3);
    expect(clampMaxSteps("0")).toBe(1); // <1 → 1
    expect(clampMaxSteps("nope")).toBe(1);
    expect(clampMaxSteps("999")).toBe(10); // default ceiling
    expect(clampMaxSteps("999", "3")).toBe(3); // custom ceiling
  });
  it("tickExitCode: 0 ok / 10 needs-human / 1 broken-env", () => {
    expect(tickExitCode("advanced")).toBe(0);
    expect(tickExitCode("idle")).toBe(0);
    expect(tickExitCode("in_flight")).toBe(0);
    expect(tickExitCode("halted_decision")).toBe(10);
    expect(tickExitCode("stalled")).toBe(10);
    expect(tickExitCode("readiness_failed")).toBe(1);
    expect(tickExitCode("infra_failed")).toBe(1);
  });
});
