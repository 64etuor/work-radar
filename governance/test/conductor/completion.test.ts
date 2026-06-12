import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import {
  completeReportedDone,
  evaluateCompletionGate,
  type EvaluateFn,
  type CompletionDeps,
  type CompletionRunOptions,
} from "../../src/conductor/completion.js";
import { completeTaskTool } from "../../src/mcp/taskCompletion.js";
import { reportTaskDone } from "../../src/task/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { generateId } from "../../src/event/id.js";
import type { GovEvent } from "../../src/event/event.js";
import type { ResolvedPolicy } from "../../src/repo/config.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 8, 12, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-completion-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const passDeps: CompletionDeps = {
  pathExists: async (path) => path.endsWith("/done.txt"),
  runCommand: async () => ({ status: 0 }),
};

const failDeps: CompletionDeps = {
  pathExists: async () => false,
  runCommand: async () => ({ status: 2 }),
};

const evaluatorPolicy: ResolvedPolicy = {
  kind: "work",
  autonomyLevel: "manual",
  autoMode: "off",
  reviewQuorum: 2,
  forbiddenDecisionClasses: [
    "scope",
    "architecture",
    "irreversible-design",
    "security",
    "product-behavior",
    "dependency",
    "data-loss",
  ],
  allowedType2Actions: ["edit", "test", "lint"],
  backends: { evaluator: { chain: [{ provider: "codex", model: "judge" }] } },
};

async function activeStep(
  step: string | { text: string; check?: { command?: string; artifact?: string; kind?: "human" } },
  base = 0,
) {
  const { planId } = await proposePlan(dir, { intent: "I", steps: [step] }, at(base), 0.1);
  await acceptPlan(dir, { planId }, at(base + 1), 0.2);
  const r = await conductPlan(dir, { planId }, { adapter: stubAdapter }, at(base + 10), 0.3);
  const all = await readAllEvents(dir);
  const session = all.find((e) => e.frontmatter.type === "session_spawned")!;
  return { planId, taskId: r.advanced!.taskId, sessionId: session.frontmatter.id };
}

async function crashSession(sessionId: string, second = 21): Promise<void> {
  await seed({
    frontmatter: {
      id: generateId("evt", at(second), 0.5),
      type: "session_crashed",
      source: "system",
      actor: "observer",
      tags: ["session"],
      related_to: [sessionId],
    },
    body: "crashed",
  }, at(second));
}

async function seed(evt: GovEvent, when: Date): Promise<void> {
  await writeEvent(dir, evt, when);
}

function count(type: GovEvent["frontmatter"]["type"], taskId: string, events: GovEvent[]): number {
  return events.filter((e) => e.frontmatter.type === type && e.frontmatter.related_to?.includes(taskId)).length;
}

describe("executor completion hints", () => {
  it("MCP complete_task writes executor_reported_done, NOT task_completed (R6)", async () => {
    const { taskId } = await activeStep("step a");

    const r = await completeTaskTool(dir, { taskId }, at(20), 0.4);

    expect(r.ok).toBe(true);
    const events = await readAllEvents(dir);
    expect(count("executor_reported_done", taskId, events)).toBe(1);
    expect(count("task_completed", taskId, events)).toBe(0);
  });

  it("reportTaskDone records the hint idempotently for the inferred session", async () => {
    const { taskId, sessionId } = await activeStep("step a");

    await reportTaskDone(dir, { taskId }, at(20), 0.4);

    const hint = (await readAllEvents(dir)).find((e) => e.frontmatter.type === "executor_reported_done")!;
    expect(hint.frontmatter.related_to).toEqual([taskId, sessionId]);
    expect(JSON.parse(hint.body)).toMatchObject({ taskId, sessionId });
  });
});

describe("evaluateCompletionGate", () => {
  it("evaluator configured + judge PASS => pass", async () => {
    const seen: string[] = [];
    const evaluate: EvaluateFn = async (req) => {
      seen.push(`${req.backend.provider}:${req.stepPrompt}:${req.worktreeDiff}`);
      return { ok: true, verdict: "pass", rationale: "accepted" };
    };

    const r = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        stepPrompt: "implement slice",
        worktreeDiff: "diff --git a/x b/x",
        worktreePath: "/wt",
      },
      passDeps,
      { policy: evaluatorPolicy, evaluate },
    );

    expect(r.decision).toBe("pass");
    expect(seen).toEqual(["codex:implement slice:diff --git a/x b/x"]);
  });

  it("evaluator configured + judge FAIL + failed deterministic check => needs_human", async () => {
    const evaluate: EvaluateFn = async () => ({ ok: true, verdict: "fail", rationale: "missing acceptance" });

    const r = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        stepPrompt: "implement slice",
        check: { command: "pnpm test" },
        worktreeDiff: "diff",
        worktreePath: "/wt",
      },
      failDeps,
      { policy: evaluatorPolicy, evaluate },
    );

    expect(r.decision).toBe("needs_human");
  });

  it("evaluator chain exhausted (all token_exhausted) => needs_human, not pass", async () => {
    const evaluate: EvaluateFn = async () => ({ ok: false, error: { kind: "token_exhausted" } });

    const r = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        stepPrompt: "implement slice",
        worktreeDiff: "diff",
        worktreePath: "/wt",
      },
      passDeps,
      { policy: evaluatorPolicy, evaluate },
    );

    expect(r.decision).toBe("needs_human");
  });

  it("hint + terminal + satisfied check => pass", async () => {
    const r = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        check: { artifact: "done.txt" },
        worktreePath: "/wt",
      },
      passDeps,
    );
    expect(r.decision).toBe("pass");
  });

  it("hint + terminal + NO check => needs_human, not pass (R5)", async () => {
    const r = await evaluateCompletionGate(
      { taskId: "t", sessionId: "s", taskActive: true, sessionTerminal: true, hasHint: true, worktreePath: "/wt" },
      passDeps,
    );
    expect(r.decision).toBe("needs_human");
  });

  it("hint + terminal + command nonzero / artifact missing => needs_human (R5)", async () => {
    const command = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        check: { command: "pnpm test" },
        worktreePath: "/wt",
      },
      failDeps,
    );
    const artifact = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        check: { artifact: "done.txt" },
        worktreePath: "/wt",
      },
      failDeps,
    );
    expect(command.decision).toBe("needs_human");
    expect(artifact.decision).toBe("needs_human");
  });

  it("no hint, or session not terminal => wait with no completion attempt", async () => {
    let attempts = 0;
    const evaluate: EvaluateFn = async () => {
      attempts++;
      return { ok: true, verdict: "pass", rationale: "accepted" };
    };
    const noHint = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: false,
        check: { artifact: "done.txt" },
        worktreePath: "/wt",
      },
      passDeps,
      { policy: evaluatorPolicy, evaluate },
    );
    const running = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: false,
        hasHint: true,
        check: { artifact: "done.txt" },
        worktreePath: "/wt",
      },
      passDeps,
      { policy: evaluatorPolicy, evaluate },
    );
    expect(noHint.decision).toBe("wait");
    expect(running.decision).toBe("wait");
    expect(attempts).toBe(0);
  });
});

describe("completeReportedDone", () => {
  it("evaluator configured + judge PASS => writes task_completed", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6, {
      policy: evaluatorPolicy,
      evaluate: async () => ({ ok: true, verdict: "pass", rationale: "accepted" }),
      readWorktreeDiff: async () => "diff",
    });

    expect(r.completed).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(1);
  });

  it("evaluator configured + judge FAIL + no check => needs_human, task stays open", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6, {
      policy: evaluatorPolicy,
      evaluate: async () => ({ ok: true, verdict: "fail", rationale: "missing acceptance" }),
      readWorktreeDiff: async () => "diff",
    });

    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("evaluator chain exhausted => needs_human, task stays open", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6, {
      policy: evaluatorPolicy,
      evaluate: async () => ({ ok: false, error: { kind: "token_exhausted" } }),
      readWorktreeDiff: async () => "diff",
    });

    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("hint + terminal + satisfied check => writes task_completed", async () => {
    const { taskId, sessionId } = await activeStep({ text: "step a", check: { artifact: "done.txt" } });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6);

    expect(r.completed).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(1);
  });

  it("hint + terminal + NO check => needs_human, task stays open (R5)", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6);

    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("pass + chaining dep => commits step output (plan branch) before task_completed", async () => {
    const { planId, taskId, sessionId } = await activeStep({
      text: "step a",
      check: { artifact: "done.txt" },
    });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const commits: Array<{ worktreePath: string; planId: string; stepIndex: number }> = [];
    const deps: CompletionDeps = {
      ...passDeps,
      commitStepOutput: async (input) => {
        commits.push(input);
        return { ok: true, committed: true };
      },
    };
    const r = await completeReportedDone(dir, deps, at(30), 0.6);

    expect(r.completed).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(1);
    expect(commits).toEqual([
      { worktreePath: expect.stringContaining("-step0"), planId, stepIndex: 0 },
    ]);
  });

  it("pass + clean tree (committed:false) => task still completes", async () => {
    const { taskId, sessionId } = await activeStep({
      text: "step a",
      check: { artifact: "done.txt" },
    });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const deps: CompletionDeps = {
      ...passDeps,
      commitStepOutput: async () => ({ ok: true, committed: false }),
    };
    const r = await completeReportedDone(dir, deps, at(30), 0.6);

    expect(r.completed).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(1);
  });

  it("pass + chain commit FAILURE => needs_human, task stays open (fail-closed)", async () => {
    const { taskId, sessionId } = await activeStep({
      text: "step a",
      check: { artifact: "done.txt" },
    });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const deps: CompletionDeps = {
      ...passDeps,
      commitStepOutput: async () => ({ ok: false, error: "git commit failed" }),
    };
    const r = await completeReportedDone(dir, deps, at(30), 0.6);

    expect(r.completed).toBe(0);
    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("needs_human carries the per-task diagnosis (taskId/step/check/reason)", async () => {
    const { planId, taskId, sessionId } = await activeStep({
      text: "step a",
      check: { command: "pnpm test" },
    });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, failDeps, at(30), 0.6);

    expect(r.needsHuman).toBe(1);
    expect(r.needsHumanDetails).toEqual([
      {
        planId,
        stepIndex: 0,
        taskId,
        reason: expect.any(String),
        checkCommand: "pnpm test",
      },
    ]);
  });

  it("hint + terminal + failed check => needs_human, task stays open (R5)", async () => {
    const { taskId, sessionId } = await activeStep({ text: "step a", check: { command: "pnpm test" } });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, failDeps, at(30), 0.6);

    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("no hint, or session not terminal => no completion attempt", async () => {
    const noHint = await activeStep({ text: "step a", check: { artifact: "done.txt" } });
    await crashSession(noHint.sessionId);
    const noHintResult = await completeReportedDone(dir, passDeps, at(30), 0.6);

    const running = await activeStep({ text: "step b", check: { artifact: "done.txt" } }, 60);
    await reportTaskDone(dir, { taskId: running.taskId }, at(80), 0.7);
    const runningResult = await completeReportedDone(dir, passDeps, at(50), 0.8);

    const events = await readAllEvents(dir);
    expect(noHintResult.completed).toBe(0);
    expect(runningResult.completed).toBe(0);
    expect(count("task_completed", noHint.taskId, events)).toBe(0);
    expect(count("task_completed", running.taskId, events)).toBe(0);
  });

  it("idempotency: second pass does not double-write task_completed", async () => {
    const { taskId, sessionId } = await activeStep({ text: "step a", check: { artifact: "done.txt" } });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    expect((await completeReportedDone(dir, passDeps, at(30), 0.6)).completed).toBe(1);
    expect((await completeReportedDone(dir, passDeps, at(40), 0.7)).completed).toBe(0);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(1);
  });

  it("idempotency: evaluator pass does not double-write task_completed", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const opts: CompletionRunOptions = {
      policy: evaluatorPolicy,
      evaluate: async () => ({ ok: true, verdict: "pass", rationale: "accepted" }),
      readWorktreeDiff: async () => "diff",
    };
    expect((await completeReportedDone(dir, passDeps, at(30), 0.6, opts)).completed).toBe(1);
    expect((await completeReportedDone(dir, passDeps, at(40), 0.7, opts)).completed).toBe(0);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(1);
  });
});

describe("explicit human certification — check:{kind:'human'} (P2a)", () => {
  it("gate: kind:human => needs_human and the LLM evaluator is NEVER consulted (machine cannot certify)", async () => {
    let invoked = 0;
    const evaluate: EvaluateFn = async () => {
      invoked++;
      return { ok: true, verdict: "pass", rationale: "would have passed" };
    };
    const r = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        check: { kind: "human" },
        worktreePath: "/wt",
      },
      passDeps,
      { policy: evaluatorPolicy, evaluate },
    );
    expect(r.decision).toBe("needs_human");
    expect(r.reason).toContain("human");
    expect(invoked).toBe(0);
  });

  it("completeReportedDone: a kind:human step parks at needs_human with the explicit-human reason", async () => {
    const { taskId, sessionId } = await activeStep({ text: "review docs", check: { kind: "human" } });
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6);

    expect(r.needsHuman).toBe(1);
    expect(r.needsHumanDetails[0]!.reason).toContain("human certification");
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });
});

describe("fail-closed evaluator negative paths (INVARIANT #1 critical — never a silent pass)", () => {
  it("gate: evaluator THROWING => needs_human, not an exception, not a pass", async () => {
    const evaluate: EvaluateFn = async () => {
      throw new Error("judge exploded");
    };
    const r = await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        stepPrompt: "implement slice",
        worktreeDiff: "diff",
        worktreePath: "/wt",
      },
      passDeps,
      { policy: evaluatorPolicy, evaluate },
    );
    expect(r.decision).toBe("needs_human");
  });

  it("completeReportedDone: evaluator throwing => needs_human, task stays open", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6, {
      policy: evaluatorPolicy,
      evaluate: async () => {
        throw new Error("spawn ENOENT");
      },
      readWorktreeDiff: async () => "diff",
    });

    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("completeReportedDone: evaluator fatal (unparseable judge output) => needs_human, task stays open", async () => {
    const { taskId, sessionId } = await activeStep("step a");
    await reportTaskDone(dir, { taskId }, at(20), 0.4);
    await crashSession(sessionId);

    const r = await completeReportedDone(dir, passDeps, at(30), 0.6, {
      policy: evaluatorPolicy,
      evaluate: async () => ({ ok: false, error: { kind: "fatal", detail: "no JSON in output" } }),
      readWorktreeDiff: async () => "diff",
    });

    expect(r.needsHuman).toBe(1);
    expect(count("task_completed", taskId, await readAllEvents(dir))).toBe(0);
  });

  it("gate passes the step's check + worktree path through to the evaluator request", async () => {
    let seen: { check?: unknown; worktreePath?: unknown } | null = null;
    const evaluate: EvaluateFn = async (req) => {
      seen = { check: req.check, worktreePath: req.worktreePath };
      return { ok: true, verdict: "pass", rationale: "ok" };
    };
    await evaluateCompletionGate(
      {
        taskId: "t",
        sessionId: "s",
        taskActive: true,
        sessionTerminal: true,
        hasHint: true,
        check: { command: "pnpm test" },
        worktreePath: "/wt/step0",
      },
      failDeps,
      { policy: evaluatorPolicy, evaluate },
    );
    expect(seen).toEqual({ check: { command: "pnpm test" }, worktreePath: "/wt/step0" });
  });
});
