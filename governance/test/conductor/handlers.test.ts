import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import {
  conductPlan,
  conductorStatus,
  selectViableExecutorBackend,
  type ExecutorViabilityProbes,
} from "../../src/conductor/handlers.js";
import { completeTask } from "../../src/task/handlers.js";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption } from "../../src/decision/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { cmdRecordAttempt } from "../../src/cli/boule.js";
import {
  stubAdapter,
  makeLiveAdapter,
  buildSessionCommand,
  ensureCleanCodexHome,
  parseCmuxRef,
  firstTerminalSurface,
  findGroupRef,
  projectLabelFromRepoRoot,
  SESSION_DENIED_TOOLS,
  type FsLike,
  type SpawnResultLike,
  type SpawnSessionSpec,
} from "../../src/conductor/adapter.js";
import type { BackendChain, BackendSpec } from "../../src/backends/config.js";
import type { ResolvedPolicy } from "../../src/repo/config.js";
import type { GovEvent } from "../../src/event/event.js";

describe("SESSION_DENIED_TOOLS — executor sessions cannot reach the gate-opening tools", () => {
  it("denies every human-gate / orchestrator tool, INCLUDING auto_dispatch (auto-accept path)", () => {
    for (const t of [
      "approve",
      "reject",
      "choose",
      "accept_plan",
      "accept_spec",
      "auto_dispatch",
      "activate_pattern",
      "archive_pattern",
      "archive_prune",
    ]) {
      expect(SESSION_DENIED_TOOLS).toContain(`mcp__boule-governance__${t}`);
    }
  });
  it("the claude executor invocation passes the full denylist (incl. auto_dispatch)", () => {
    const c = buildSessionCommand(
      "claude",
      { worktreePath: "/wt/s0", taskId: "evt_t0" },
      {
        serverEntrypoint: "/install/governance/src/mcp/server.ts",
        governanceWorkspace: "/ws",
        completeEntrypoint: "/install/governance/src/cli/boule.ts",
      },
    );
    expect(c).toContain("mcp__boule-governance__auto_dispatch");
    expect(c).toContain("mcp__boule-governance__accept_plan");
  });
});

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const deps = { adapter: stubAdapter };
const BASE_POLICY: ResolvedPolicy = {
  kind: "work",
  autonomyLevel: "manual",
  autoMode: "off",
  reviewQuorum: 2,
  forbiddenDecisionClasses: ["scope"],
  allowedType2Actions: ["edit", "test", "lint"],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-cond-h-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setupActivePlan(): Promise<string> {
  const { planId } = await proposePlan(
    dir,
    { intent: "Load X", steps: ["step a", "step b"] },
    at(0),
    0.1,
  );
  await acceptPlan(dir, { planId }, at(1), 0.2);
  return planId;
}
async function setupActivePlanWithSteps(
  steps: Parameters<typeof proposePlan>[1]["steps"],
): Promise<string> {
  const { planId } = await proposePlan(dir, { intent: "Load X", steps }, at(0), 0.1);
  await acceptPlan(dir, { planId }, at(1), 0.2);
  return planId;
}
function typesOf(all: GovEvent[]): string[] {
  return all.map((e) => e.frontmatter.type);
}
async function taskIdForStep(all: GovEvent[], text: string): Promise<string> {
  return all.find((e) => e.frontmatter.type === "task_created" && e.body === text)!.frontmatter.id;
}
function policyWithExecutor(
  chain: BackendSpec[],
  extra: Partial<ResolvedPolicy> = {},
): ResolvedPolicy {
  return {
    ...BASE_POLICY,
    ...extra,
    backends: { executor: { chain } },
  };
}
function viableProbes(
  opts: {
    missingCommands?: readonly string[];
    codexAuth?: boolean;
    cleanCodexHome?: boolean;
  } = {},
): ExecutorViabilityProbes {
  const missing = new Set(opts.missingCommands ?? []);
  return {
    commandExists: (cmd) => !missing.has(cmd),
    codexAuthAvailable: () => opts.codexAuth ?? true,
    ensureCleanCodexHome: () => opts.cleanCodexHome ?? true,
  };
}
function recordingAdapter(spawns: SpawnSessionSpec[]) {
  return {
    ...stubAdapter,
    async spawnSession(spec: SpawnSessionSpec) {
      spawns.push(spec);
      return { surface: `stub-${spec.stepIndex}` };
    },
  };
}
function spawnedBodies(all: GovEvent[]): unknown[] {
  return all.filter((e) => e.frontmatter.type === "session_spawned").map((e) => JSON.parse(e.body));
}

describe("conductPlan — accept gate (US-001 / done-criteria #1)", () => {
  it("refuses a draft plan and writes NOTHING", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load X", steps: ["a"] }, at(0), 0.1);
    const r = await conductPlan(dir, { planId }, deps, at(10), 0.3);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/active/i);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "step_bound")).toBe(false);
    expect(all.some((e) => e.frontmatter.type === "session_spawned")).toBe(false);
  });

  it("refuses a needs_revision plan", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load X", steps: ["a"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);
    // revise → needs_revision via plan handler
    const { revisePlan } = await import("../../src/plan/handlers.js");
    await revisePlan(dir, { planId, reason: "scope" }, at(2), 0.3);
    const r = await conductPlan(dir, { planId }, deps, at(10), 0.4);
    expect(r.ok).toBe(false);
  });
});

describe("conductPlan — one step per call (done-criteria #2)", () => {
  it("first call mints exactly task_created+step_bound+session_spawned+task_started for step 0, nothing for step 1", async () => {
    const planId = await setupActivePlan();
    const r = await conductPlan(dir, { planId }, deps, at(10), 0.3);
    expect(r.ok).toBe(true);
    expect(r.advanced!.stepIndex).toBe(0);

    const all = await readAllEvents(dir);
    const conductorMinted = all.filter((e) => e.frontmatter.actor === "conductor");
    expect(typesOf(conductorMinted).sort()).toEqual(
      [
        "executor_attempt_started",
        "session_spawned",
        "step_bound",
        "task_created",
        "task_started",
      ].sort(),
    );
    // exactly ONE task_created (step 0 only) — step 1 not materialized
    expect(all.filter((e) => e.frontmatter.type === "task_created")).toHaveLength(1);

    // distinct chronological ids for the 5 minted events
    const ids = conductorMinted.map((e) => e.frontmatter.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("conductor-minted task uses actor:conductor (NOT user)", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all = await readAllEvents(dir);
    const task = all.find((e) => e.frontmatter.type === "task_created")!;
    expect(task.frontmatter.actor).toBe("conductor");
  });

  it("a second call while step 0 is in-flight (active) advances NOTHING", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const r2 = await conductPlan(dir, { planId }, deps, at(40), 0.4);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/in-flight/i);
    const all = await readAllEvents(dir);
    expect(all.filter((e) => e.frontmatter.type === "task_created")).toHaveLength(1);
  });
});

describe("conductPlan — observe → advance (done-criteria #3)", () => {
  it("after stub task_completed for step 0, the next call materializes step 1 only; cursor 0→1", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all1 = await readAllEvents(dir);
    const t0 = await taskIdForStep(all1, "step a");
    expect((await completeTask(dir, { taskId: t0 }, at(30), 0.4)).ok).toBe(true);

    const st = await conductorStatus(dir, { planId });
    expect(st.cursor).toBe(1);

    const r2 = await conductPlan(dir, { planId }, deps, at(50), 0.5);
    expect(r2.ok).toBe(true);
    expect(r2.advanced!.stepIndex).toBe(1);
    const all2 = await readAllEvents(dir);
    expect(all2.filter((e) => e.frontmatter.type === "task_created")).toHaveLength(2);
  });
});

describe("conductPlan — LW1 pre-flight executor selection", () => {
  it("selects the ideal head from selectExecutorChain when the hard-step backend is viable", async () => {
    const planId = await setupActivePlanWithSteps([{ text: "hard step", difficulty: "hard" }]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor(
      [
        { provider: "codex", model: "gpt-5-codex-max" },
        { provider: "claude", model: "claude-opus-4-1" },
      ],
      {
        routing: { executor: { hard: { provider: "codex", model: "gpt-5-codex-max" } } },
      },
    );

    const r = await conductPlan(
      dir,
      { planId },
      { adapter: recordingAdapter(spawns), policy, viability: viableProbes() },
      at(10),
      0.3,
    );

    expect(r.ok).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.executor).toBe("codex");
  });

  it("falls forward once during pre-flight when the ideal codex backend lacks auth", async () => {
    const planId = await setupActivePlanWithSteps([{ text: "hard step", difficulty: "hard" }]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor(
      [
        { provider: "codex", model: "gpt-5-codex-max" },
        { provider: "claude", model: "claude-opus-4-1" },
      ],
      {
        routing: { executor: { hard: { provider: "codex", model: "gpt-5-codex-max" } } },
      },
    );

    const r = await conductPlan(
      dir,
      { planId },
      {
        adapter: recordingAdapter(spawns),
        policy,
        viability: viableProbes({ codexAuth: false }),
      },
      at(10),
      0.3,
    );

    expect(r.ok).toBe(true);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.executor).toBe("claude");
  });

  it("keeps no-backends configured behavior identical: single claude executor and no selectedBackend audit field", async () => {
    const planId = await setupActivePlanWithSteps([{ text: "legacy step", difficulty: "hard" }]);
    const spawns: SpawnSessionSpec[] = [];

    const r = await conductPlan(
      dir,
      { planId },
      { adapter: recordingAdapter(spawns), policy: BASE_POLICY },
      at(10),
      0.3,
    );

    expect(r.ok).toBe(true);
    expect(spawns[0]!.executor).toBe("claude");
    const all = await readAllEvents(dir);
    expect(spawnedBodies(all)[0]).toEqual({
      surface: "stub-0",
      worktree: expect.stringMatching(
        /^\.boule-worktrees\/stub-evt_20260602_120000_[a-z0-9]+-step0$/,
      ),
      envelopeHash: expect.any(String),
      envelope: expect.objectContaining({ executor: "claude" }),
    });
    expect(spawnedBodies(all)[0]).not.toHaveProperty("selectedBackend");
  });

  it("fails closed when budget filtering returns the executor stall terminal: no spawn and the step remains open", async () => {
    const planId = await setupActivePlanWithSteps([{ text: "over budget", difficulty: "hard" }]);
    const spawns: SpawnSessionSpec[] = [];
    const r = await conductPlan(
      dir,
      { planId },
      {
        adapter: recordingAdapter(spawns),
        policy: policyWithExecutor([{ provider: "claude", model: "claude-opus-4-1" }]),
        budget: {
          caps: { stepCostCapUsd: 0.001 },
          snapshot: { spentTokens: 0, spentCostUsd: 0 },
          priceTable: {
            claude: {
              "claude-opus-4-1": { estimatedTokens: 40_000, costPerStepUsd: 1.2 },
            },
          },
        },
        viability: viableProbes(),
      },
      at(10),
      0.3,
    );

    expect(r).toEqual({ ok: false, reason: "executor:stall", advanced: null });
    expect(spawns).toHaveLength(0);
    expect(await conductorStatus(dir, { planId })).toMatchObject({
      cursor: 0,
      steps: [expect.objectContaining({ taskId: null })],
    });
    expect((await readAllEvents(dir)).some((e) => e.frontmatter.type === "session_spawned")).toBe(
      false,
    );
  });

  it("reconstructs prior reserved spend so the next step downgrades from an unaffordable frontier head", async () => {
    const planId = await setupActivePlanWithSteps([
      { text: "frontier first", difficulty: "hard" },
      { text: "budget pressured second", difficulty: "hard" },
    ]);
    const spawns: SpawnSessionSpec[] = [];
    const policy = policyWithExecutor([
      { provider: "claude", model: "claude-opus-4-1" },
      { provider: "codex", model: "gpt-5-codex-small" },
    ]);
    const budget = {
      caps: { runCostCapUsd: 1.21 },
      priceTable: {
        claude: {
          "claude-opus-4-1": { estimatedTokens: 40_000, costPerStepUsd: 1.2 },
        },
        codex: {
          "gpt-5-codex-small": { estimatedTokens: 2_000, costPerStepUsd: 0.01 },
        },
      },
    };

    const first = await conductPlan(
      dir,
      { planId },
      { adapter: recordingAdapter(spawns), policy, budget, viability: viableProbes() },
      at(10),
      0.3,
    );
    expect(first.ok).toBe(true);
    expect(spawns[0]!.executor).toBe("claude");
    expect((await completeTask(dir, { taskId: first.advanced!.taskId }, at(30), 0.4)).ok).toBe(
      true,
    );

    const second = await conductPlan(
      dir,
      { planId },
      { adapter: recordingAdapter(spawns), policy, budget, viability: viableProbes() },
      at(50),
      0.5,
    );

    expect(second.ok).toBe(true);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.executor).toBe("codex");
    const secondSpawn = spawnedBodies(await readAllEvents(dir))[1];
    expect(secondSpawn).toMatchObject({
      selectedBackend: { provider: "codex", model: "gpt-5-codex-small" },
    });
  });

  it("fails closed when no configured backend is viable: no spawn and no silent completion", async () => {
    const planId = await setupActivePlanWithSteps([
      { text: "no viable executor", difficulty: "hard" },
    ]);
    const spawns: SpawnSessionSpec[] = [];

    const r = await conductPlan(
      dir,
      { planId },
      {
        adapter: recordingAdapter(spawns),
        policy: policyWithExecutor([
          { provider: "codex", model: "gpt-5-codex-max" },
          { provider: "claude", model: "claude-opus-4-1" },
        ]),
        viability: viableProbes({ codexAuth: false, missingCommands: ["claude"] }),
      },
      at(10),
      0.3,
    );

    expect(r).toEqual({ ok: false, reason: "executor:stall", advanced: null });
    expect(spawns).toHaveLength(0);
    expect(typesOf(await readAllEvents(dir))).not.toContain("task_completed");
    expect(await conductorStatus(dir, { planId })).toMatchObject({ cursor: 0 });
  });

  it("records the selected backend in the envelope and session_spawned body", async () => {
    const planId = await setupActivePlanWithSteps([{ text: "audited step", difficulty: "hard" }]);
    const policy = policyWithExecutor([{ provider: "codex", model: "gpt-5-codex-max" }]);

    await conductPlan(
      dir,
      { planId },
      { adapter: stubAdapter, policy, viability: viableProbes() },
      at(10),
      0.3,
    );

    expect(spawnedBodies(await readAllEvents(dir))[0]).toMatchObject({
      selectedBackend: { provider: "codex", model: "gpt-5-codex-max" },
      envelope: {
        executor: "codex",
        selectedBackend: { provider: "codex", model: "gpt-5-codex-max" },
      },
    });
  });

  it("mints executor_attempt_started at spawn with attemptIndex 0 and backend", async () => {
    const planId = await setupActivePlanWithSteps([{ text: "audited step", difficulty: "hard" }]);
    const policy = policyWithExecutor([{ provider: "codex", model: "gpt-5-codex-max" }]);

    await conductPlan(
      dir,
      { planId },
      { adapter: stubAdapter, policy, viability: viableProbes() },
      at(10),
      0.3,
    );

    const all = await readAllEvents(dir);
    const task = all.find((e) => e.frontmatter.type === "task_created")!;
    const attempt = all.find((e) => e.frontmatter.type === "executor_attempt_started")!;
    expect(attempt.frontmatter.related_to).toEqual([task.frontmatter.id]);
    expect(JSON.parse(attempt.body)).toEqual({
      attemptIndex: 0,
      backend: { provider: "codex", model: "gpt-5-codex-max" },
    });
  });

  it("does not redispatch, switch provider, or complete from a token_exhausted attempt hint", async () => {
    const spawns: SpawnSessionSpec[] = [];
    const planId = await setupActivePlan();
    const r1 = await conductPlan(
      dir,
      { planId },
      { adapter: recordingAdapter(spawns) },
      at(10),
      0.3,
    );
    expect(r1.ok).toBe(true);

    await cmdRecordAttempt({
      workspace: dir,
      task: r1.advanced!.taskId,
      attempt: "0",
      "exit-code": "1",
      launched: "true",
      "worktree-dirty": "false",
      "stderr-digest": "usage limit reached",
    });

    const r2 = await conductPlan(
      dir,
      { planId },
      { adapter: recordingAdapter(spawns) },
      at(40),
      0.4,
    );
    expect(r2.ok).toBe(false);
    expect(r2.reason).toMatch(/in-flight/i);
    expect(spawns).toHaveLength(1);

    const all = await readAllEvents(dir);
    expect(all.filter((e) => e.frontmatter.type === "step_bound")).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "session_spawned")).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "task_completed")).toHaveLength(0);
  });

  it("uses only injected probes for viability and is deterministic for repeated inputs", async () => {
    const calls: string[] = [];
    const probes: ExecutorViabilityProbes = {
      commandExists: (cmd) => {
        calls.push(`cmd:${cmd}`);
        return true;
      },
      codexAuthAvailable: () => {
        calls.push("auth");
        return false;
      },
      ensureCleanCodexHome: () => {
        calls.push("clean");
        return false;
      },
    };
    const chain: BackendChain = {
      chain: [
        { provider: "codex", model: "gpt-5-codex-max" },
        { provider: "claude", model: "claude-opus-4-1" },
      ],
    };

    await expect(selectViableExecutorBackend(chain, probes)).resolves.toEqual({
      executor: "claude",
      backend: { provider: "claude", model: "claude-opus-4-1" },
    });
    await expect(selectViableExecutorBackend(chain, probes)).resolves.toEqual({
      executor: "claude",
      backend: { provider: "claude", model: "claude-opus-4-1" },
    });
    expect(calls).toEqual(["cmd:codex", "auth", "cmd:claude", "cmd:codex", "auth", "cmd:claude"]);
  });
});

describe("conductPlan — halt on block (done-criteria #4)", () => {
  it("an open decision_blocked (relatedTaskId) halts; conduct advances nothing; stays halted; unblock advances", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, deps, at(10), 0.3);
    const all1 = await readAllEvents(dir);
    const t0 = await taskIdForStep(all1, "step a");

    // the spawned session escalates, binding its task → decision_blocked.related_to ∋ t0
    const esc = await escalate(
      dir,
      {
        question: "fork?",
        options: [{ label: "x" }, { label: "y" }],
        actor: "stub-0",
        relatedTaskId: t0,
      },
      at(20),
      0.4,
    );

    const stHalted = await conductorStatus(dir, { planId });
    expect(stHalted.halted).toBe(true);

    const rHalt = await conductPlan(dir, { planId }, deps, at(40), 0.5);
    expect(rHalt.ok).toBe(false);
    expect(rHalt.reason).toMatch(/halt/i);
    // stays halted across a second call — no timeout/default path
    expect((await conductPlan(dir, { planId }, deps, at(60), 0.6)).ok).toBe(false);

    // a human choose (actor:user) resolves the fork
    const ch = await chooseOption(
      dir,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      at(70),
      0.7,
    );
    expect(ch.ok).toBe(true);

    // still in-flight (task active, not completed) — conduct still waits, NOT advances a new step
    const stCleared = await conductorStatus(dir, { planId });
    expect(stCleared.halted).toBe(false);

    // complete step 0, THEN conduct advances to step 1
    expect((await completeTask(dir, { taskId: t0 }, at(80), 0.8)).ok).toBe(true);
    const rAdv = await conductPlan(dir, { planId }, deps, at(90), 0.9);
    expect(rAdv.ok).toBe(true);
    expect(rAdv.advanced!.stepIndex).toBe(1);
  });
});

describe("makeLiveAdapter — git + cmux command SEQUENCE (US-005, injected fake spawn, no real processes)", () => {
  it("createWorktree + spawnSession issue git worktree add + cmux new-workspace --command + cmux tree in order", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      // Real cmux contract: `new-workspace` prints `OK workspace:N` on stdout (the legacy-alias
      // notice goes to stderr); the workspace's terminal surface is resolved from `tree --json`.
      if (cmd === "cmux" && args[0] === "new-workspace")
        return { status: 0, stdout: "OK workspace:7\n", stderr: "" };
      if (cmd === "cmux" && args[0] === "tree")
        return {
          status: 0,
          stdout: JSON.stringify({
            windows: [
              {
                workspaces: [
                  {
                    ref: "workspace:7",
                    panes: [{ surfaces: [{ ref: "surface:42", type: "terminal" }] }],
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    const writes: Array<{ path: string; data: string }> = [];
    const fakeFs = {
      mkdir: async () => undefined,
      writeFile: async (path: string, data: string) => {
        writes.push({ path, data });
      },
      pathExists: async () => false,
      symlink: async () => undefined,
      rm: async () => undefined,
    };
    const adapter = makeLiveAdapter({
      spawn: fakeSpawn,
      fs: fakeFs,
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      completeEntrypoint: "/install/governance/src/cli/boule.ts",
      codexAuthPath: "/op/.codex/auth.json",
      env: { OPENAI_API_KEY: "test-codex-key" }, // env auth ⇒ ensureCleanCodexHome skips the symlink
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
    });

    const wt = await adapter.createWorktree({ planId: "evt_p1", stepIndex: 0 });
    expect(wt.path).toBe(".boule-worktrees/boule-evt_p1-step0");
    await adapter.writeEnvelopeFile(
      wt.path,
      {
        planId: "evt_p1",
        stepIndex: 0,
        taskId: "evt_t0",
        worktreePath: wt.path,
        executor: "claude",
        allowedPathGlobs: [],
        allowedType2Actions: [],
        forbiddenDecisionClasses: [],
        escalationTriggers: [],
        escalateOnAnyBoundaryCrossing: true,
      },
      "PROMPT",
    );
    const sess = await adapter.spawnSession({
      worktreePath: wt.path,
      stepIndex: 0,
      taskId: "evt_t0",
      prompt: "PROMPT",
    });
    // surface is the workspace's terminal surface ref (resolved from `tree --json`), NOT the
    // workspace ref — the Observer reconciles live sessions by surface ref.
    expect(sess.surface).toBe("surface:42");

    expect(calls.map((c) => `${c.cmd} ${c.args[0] ?? ""}`)).toEqual([
      "git -C",
      "cmux new-workspace",
      "cmux tree",
    ]);
    expect(calls[0]!.args).toEqual(["-C", "/repo", "worktree", "add", "--detach", wt.path, "HEAD"]);
    // the executor is launched ATOMICALLY at workspace creation via --command (a separate `send`
    // to a background workspace surface fails), and the worktree cwd is bound.
    expect(calls[1]!.args.slice(0, 4)).toEqual(["new-workspace", "--cwd", wt.path, "--command"]);
    expect(calls[2]!.args).toEqual(["tree", "--all", "--json"]);
    // the claude invocation (in the --command arg) runs against the scoped executor-role config
    // + denies verdict tools
    const claudeCmd = calls[1]!.args[4]!;
    expect(claudeCmd).toContain("--mcp-config");
    expect(claudeCmd).toContain("--strict-mcp-config");
    expect(claudeCmd).toContain("--disallowedTools");
    expect(claudeCmd).toContain("mcp__boule-governance__choose");
    expect(claudeCmd).toContain("mcp__boule-governance__approve");
    expect(claudeCmd).toContain(`$(cat ${wt.path}/.boule/step-prompt.md)`);
    // envelope + prompt + scoped MCP config written into the worktree's .boule dir
    expect(writes.map((w) => w.path)).toEqual([
      `${wt.path}/.boule/envelope.json`,
      `${wt.path}/.boule/step-prompt.md`,
      `${wt.path}/.boule/mcp.json`,
    ]);
    const mcpJson = writes.find((w) => w.path.endsWith("mcp.json"))!.data;
    expect(mcpJson).toContain('"BOULE_SESSION_ROLE": "executor"');
    expect(mcpJson).toContain('"BOULE_WORKSPACE": "/repo/governance/workspace"');
    // executor MCP server = the Boule install entrypoint, NOT <repoRoot>/governance (the target
    // repo has no governance/ dir) — this is the per-repo loop-closure fix.
    expect(mcpJson).toContain("/install/governance/src/mcp/server.ts");
    expect(mcpJson).not.toContain("/repo/governance/src/mcp/server.ts");
    // BOULE_REPO_ROOT pins the executor's docs-reading tools to the TARGET repo (not the
    // WORKSPACE-relative default which would point at <repo>/.boule).
    expect(mcpJson).toContain('"BOULE_REPO_ROOT": "/repo"');
  });

  it("surfaces a terminal failure when git exits non-zero (no retry loop)", async () => {
    const fakeSpawn = (): SpawnResultLike => ({ status: 1, stdout: "", stderr: "fatal: boom" });
    const adapter = makeLiveAdapter({
      spawn: fakeSpawn,
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        pathExists: async () => false,
        symlink: async () => undefined,
        rm: async () => undefined,
      },
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      completeEntrypoint: "/install/governance/src/cli/boule.ts",
      codexAuthPath: "/op/.codex/auth.json",
      env: { OPENAI_API_KEY: "test-codex-key" }, // env auth ⇒ ensureCleanCodexHome skips the symlink
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
    });
    await expect(adapter.createWorktree({ planId: "evt_p1", stepIndex: 0 })).rejects.toThrow(
      /failed/i,
    );
  });
});

describe("makeLiveAdapter — per-project cmux folder grouping", () => {
  // fake cmux/git: new-workspace → workspace:7; tree → one terminal surface:42 in workspace:7;
  // workspace-group list → the provided groups; everything else → ok. Records all calls.
  const makeFake = (groupsJson: string, failGroupCmds = false) => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const spawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      if (cmd === "cmux" && args[0] === "new-workspace")
        return { status: 0, stdout: "OK workspace:7\n", stderr: "" };
      if (cmd === "cmux" && args[0] === "workspace-group" && args[1] === "list")
        return failGroupCmds
          ? { status: 1, stdout: "", stderr: "no such command" }
          : { status: 0, stdout: groupsJson, stderr: "" };
      if (cmd === "cmux" && args[0] === "tree")
        return {
          status: 0,
          stdout: JSON.stringify({
            windows: [
              {
                workspaces: [
                  {
                    ref: "workspace:7",
                    panes: [{ surfaces: [{ ref: "surface:42", type: "terminal" }] }],
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    return { calls, spawn };
  };
  const mkAdapter = (fake: ReturnType<typeof makeFake>) =>
    makeLiveAdapter({
      spawn: fake.spawn,
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        pathExists: async () => false,
        symlink: async () => undefined,
        rm: async () => undefined,
      },
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      completeEntrypoint: "/install/governance/src/cli/boule.ts",
      codexAuthPath: "/op/.codex/auth.json",
      env: { OPENAI_API_KEY: "test-codex-key" }, // env auth ⇒ ensureCleanCodexHome skips the symlink
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
      projectLabel: "work-radar",
    });

  it("CREATES the folder anchored on the new workspace when none matches the project label", async () => {
    const fake = makeFake(JSON.stringify({ groups: [] }));
    const sess = await mkAdapter(fake).spawnSession({
      worktreePath: "/wt/s0",
      stepIndex: 0,
      taskId: "evt_t0",
      prompt: "P",
    });
    expect(sess.surface).toBe("surface:42");
    const create = fake.calls.find(
      (c) => c.args[0] === "workspace-group" && c.args[1] === "create",
    );
    expect(create).toBeTruthy();
    expect(create!.args).toEqual([
      "workspace-group",
      "create",
      "--name",
      "work-radar",
      "--from",
      "workspace:7",
    ]);
    expect(fake.calls.some((c) => c.args[1] === "add")).toBe(false);
  });

  it("REUSES (adds the workspace to) an existing folder matching the project label", async () => {
    const fake = makeFake(
      JSON.stringify({ groups: [{ name: "work-radar", ref: "workspace_group:5" }] }),
    );
    const sess = await mkAdapter(fake).spawnSession({
      worktreePath: "/wt/s0",
      stepIndex: 0,
      taskId: "evt_t0",
      prompt: "P",
    });
    expect(sess.surface).toBe("surface:42");
    const add = fake.calls.find((c) => c.args[0] === "workspace-group" && c.args[1] === "add");
    expect(add!.args).toEqual([
      "workspace-group",
      "add",
      "--group",
      "workspace_group:5",
      "--workspace",
      "workspace:7",
    ]);
    expect(fake.calls.some((c) => c.args[1] === "create")).toBe(false);
  });

  it("grouping is BEST-EFFORT: a workspace-group failure still returns the session surface", async () => {
    const fake = makeFake("", true);
    const sess = await mkAdapter(fake).spawnSession({
      worktreePath: "/wt/s0",
      stepIndex: 0,
      taskId: "evt_t0",
      prompt: "P",
    });
    expect(sess.surface).toBe("surface:42"); // loop not broken by grouping failure
  });
});

describe("cmux output parsing (real-contract helpers — live-loop de-risk)", () => {
  it("parseCmuxRef extracts the ref from `OK workspace:N` (notice on stderr, not stdout)", () => {
    expect(parseCmuxRef("OK workspace:7\n", "workspace")).toBe("workspace:7");
    expect(parseCmuxRef("OK surface:42 workspace:7\n", "surface")).toBe("surface:42");
  });
  it("parseCmuxRef throws (terminal failure) when the ref is absent", () => {
    expect(() => parseCmuxRef("OK\n", "workspace")).toThrow(/no workspace ref/);
  });
  it("firstTerminalSurface returns the workspace's terminal surface ref", () => {
    const tree = JSON.stringify({
      windows: [
        {
          workspaces: [
            { ref: "workspace:1", panes: [{ surfaces: [{ ref: "surface:1", type: "terminal" }] }] },
            {
              ref: "workspace:7",
              panes: [{ surfaces: [{ ref: "surface:42", type: "terminal" }] }],
            },
          ],
        },
      ],
    });
    expect(firstTerminalSurface(tree, "workspace:7")).toBe("surface:42");
  });
  it("firstTerminalSurface skips non-terminal (e.g. browser) surfaces", () => {
    const tree = JSON.stringify({
      windows: [
        {
          workspaces: [
            {
              ref: "workspace:7",
              panes: [
                {
                  surfaces: [
                    { ref: "surface:9", type: "browser" },
                    { ref: "surface:10", type: "terminal" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(firstTerminalSurface(tree, "workspace:7")).toBe("surface:10");
  });
  it("firstTerminalSurface throws when the workspace has no terminal surface", () => {
    const tree = JSON.stringify({ windows: [{ workspaces: [{ ref: "workspace:7", panes: [] }] }] });
    expect(() => firstTerminalSurface(tree, "workspace:7")).toThrow(/no terminal surface/);
  });
  it("firstTerminalSurface throws on invalid JSON", () => {
    expect(() => firstTerminalSurface("not json", "workspace:7")).toThrow(/invalid JSON/);
  });
  it("findGroupRef returns the ref of a group matching the name, else null", () => {
    const list = JSON.stringify({
      groups: [
        { name: "other", ref: "workspace_group:1" },
        { name: "work-radar", ref: "workspace_group:5" },
      ],
    });
    expect(findGroupRef(list, "work-radar")).toBe("workspace_group:5");
    expect(findGroupRef(list, "absent")).toBeNull();
    expect(findGroupRef("not json", "work-radar")).toBeNull();
    expect(findGroupRef(JSON.stringify({ groups: [] }), "work-radar")).toBeNull();
  });
  it("projectLabelFromRepoRoot returns the repo dir basename (trailing slashes trimmed)", () => {
    expect(projectLabelFromRepoRoot("/Users/me/private_project/work-radar")).toBe("work-radar");
    expect(projectLabelFromRepoRoot("/tmp/boule-live-smoke/")).toBe("boule-live-smoke");
  });
});

describe("L3 — codex peer executor (buildSessionCommand + spawn branch + envelope)", () => {
  // serverEntrypoint is the Boule INSTALL path, deliberately NOT under /repo (the target repo) —
  // proves the executor MCP points at the install, not <repoRoot>/governance.
  const cmdDeps = {
    serverEntrypoint: "/install/governance/src/mcp/server.ts",
    governanceWorkspace: "/repo/governance/workspace",
    completeEntrypoint: "/install/governance/src/cli/boule.ts",
    codexHome: "/repo/governance/workspace/codex-home",
  };

  it("claude (default) builds the scoped-mcp.json + strict + verdict denylist invocation", () => {
    const c = buildSessionCommand("claude", { worktreePath: "/wt/s0", taskId: "evt_t0" }, cmdDeps);
    expect(c).toContain("claude --mcp-config");
    expect(c).toContain("--strict-mcp-config");
    // unattended autonomy within the worktree sandbox (see buildSessionCommand)
    expect(c).toContain("--permission-mode bypassPermissions");
    expect(c).toContain("--disallowedTools");
    expect(c).toContain("mcp__boule-governance__approve");
    // `--` must precede the positional prompt so the variadic --disallowedTools can't swallow it
    expect(c).toMatch(/--disallowedTools .*-- "\$\(cat \/wt\/s0\/\.boule\/step-prompt\.md\)"/);
    expect(c).toContain("$(cat /wt/s0/.boule/step-prompt.md)");
    expect(c).not.toContain("codex");
    expect(c).not.toContain("complete-task");
    expect(c).toContain("record-attempt");
    expect(c).toContain("report-exit");
    expect(c).toContain("--attempt 0");
    expect(c).toContain("--exit-code");
    expect(c).toContain('git -C "/wt/s0" status --porcelain');
    // claude uses the operator's own profile (its hooks are the app's) — NO CODEX_HOME isolation
    expect(c).not.toContain("CODEX_HOME");
  });

  it("codex builds a workspace-write (NOT danger-full) exec attaching the executor-role MCP via -c", () => {
    const c = buildSessionCommand("codex", { worktreePath: "/wt/s0", taskId: "evt_t0" }, cmdDeps);
    expect(c).toContain("codex exec");
    expect(c).toContain("--sandbox workspace-write");
    // approval gate disabled so the headless exec session can call its MCP tools (complete_task);
    // but the sandbox is KEPT — never the approvals+sandbox bypass.
    expect(c).toContain('approval_policy="never"');
    expect(c).not.toContain("danger");
    expect(c).toContain('-C "/wt/s0"');
    // same executor-role server (verdict tools structurally absent), attached via codex -c config
    expect(c).toContain("mcp_servers.boule-governance.command=");
    expect(c).toContain('BOULE_SESSION_ROLE="executor"');
    expect(c).toContain("/install/governance/src/mcp/server.ts");
    expect(c).not.toContain("/repo/governance/src/mcp/server.ts"); // never repoRoot-derived
    expect(c).toContain("$(cat /wt/s0/.boule/step-prompt.md)");
    // codex has no per-server denylist — must NOT rely on claude's flags
    expect(c).not.toContain("--disallowedTools");
    // supervised attempt evidence records the real exit code on success and failure; report-exit
    // remains guarded to clean exits only.
    expect(c).toContain("record-attempt");
    expect(c).toContain('if [ "$__boule_exit" -eq 0 ]; then node');
    expect(c).toContain(`"${cmdDeps.completeEntrypoint}" report-exit`);
    expect(c).toContain(`"${cmdDeps.completeEntrypoint}" record-attempt`);
    expect(c).not.toContain(`"${cmdDeps.completeEntrypoint}" complete-task`);
    expect(c).toContain('--workspace "/repo/governance/workspace"');
    expect(c).toContain('--task "evt_t0"');
    expect(c).toContain("--attempt 0");
    expect(c).toContain("--exit-code");
    expect(c).toContain('git -C "/wt/s0" status --porcelain');
    // CODEX_HOME isolation: clean hooks-free profile, prefixed ONCE before `codex exec` (scopes to
    // codex only — the trailing `&& node … report-exit` boule CLI does NOT inherit it).
    expect(c).toContain("; CODEX_HOME='/repo/governance/workspace/codex-home' codex exec");
    // exactly once → the trailing `&& node … report-exit` tail carries no CODEX_HOME
    expect((c.match(/CODEX_HOME=/g) ?? []).length).toBe(1);
    expect(c.indexOf("CODEX_HOME=")).toBeLessThan(c.indexOf("codex exec"));
  });

  it("spawnSession launches a codex invocation via --command when executor=codex (same cmux substrate)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      if (cmd === "cmux" && args[0] === "new-workspace")
        return { status: 0, stdout: "OK workspace:9\n", stderr: "" };
      if (cmd === "cmux" && args[0] === "tree")
        return {
          status: 0,
          stdout: JSON.stringify({
            windows: [
              {
                workspaces: [
                  {
                    ref: "workspace:9",
                    panes: [{ surfaces: [{ ref: "surface:55", type: "terminal" }] }],
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
    };
    const adapter = makeLiveAdapter({
      spawn: fakeSpawn,
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        pathExists: async () => false,
        symlink: async () => undefined,
        rm: async () => undefined,
      },
      repoRoot: "/repo",
      serverEntrypoint: "/install/governance/src/mcp/server.ts",
      completeEntrypoint: "/install/governance/src/cli/boule.ts",
      codexAuthPath: "/op/.codex/auth.json",
      env: { OPENAI_API_KEY: "test-codex-key" }, // env auth ⇒ ensureCleanCodexHome skips the symlink
      worktreesRoot: ".boule-worktrees",
      cmuxCmd: "cmux",
      governanceWorkspace: "/repo/governance/workspace",
    });
    const sess = await adapter.spawnSession({
      worktreePath: "/wt/s0",
      stepIndex: 0,
      taskId: "evt_t0",
      prompt: "P",
      executor: "codex",
    });
    expect(sess.surface).toBe("surface:55");
    const created = calls.find((c) => c.cmd === "cmux" && c.args[0] === "new-workspace")!;
    expect(created.args[3]).toBe("--command");
    expect(created.args[4]).toContain("codex exec");
    expect(created.args[4]).toContain(
      "CODEX_HOME='/repo/governance/workspace/codex-home' codex exec",
    ); // clean profile prefixed at launch (hook isolation)
    expect(created.args[4]).toContain("report-exit"); // completion hint wrapper present in the launch cmd
    expect(created.args[4]).not.toContain("complete-task");
    expect(created.args[4]).not.toContain("claude --mcp-config");
    expect(calls.some((c) => c.cmd === "cmux" && c.args[0] === "send")).toBe(false);
  });

  it("conductPlan(executor=codex) records executor in the session_spawned envelope", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, { adapter: stubAdapter, executor: "codex" }, at(10), 0.3);
    const all = await readAllEvents(dir);
    const spawned = all.find((e) => e.frontmatter.type === "session_spawned")!;
    const body = JSON.parse(spawned.body) as { envelope: { executor: string } };
    expect(body.envelope.executor).toBe("codex");
  });

  it("conductPlan defaults to claude in the envelope when executor omitted", async () => {
    const planId = await setupActivePlan();
    await conductPlan(dir, { planId }, { adapter: stubAdapter }, at(10), 0.3);
    const all = await readAllEvents(dir);
    const spawned = all.find((e) => e.frontmatter.type === "session_spawned")!;
    const body = JSON.parse(spawned.body) as { envelope: { executor: string } };
    expect(body.envelope.executor).toBe("claude");
  });
});

describe("ensureCleanCodexHome — clean hooks-free codex profile (Slice 1 isolation)", () => {
  // map-based fake fs: `present` = paths that exist; records writes / symlinks / removals.
  function makeFs(present: Set<string>) {
    const writes: Array<{ path: string; data: string }> = [];
    const symlinks: Array<{ target: string; link: string }> = [];
    const removed: string[] = [];
    const fs: FsLike = {
      mkdir: async () => undefined,
      writeFile: async (path, data) => {
        writes.push({ path, data });
        present.add(path);
      },
      pathExists: async (p) => present.has(p),
      symlink: async (target, link) => {
        symlinks.push({ target, link });
        present.add(link);
      },
      rm: async (p) => {
        removed.push(p);
        present.delete(p);
      },
    };
    return { fs, writes, symlinks, removed };
  }
  const HOME = "/repo/.boule/workspace/codex-home";
  const OP_AUTH = "/op/.codex/auth.json";

  it("writes a hooks-free config.toml (plugin_hooks=false, notify=[]) and never a hooks.json/plugins", async () => {
    const { fs, writes } = makeFs(new Set([OP_AUTH]));
    await ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs });
    const config = writes.find((w) => w.path === `${HOME}/config.toml`)!;
    expect(config).toBeTruthy();
    expect(config.data).toContain("plugin_hooks = false");
    expect(config.data).toContain("notify = []");
    expect(config.data).not.toContain("developer_instructions");
    expect(writes.some((w) => w.path.includes("hooks.json") || w.path.includes("plugins"))).toBe(
      false,
    );
  });

  it("symlinks the operator auth.json when NO env key (never copies)", async () => {
    const { fs, symlinks } = makeFs(new Set([OP_AUTH]));
    await ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs });
    expect(symlinks).toEqual([{ target: OP_AUTH, link: `${HOME}/auth.json` }]);
  });

  it("skips the auth symlink when OPENAI_API_KEY / CODEX_API_KEY is set (env auth)", async () => {
    for (const env of [{ OPENAI_API_KEY: "x" }, { CODEX_API_KEY: "y" }]) {
      const { fs, symlinks } = makeFs(new Set([OP_AUTH]));
      await ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env, fs });
      expect(symlinks).toHaveLength(0);
    }
  });

  it("THROWS (never spawns unauthenticated) when neither an env key nor operator auth exists", async () => {
    const { fs } = makeFs(new Set()); // operator auth absent, no env key
    await expect(
      ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs }),
    ).rejects.toThrow(/codex auth unavailable/);
  });

  it("removes a stray hooks.json from the clean home (defense-in-depth)", async () => {
    const { fs, removed } = makeFs(new Set([OP_AUTH, `${HOME}/hooks.json`]));
    await ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs });
    expect(removed).toContain(`${HOME}/hooks.json`);
  });

  it("is idempotent — 2nd call rewrites config but does NOT re-symlink (auth already present), no state wipe", async () => {
    const { fs, symlinks, writes, removed } = makeFs(new Set([OP_AUTH]));
    await ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs });
    await ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs });
    expect(symlinks).toHaveLength(1); // not re-created on the 2nd call
    expect(writes.filter((w) => w.path === `${HOME}/config.toml`)).toHaveLength(2); // config rewritten
    expect(removed).toHaveLength(0); // never deletes session/history state
  });

  it("drops a now-DANGLING auth link and throws when the operator auth is gone (no opaque codex fail)", async () => {
    // a prior tick created the link; the operator then removed ~/.codex/auth.json, and there's no env key.
    const { fs, removed } = makeFs(new Set([`${HOME}/auth.json`]));
    await expect(
      ensureCleanCodexHome({ codexHome: HOME, operatorAuthPath: OP_AUTH, env: {}, fs }),
    ).rejects.toThrow(/codex auth unavailable/);
    expect(removed).toContain(`${HOME}/auth.json`); // cleaned up the dead link rather than spawning against it
  });
});

describe("conductorStatus — read-only render", () => {
  it("renders steps, cursor, halted, done and writes nothing", async () => {
    const planId = await setupActivePlan();
    const before = (await readAllEvents(dir)).length;
    const st = await conductorStatus(dir, { planId });
    expect(st.steps.map((s) => s.text)).toEqual(["step a", "step b"]);
    expect(st.cursor).toBe(0);
    expect(st.halted).toBe(false);
    expect(st.done).toBe(false);
    expect((await readAllEvents(dir)).length).toBe(before);
  });
});
