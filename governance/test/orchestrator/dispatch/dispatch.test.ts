import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubAdapter, type ConductorAdapter, type SpawnSessionSpec } from "../../../src/conductor/adapter.js";
import { canApprove } from "../../../src/decision/guardian.js";
import { readAllEvents } from "../../../src/decision/readEvents.js";
import { generateId } from "../../../src/event/id.js";
import type { GovEvent } from "../../../src/event/event.js";
import { writeEvent } from "../../../src/event/writeEvent.js";
import { autoDispatch } from "../../../src/orchestrator/dispatch/dispatch.js";
import type { BackendSpec } from "../../../src/backends/config.js";
import type { PriceTable } from "../../../src/backends/budget.js";
import type { ResolvedPolicy } from "../../../src/repo/config.js";

const RAND = 0.42;
let ws: string;
let seedSec = 0;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-dispatch-"));
  seedSec = 0;
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function at(): Date {
  return new Date(Date.UTC(2026, 5, 3, 0, 0, seedSec++));
}

function later(): Date {
  return new Date(Date.UTC(2026, 5, 3, 0, 1, seedSec++));
}

async function seed(evt: GovEvent, when: Date): Promise<void> {
  await writeEvent(ws, evt, when);
}

async function seedAcceptedPlan(steps: string[]): Promise<string> {
  const when = at();
  const planId = generateId("evt", when, RAND);
  await seed({
    frontmatter: {
      id: planId,
      type: "plan_proposed",
      source: "hermes",
      actor: "planner",
      tags: ["plan"],
      related_to: [],
    },
    body: ["intent line", "", ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n"),
  }, when);
  const acceptedAt = at();
  await seed({
    frontmatter: {
      id: generateId("evt", acceptedAt, RAND),
      type: "plan_accepted",
      source: "hermes",
      actor: "user",
      tags: ["plan"],
      related_to: [planId],
    },
    body: `Human accepted ${planId}`,
  }, acceptedAt);
  return planId;
}

const BASE_POLICY: ResolvedPolicy = {
  kind: "work",
  autonomyLevel: "manual",
  autoMode: "off",
  reviewQuorum: 2,
  forbiddenDecisionClasses: ["scope"],
  allowedType2Actions: ["edit", "test", "lint"],
};

function policyWithExecutor(chain: BackendSpec[], extra: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
  return {
    ...BASE_POLICY,
    ...extra,
    backends: { executor: { chain } },
  };
}

function recordingAdapter(spawns: SpawnSessionSpec[]): ConductorAdapter {
  return {
    ...stubAdapter,
    async spawnSession(spec: SpawnSessionSpec) {
      spawns.push(spec);
      return { surface: `stub-${spec.stepIndex}-attempt${spec.attemptIndex ?? 0}` };
    },
  };
}

function viableAll() {
  return {
    commandExists: () => true,
    codexAuthAvailable: () => true,
    ensureCleanCodexHome: () => true,
  };
}

function nonViableClaude() {
  return {
    commandExists: (cmd: string) => cmd !== "claude",
    codexAuthAvailable: () => true,
    ensureCleanCodexHome: () => true,
  };
}

async function taskIdOfStep(stepText: string): Promise<string> {
  return (await readAllEvents(ws)).find(
    (e) => e.frontmatter.type === "task_created" && e.body === stepText,
  )!.frontmatter.id;
}

async function recordAttemptFinished(input: {
  taskId: string;
  attemptIndex: number;
  outcomeClass: "ok" | "token_exhausted" | "transient" | "fatal";
  worktreeDirty?: boolean;
}): Promise<void> {
  const when = later();
  await seed({
    frontmatter: {
      id: generateId("evt", when, RAND),
      type: "executor_attempt_finished",
      source: "agent_run",
      actor: "executor",
      tags: ["task", "attempt-hint"],
      related_to: [input.taskId],
    },
    body: JSON.stringify({
      attemptIndex: input.attemptIndex,
      exitCode: input.outcomeClass === "ok" ? 0 : 1,
      launched: true,
      worktreeDirty: input.worktreeDirty ?? false,
      outcomeClass: input.outcomeClass,
      usage: "unknown",
    }),
  }, when);
}

async function seedTaskCompleted(taskId: string): Promise<void> {
  const when = later();
  await seed({
    frontmatter: {
      id: generateId("evt", when, RAND),
      type: "task_completed",
      source: "hermes",
      actor: "conductor",
      tags: ["task"],
      related_to: [taskId],
    },
    body: `Completed ${taskId}`,
  }, when);
}

async function seedExecutorAttemptStarted(input: {
  taskId: string;
  attemptIndex: number;
  backend: BackendSpec;
}): Promise<void> {
  const when = later();
  await seed({
    frontmatter: {
      id: generateId("evt", when, RAND),
      type: "executor_attempt_started",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor", "attempt-hint"],
      related_to: [input.taskId],
    },
    body: JSON.stringify({
      attemptIndex: input.attemptIndex,
      backend: input.backend,
    }),
  }, when);
}

function typesOf(all: GovEvent[]): string[] {
  return all.map((e) => e.frontmatter.type);
}

describe("autoDispatch", () => {
  it("off mode refuses and emits nothing", async () => {
    await seedAcceptedPlan(["a", "b"]);
    const before = (await readAllEvents(ws)).length;
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "off", at(), RAND);

    expect(summary).toEqual({ executed: 0, failed: 0, denied: 0, skipped: 0 });
    expect((await readAllEvents(ws)).length).toBe(before);
  });

  it("type2 advances an accepted plan one step and records the dispatch trail", async () => {
    await seedAcceptedPlan(["a", "b"]);
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(1);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("instruction_planned");
    expect(t).toContain("orchestrator_action_executed");
    expect(t).toContain("task_created");
    expect(t).toContain("session_spawned");
    expect(t).toContain("task_started");
  });

  it("idempotently avoids rematerializing an in-flight step on a second pass", async () => {
    await seedAcceptedPlan(["a", "b"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const boundBefore = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "step_bound").length;

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(0);
    expect(summary.denied).toBe(1);
    const boundAfter = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "step_bound").length;
    expect(boundAfter).toBe(boundBefore);
  });

  it("does not let orphan instruction_planned poison a step before step_bound materializes", async () => {
    const planId = await seedAcceptedPlan(["a", "b"]);
    const plannedAt = at();
    await seed({
      frontmatter: {
        id: generateId("evt", plannedAt, RAND),
        type: "instruction_planned",
        source: "system",
        actor: "system",
        tags: ["orchestrator", "dispatch"],
        related_to: [planId],
      },
      body: JSON.stringify({ planId, stepIndex: 0 }),
    }, plannedAt);

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(1);
    expect((await readAllEvents(ws)).some((e) => e.frontmatter.type === "step_bound")).toBe(true);
  });

  it("denies a fully-conducted plan with done rather than in_flight", async () => {
    await seedAcceptedPlan(["a"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const taskId = (await readAllEvents(ws)).find((e) => e.frontmatter.type === "task_created")!.frontmatter.id;
    const completedAt = later();
    await seed({
      frontmatter: {
        id: generateId("evt", completedAt, RAND),
        type: "task_completed",
        source: "hermes",
        actor: "conductor",
        tags: ["task"],
        related_to: [taskId],
      },
      body: `Completed ${taskId}`,
    }, completedAt);

    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    const reasons = (await readAllEvents(ws))
      .filter((e) => e.frontmatter.type === "action_denied")
      .map((e) => JSON.parse(e.body).reason);
    expect(reasons).toContain("done");
  });

  it("denies a non-accepted plan without conductor events", async () => {
    const when = at();
    const planId = generateId("evt", when, RAND);
    await seed({
      frontmatter: {
        id: planId,
        type: "plan_proposed",
        source: "hermes",
        actor: "planner",
        tags: ["plan"],
        related_to: [],
      },
      body: "intent\n\n1. a",
    }, when);

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.denied).toBe(1);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("action_denied");
    expect(t).not.toContain("session_spawned");
  });

  it("NEGATIVE #1: a full pass writes zero decision_* events", async () => {
    await seedAcceptedPlan(["a"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    const t = typesOf(await readAllEvents(ws));
    expect(t.filter((x) => x.startsWith("decision_"))).toEqual([]);
  });

  it("HALT-NO-RESOLVE: an open decision_blocked denies with halted and writes no decision_*", async () => {
    await seedAcceptedPlan(["a", "b"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const taskId = (await readAllEvents(ws)).find((e) => e.frontmatter.type === "task_created")!.frontmatter.id;
    const blockedAt = later();
    await seed({
      frontmatter: {
        id: generateId("evt", blockedAt, RAND),
        type: "decision_blocked",
        source: "agent_run",
        actor: "agent_run",
        tags: ["type0"],
        related_to: ["dec_x", taskId],
      },
      body: "needs a human",
    }, blockedAt);
    const before = (await readAllEvents(ws)).length;

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.denied).toBe(1);
    const after = await readAllEvents(ws);
    expect(after.length).toBe(before + 1);
    const denials = after.filter((e) => e.frontmatter.type === "action_denied").map((e) => JSON.parse(e.body));
    expect(denials).toContainEqual(expect.objectContaining({ reason: "halted" }));
    expect(typesOf(after).filter((x) => x.startsWith("decision_")).sort()).toEqual(["decision_blocked"]);
  });

  it("turns a conductPlan adapter throw into orchestrator_action_failed and keeps going", async () => {
    await seedAcceptedPlan(["a"]);
    const throwingAdapter: ConductorAdapter = {
      createWorktree: async () => {
        throw new Error("worktree boom");
      },
      spawnSession: async () => ({ surface: "stub" }),
      writeEnvelopeFile: async () => {},
    };

    const summary = await autoDispatch(ws, { adapter: throwingAdapter }, "type2", at(), RAND);

    expect(summary.failed).toBe(1);
    expect(summary.executed).toBe(0);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("orchestrator_action_failed");
    expect(t).not.toContain("orchestrator_action_executed");
  });

  it("advances two plans in one pass without event id collisions", async () => {
    await seedAcceptedPlan(["a"]);
    await seedAcceptedPlan(["b"]);

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(2);
    const ids = (await readAllEvents(ws)).map((e) => e.frontmatter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults to five conduct executions per pass", async () => {
    for (let i = 0; i < 6; i++) {
      await seedAcceptedPlan([`step ${i}`]);
    }

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(5);
    expect((await readAllEvents(ws)).filter((e) => e.frontmatter.type === "session_spawned")).toHaveLength(5);
  });

  it("LW3: token_exhausted + clean worktree + next viable backend re-dispatches exactly once on the same task without a new step_bound", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-opus-4-1" },
      { provider: "command", command: "codex", model: "external-fallback" },
    ], {
      routing: { executor: { standard: { provider: "codex", model: "gpt-5-codex-max" } } },
    });
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");
    await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass: "token_exhausted" });

    const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    expect(summary.executed).toBe(1);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toMatchObject({ taskId, executor: "codex", attemptIndex: 1 });
    const all = await readAllEvents(ws);
    expect(all.filter((e) => e.frontmatter.type === "step_bound")).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "session_spawned")).toHaveLength(2);
    const attempts = all
      .filter((e) => e.frontmatter.type === "executor_attempt_started" && e.frontmatter.related_to?.includes(taskId))
      .map((e) => JSON.parse(e.body))
      .sort((a, b) => a.attemptIndex - b.attemptIndex);
    expect(attempts).toEqual([
      { attemptIndex: 0, backend: { provider: "codex", model: "gpt-5-codex-max" } },
      { attemptIndex: 1, backend: { provider: "command", model: "external-fallback" } },
    ]);
    expect(typesOf(all)).not.toContain("task_completed");
    expect(typesOf(all).filter((x) => x.startsWith("decision_"))).toEqual([]);
  });

  it("LW3 double-exec guard: token_exhausted + dirty worktree stalls instead of re-dispatching", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-opus-4-1" },
    ]);
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");
    await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass: "token_exhausted", worktreeDirty: true });

    const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    expect(summary.failed).toBe(1);
    expect(spawns).toHaveLength(1);
    const all = await readAllEvents(ws);
    expect(all.filter((e) => e.frontmatter.type === "executor_attempt_started")).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "task_blocked" && e.frontmatter.related_to?.includes(taskId))).toHaveLength(1);
    expect(
      all.some((e) => e.frontmatter.type === "orchestrator_action_failed" && JSON.parse(e.body).reason === "executor:stall"),
    ).toBe(true);
    expect(typesOf(all)).not.toContain("task_completed");
    expect(typesOf(all).filter((x) => x.startsWith("decision_"))).toEqual([]);
  });

  it("LW3: token_exhausted at the last backend stalls human-pending without spawning or completing", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([{ provider: "codex", model: "gpt-5-codex-max" }]);
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");
    await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass: "token_exhausted" });

    const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    expect(summary.failed).toBe(1);
    expect(spawns).toHaveLength(1);
    const all = await readAllEvents(ws);
    expect(all.filter((e) => e.frontmatter.type === "task_blocked" && e.frontmatter.related_to?.includes(taskId))).toHaveLength(1);
    expect(typesOf(all)).not.toContain("task_completed");
    expect(typesOf(all).filter((x) => x.startsWith("decision_"))).toEqual([]);
  });

  it("LW3: token_exhausted + clean worktree stalls when the exact next backend is not viable", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-opus-4-1" },
    ], {
      routing: { executor: { standard: { provider: "codex", model: "gpt-5-codex-max" } } },
    });
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");
    await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass: "token_exhausted" });

    const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: nonViableClaude() }, "type2", at(), RAND);

    expect(summary.failed).toBe(1);
    expect(spawns).toHaveLength(1);
    const all = await readAllEvents(ws);
    expect(all.filter((e) => e.frontmatter.type === "task_blocked" && e.frontmatter.related_to?.includes(taskId))).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "executor_attempt_started")).toHaveLength(1);
    expect(typesOf(all)).not.toContain("task_completed");
  });

  it.each(["transient", "fatal", "ok"] as const)(
    "LW3: %s executor outcomes never trigger provider re-dispatch",
    async (outcomeClass) => {
      await seedAcceptedPlan(["step a"]);
      const spawns: SpawnSessionSpec[] = [];
      const policy = policyWithExecutor([
        { provider: "codex", model: "gpt-5-codex-max" },
        { provider: "claude", model: "claude-opus-4-1" },
      ]);
      await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
      const taskId = await taskIdOfStep("step a");
      await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass });

      const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

      expect(summary.executed).toBe(0);
      expect(spawns).toHaveLength(1);
      const all = await readAllEvents(ws);
      expect(all.filter((e) => e.frontmatter.type === "executor_attempt_started")).toHaveLength(1);
      expect(typesOf(all)).not.toContain("task_completed");
    },
  );

  it("LW3 golden: without a token_exhausted attempt finish, ordinary in-flight dispatch remains unchanged", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-opus-4-1" },
    ]);
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    expect(summary).toMatchObject({ executed: 0, failed: 0, denied: 1 });
    expect(spawns).toHaveLength(1);
    const all = await readAllEvents(ws);
    expect(all.filter((e) => e.frontmatter.type === "step_bound")).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "executor_attempt_started")).toHaveLength(1);
  });

  it("LW3 boundedness: one tick advances at most one attempt and a later tick advances one more, never past chain length", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-sonnet-4-5" },
      { provider: "command", command: "codex", model: "external-stub-1" },
      { provider: "command", command: "codex", model: "external-stub-2" },
    ]);
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");
    await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass: "token_exhausted" });

    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    await recordAttemptFinished({ taskId, attemptIndex: 1, outcomeClass: "token_exhausted" });
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    await recordAttemptFinished({ taskId, attemptIndex: 2, outcomeClass: "token_exhausted" });
    const exhausted = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    expect(exhausted.failed).toBe(1);
    expect(spawns.map((s) => s.attemptIndex ?? 0)).toEqual([0, 1, 2]);
    const attempts = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "executor_attempt_started");
    expect(attempts).toHaveLength(3);
  });

  it("refuses to redispatch when a task has reached the session spawn cap", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor(
      Array.from({ length: 12 }, (_, i) => ({
        provider: i === 0 ? "codex" : "command",
        ...(i === 0 ? {} : { command: "codex" }),
        model: `attempt-${i}`,
      })),
    );
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");

    for (let attemptIndex = 0; attemptIndex < 9; attemptIndex++) {
      await recordAttemptFinished({ taskId, attemptIndex, outcomeClass: "token_exhausted" });
      await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);
    }
    expect(spawns).toHaveLength(10);
    await recordAttemptFinished({ taskId, attemptIndex: 9, outcomeClass: "token_exhausted" });

    const summary = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, viability: viableAll() }, "type2", at(), RAND);

    expect(summary.failed).toBe(1);
    expect(spawns).toHaveLength(10);
    const all = await readAllEvents(ws);
    expect(all.filter((e) => e.frontmatter.type === "session_spawned" && e.frontmatter.related_to?.includes(taskId))).toHaveLength(10);
    expect(
      all.some((e) => e.frontmatter.type === "orchestrator_action_failed" && JSON.parse(e.body).reason === "executor:stall"),
    ).toBe(true);
  });

  it("LW4: autoDispatch feeds reconstructed spend into the second step's executor selection", async () => {
    await seedAcceptedPlan([
      "frontier first <!-- boule:difficulty hard -->",
      "budget pressured second <!-- boule:difficulty hard -->",
    ]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "command", command: "codex", model: "external-small" },
    ]);
    const budget = {
      caps: { runCostCapUsd: 1.21 },
      priceTable: {
        codex: {
          "gpt-5-codex-max": { estimatedTokens: 40_000, costPerStepUsd: 1.2 },
        },
        command: {
          "external-small": { estimatedTokens: 2_000, costPerStepUsd: 0.01 },
        },
      } satisfies PriceTable,
    };

    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, budget, viability: viableAll() }, "type2", at(), RAND);
    expect(spawns[0]!.executor).toBe("codex");
    await seedTaskCompleted(await taskIdOfStep("frontier first"));

    const summary = await autoDispatch(
      ws,
      { adapter: recordingAdapter(spawns), policy, budget, viability: viableAll() },
      "type2",
      at(),
      RAND,
    );

    expect(summary.executed).toBe(1);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toMatchObject({ executor: "codex", attemptIndex: 0 });
    const attempts = (await readAllEvents(ws)).filter(
      (event) => event.frontmatter.type === "executor_attempt_started",
    );
    expect(JSON.parse(attempts[1]!.body).backend).toEqual({
      provider: "command",
      model: "external-small",
    });
  });

  it("LW4: retry re-derivation excludes the task's own reserves so attemptIndex can advance through the chain", async () => {
    await seedAcceptedPlan(["step a"]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-opus-4-1" },
      { provider: "command", command: "codex", model: "external-stub-1" },
      { provider: "command", command: "codex", model: "external-stub-2" },
    ], {
      routing: { executor: { standard: { provider: "codex", model: "gpt-5-codex-max" } } },
    });
    const budget = {
      caps: { runCostCapUsd: 0.8 },
      priceTable: {
        codex: {
          "gpt-5-codex-max": { estimatedTokens: 10_000, costPerStepUsd: 0.4 },
        },
        claude: {
          "claude-opus-4-1": { estimatedTokens: 10_000, costPerStepUsd: 0.4 },
        },
        command: {
          "external-stub-1": { estimatedTokens: 10_000, costPerStepUsd: 0.4 },
          "external-stub-2": { estimatedTokens: 10_000, costPerStepUsd: 0.4 },
        },
      } satisfies PriceTable,
    };

    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, budget, viability: viableAll() }, "type2", at(), RAND);
    const taskId = await taskIdOfStep("step a");
    await recordAttemptFinished({ taskId, attemptIndex: 0, outcomeClass: "token_exhausted" });
    await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, budget, viability: viableAll() }, "type2", at(), RAND);
    await recordAttemptFinished({ taskId, attemptIndex: 1, outcomeClass: "token_exhausted" });
    const third = await autoDispatch(ws, { adapter: recordingAdapter(spawns), policy, budget, viability: viableAll() }, "type2", at(), RAND);

    expect(third.executed).toBe(1);
    expect(spawns.map((spawn) => spawn.attemptIndex ?? 0)).toEqual([0, 1, 2]);
    expect(spawns.map((spawn) => spawn.executor)).toEqual(["codex", "codex", "codex"]);
    expect(typesOf(await readAllEvents(ws))).not.toContain("task_completed");
  });

  it("LW4: retry still stalls fail-closed when unrelated run-level spend exhausts the budget", async () => {
    await seedAcceptedPlan(["step a"]);
    await seedExecutorAttemptStarted({
      taskId: "other_task",
      attemptIndex: 0,
      backend: { provider: "claude", model: "claude-opus-4-1" },
    });
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "codex", model: "gpt-5-codex-max" },
      { provider: "claude", model: "claude-opus-4-1" },
    ]);
    const budget = {
      caps: { runCostCapUsd: 0.8 },
      priceTable: {
        codex: {
          "gpt-5-codex-max": { estimatedTokens: 10_000, costPerStepUsd: 0.4 },
        },
        claude: {
          "claude-opus-4-1": { estimatedTokens: 10_000, costPerStepUsd: 0.8 },
        },
      } satisfies PriceTable,
    };

    const summary = await autoDispatch(
      ws,
      { adapter: recordingAdapter(spawns), policy, budget, viability: viableAll() },
      "type2",
      at(),
      RAND,
    );

    expect(summary.failed).toBe(1);
    expect(spawns).toHaveLength(0);
    expect(typesOf(await readAllEvents(ws))).toContain("orchestrator_action_failed");
  });
});

describe("INVARIANT #1 — structural", () => {
  it("the dispatcher module imports zero decision write handlers", () => {
    const src = readFileSync(new URL("../../../src/orchestrator/dispatch/dispatch.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/decision\/handlers/);
  });

  it("the opt-in flag cannot touch the approval gate", () => {
    const unreviewed = { verdict: null, reviewed: false, phase: "proposed", title: "x" } as Parameters<typeof canApprove>[0];
    expect(canApprove(unreviewed).ok).toBe(false);
    expect(canApprove.length).toBe(1);
  });
});
