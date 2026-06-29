import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan, conductorStatus } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { evaluateReadiness } from "../../src/live/readiness.js";
import type { PreflightSignals } from "../../src/live/preflight.js";
import { runTick, type TickDeps } from "../../src/orchestrator/tick.js";
import { runOrchestrationCore, type OrchestrationCoreDeps } from "../../src/orchestrator/core.js";
import { listStalledTasks } from "../../src/orchestrator/stall.js";
import { acquireTickLock } from "../../src/orchestrator/tickLock.js";

// End-to-end integration: prove the P0/P1 design actually behaves as designed — NOT just that the
// units compile. The single dispatch authority (runOrchestrationCore) must drive both tick and MCP
// auto_dispatch identically; the real TTL stall path must block dispatch; the tick lock must
// prevent a second conductor from running concurrently.

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 7, 12, 0, s));
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-integ-"));
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

const tickDeps = (over: Partial<TickDeps> = {}): TickDeps => ({
  adapter: stubAdapter,
  readiness: evaluateReadiness({ signals: ARMED, stalledCount: over.stalledCount ?? 0 }),
  autonomyLevel: "dispatch",
  autoMode: "type2",
  maxSteps: 1,
  stalledCount: 0,
  ...over,
});

const coreDeps = (over: Partial<OrchestrationCoreDeps> = {}): OrchestrationCoreDeps => ({
  adapter: stubAdapter,
  autonomyLevel: "dispatch",
  autoMode: "type2",
  maxSteps: 1,
  stalledCount: 0,
  ...over,
});

async function activePlan(ws: string): Promise<string> {
  const { planId } = await proposePlan(ws, { intent: "ship it", steps: ["step a"] }, at(0), 0.1);
  await acceptPlan(ws, { planId }, at(1), 0.2);
  return planId;
}

describe("orchestration design — end to end", () => {
  it("single authority: tick and runOrchestrationCore advance an accepted plan identically", async () => {
    // Two identical fresh workspaces — one driven by the tick CLI path, one by the core directly.
    const dirA = await mkdtemp(join(tmpdir(), "boule-integ-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "boule-integ-b-"));
    try {
      const planA = await activePlan(dirA);
      const planB = await activePlan(dirB);

      const tickReport = await runTick(dirA, tickDeps(), at(10), 0.5);
      const coreReport = await runOrchestrationCore(dirB, coreDeps(), at(10), 0.5);

      // Same outcome + same conduct count from both entry points.
      expect(tickReport.outcome).toBe("advanced");
      expect(coreReport.outcome).toBe("advanced");
      expect(tickReport.conducted).toBe(1);
      expect(coreReport.conducted).toBe(1);

      // And both materialized step 0 into an active task (the projection matches).
      const sA = await conductorStatus(dirA, { planId: planA });
      const sB = await conductorStatus(dirB, { planId: planB });
      expect(sA.steps[0]!.taskPhase).toBe("active");
      expect(sB.steps[0]!.taskPhase).toBe("active");
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it("TTL stall blocks dispatch end-to-end (real listStalledTasks, not a synthetic count)", async () => {
    const planId = await activePlan(dir);
    // Conduct once → spawns a session (phase 'opening', task 'active').
    const first = await runOrchestrationCore(dir, coreDeps(), at(10), 0.5);
    expect(first.outcome).toBe("advanced");
    expect((await conductorStatus(dir, { planId })).steps[0]!.taskPhase).toBe("active");

    // 'now' two hours later → the spawned session exceeds the 30-min TTL with no terminal event.
    const now = new Date(at(10).getTime() + 2 * HOUR);
    const stalled = await listStalledTasks(dir, now);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]!.reason).toBe("session_timeout");

    // Feeding that real count into the core blocks ALL further dispatch (gate 1).
    const blocked = await runOrchestrationCore(
      dir,
      coreDeps({ stalledCount: stalled.length }),
      now,
      0.6,
    );
    expect(blocked.outcome).toBe("stalled");
    expect(blocked.conducted).toBe(0);

    // Control: without the stall count the core would NOT be blocked by gate 1 (proves the test
    // discriminates — the stall gate is what stops it, not some other gate). It reports in_flight
    // because the conducted step's task is still active.
    const notBlocked = await runOrchestrationCore(dir, coreDeps({ stalledCount: 0 }), now, 0.6);
    expect(notBlocked.outcome).not.toBe("stalled");
  });

  it("tick lock is mutually exclusive — a second conductor cannot run concurrently", async () => {
    // Simulates a running `boule tick` holding the lock; MCP auto_dispatch acquires the SAME lock
    // and must back off rather than double-conduct.
    const held = await acquireTickLock(dir, at(10));
    expect(held.acquired).toBe(true);

    const second = await acquireTickLock(dir, at(11));
    expect(second.acquired).toBe(false); // auto_dispatch would skip here

    if (held.acquired) await held.release();

    // After release the lock is free again.
    const third = await acquireTickLock(dir, at(12));
    expect(third.acquired).toBe(true);
    if (third.acquired) await third.release();
  });

  it("halt gate: an accepted plan with no ready work stays idle, never spuriously conducts", async () => {
    // A plan whose only step was already conducted has no further ready step → idle/in_flight,
    // never a second spurious conduct (the cursor/in-flight guard inside the core).
    await activePlan(dir);
    await runOrchestrationCore(dir, coreDeps(), at(10), 0.5); // conduct step 0
    const again = await runOrchestrationCore(dir, coreDeps(), at(20), 0.6);
    expect(again.conducted).toBe(0); // step 0 is in-flight; nothing new to conduct
    expect(["in_flight", "idle"]).toContain(again.outcome);
  });
});
