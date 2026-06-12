import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveConductorState,
  machineUncertifiableSteps,
  parsePlanStepRecords,
  parsePlanSteps,
} from "../../src/conductor/conductor.js";
import type { GovEvent, EventType } from "../../src/event/event.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { completeTask } from "../../src/task/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";

const PLAN_ID = "evt_p1";
function plan(body: string): GovEvent {
  return { frontmatter: { id: PLAN_ID, type: "plan_proposed", source: "hermes", actor: "planner", tags: ["plan"] }, body };
}
function ev(type: EventType, id: string, relatedTo: string[], body = "", actor = "conductor"): GovEvent {
  return { frontmatter: { id, type, source: "hermes", actor, tags: [], related_to: relatedTo }, body };
}
const TWO_STEP = "Load feature X\n\n1. step a\n2. step b";
const accepted = ev("plan_accepted", "evt_acc", [PLAN_ID], "", "user");

describe("parsePlanSteps", () => {
  it("extracts numbered steps, stripping the N. prefix and ignoring the intent line", () => {
    expect(parsePlanSteps(TWO_STEP)).toEqual(["step a", "step b"]);
  });
  it("golden/back-compat: a plan step with no check parses fine", () => {
    expect(parsePlanStepRecords(TWO_STEP)).toEqual([
      { text: "step a" },
      { text: "step b" },
    ]);
  });
  it("returns [] for a body with no numbered steps", () => {
    expect(parsePlanSteps("just an intent line")).toEqual([]);
  });
});

describe("deriveConductorState — pure projection", () => {
  it("draft (not accepted) → planPhase draft, cursor null (precondition for canAdvance handled in guards)", () => {
    const s = deriveConductorState(plan(TWO_STEP), [plan(TWO_STEP)]);
    expect(s.planPhase).toBe("draft");
    expect(s.steps.map((x) => x.text)).toEqual(["step a", "step b"]);
    expect(s.cursor).toBe(0); // both unmaterialized; pure projection still computes cursor=0
    expect(s.done).toBe(false);
  });

  it("accepted plan, nothing materialized → cursor=0", () => {
    const all = [plan(TWO_STEP), accepted];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.planPhase).toBe("active");
    expect(s.cursor).toBe(0);
  });

  it("step 0 bound + task active (in-flight) → cursor null (advance nothing)", () => {
    const taskId = "evt_t0";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", taskId, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, taskId], JSON.stringify({ stepIndex: 0, taskId, planId: PLAN_ID })),
      ev("task_started", "evt_ts0", [taskId], "Started"),
    ];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.steps[0]!.taskId).toBe(taskId);
    expect(s.steps[0]!.taskPhase).toBe("active");
    expect(s.cursor).toBeNull();
  });

  it("step 0 bound + task done → cursor advances to 1", () => {
    const taskId = "evt_t0";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", taskId, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, taskId], JSON.stringify({ stepIndex: 0, taskId, planId: PLAN_ID })),
      ev("task_started", "evt_ts0", [taskId]),
      ev("task_completed", "evt_tc0", [taskId]),
    ];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.steps[0]!.taskPhase).toBe("done");
    expect(s.cursor).toBe(1);
    expect(s.done).toBe(false);
  });

  it("HALT: an open decision_blocked bound to a step's task → halted=true, cursor null", () => {
    const taskId = "evt_t0";
    const decId = "evt_dec0";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", taskId, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, taskId], JSON.stringify({ stepIndex: 0, taskId, planId: PLAN_ID })),
      ev("task_started", "evt_ts0", [taskId]),
      ev("decision_proposed", decId, [], "fork?", "stub-0"),
      ev("decision_blocked", "evt_blk0", [decId, taskId], "{}", "stub-0"),
    ];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.steps[0]!.halted).toBe(true);
    expect(s.halted).toBe(true);
    expect(s.cursor).toBeNull();
  });

  it("resolved block (decision_chosen) → no longer halted, cursor recomputed", () => {
    const taskId = "evt_t0";
    const decId = "evt_dec0";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", taskId, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, taskId], JSON.stringify({ stepIndex: 0, taskId, planId: PLAN_ID })),
      ev("task_started", "evt_ts0", [taskId]),
      ev("decision_proposed", decId, [], "fork?", "stub-0"),
      ev("decision_blocked", "evt_blk0", [decId, taskId], "{}", "stub-0"),
      ev("decision_chosen", "evt_chosen0", [decId], "opt0", "user"),
    ];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.halted).toBe(false);
    // task still active (no completed) → step 0 in-flight → cursor null
    expect(s.cursor).toBeNull();
  });

  it("DONE: every step materialized + terminal → done=true, cursor null", () => {
    const t0 = "evt_t0", t1 = "evt_t1";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", t0, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, t0], JSON.stringify({ stepIndex: 0, taskId: t0, planId: PLAN_ID })),
      ev("task_completed", "evt_tc0", [t0]),
      ev("task_created", t1, [PLAN_ID], "step b"),
      ev("step_bound", "evt_sb1", [PLAN_ID, t1], JSON.stringify({ stepIndex: 1, taskId: t1, planId: PLAN_ID })),
      ev("task_completed", "evt_tc1", [t1]),
    ];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.done).toBe(true);
    expect(s.cursor).toBeNull();
  });

  it("ignores foreign event types (god-fold ban) — an unrelated spec_proposed does not perturb steps", () => {
    const all = [plan(TWO_STEP), accepted, ev("spec_proposed", "evt_spec", [PLAN_ID], "noise", "author")];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.steps).toHaveLength(2);
    expect(s.cursor).toBe(0);
  });

  it("session_spawned surfaces the cmux surface onto the bound step", () => {
    const taskId = "evt_t0";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", taskId, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, taskId], JSON.stringify({ stepIndex: 0, taskId, planId: PLAN_ID })),
      ev("session_spawned", "evt_ss0", [taskId], JSON.stringify({ surface: "stub-0", worktree: "w", envelopeHash: "h", envelope: {} })),
      ev("task_started", "evt_ts0", [taskId]),
    ];
    const s = deriveConductorState(plan(TWO_STEP), all);
    expect(s.steps[0]!.surface).toBe("stub-0");
  });

  it("projects executor attempts from events only, including the latest token-exhausted clean finish", () => {
    const taskId = "evt_t0";
    const all = [
      plan(TWO_STEP), accepted,
      ev("task_created", taskId, [PLAN_ID], "step a"),
      ev("step_bound", "evt_sb0", [PLAN_ID, taskId], JSON.stringify({ stepIndex: 0, taskId, planId: PLAN_ID })),
      ev("session_spawned", "evt_ss0", [taskId], JSON.stringify({ surface: "stub-0", worktree: "w0", envelopeHash: "h", envelope: {} })),
      ev("executor_attempt_started", "evt_as0", [taskId], JSON.stringify({ attemptIndex: 0, backend: { provider: "codex" } })),
      ev(
        "executor_attempt_finished",
        "evt_af0",
        [taskId],
        JSON.stringify({
          attemptIndex: 0,
          exitCode: 1,
          launched: true,
          worktreeDirty: false,
          outcomeClass: "token_exhausted",
          usage: "unknown",
        }),
      ),
      ev("task_started", "evt_ts0", [taskId]),
    ];

    const s1 = deriveConductorState(plan(TWO_STEP), all);
    const s2 = deriveConductorState(plan(TWO_STEP), [...all]);

    expect(s1.steps[0]!.attempts).toEqual({
      currentAttemptIndex: 0,
      latestStartedBackend: { provider: "codex" },
      latestFinishedAttemptIndex: 0,
      latestFinishedOutcomeClass: "token_exhausted",
      latestFinishedWorktreeDirty: false,
    });
    expect(s2.steps[0]!.attempts).toEqual(s1.steps[0]!.attempts);
  });
});

describe("KEYSTONE — deriveConductorState is byte-stable across a state wipe + re-derive from events/", () => {
  let dir: string;
  const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-cond-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("re-deriving from the immutable event log yields identical state (no stored cursor)", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load feature X", steps: ["step a", "step b"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);
    await conductPlan(dir, { planId }, { adapter: stubAdapter }, at(10), 0.3);
    const r1 = await completeTask(dir, { taskId: (await firstTaskId(dir)) }, at(30), 0.4);
    expect(r1.ok).toBe(true);

    const all1 = await readAllEvents(dir);
    const proposal1 = all1.find((e) => e.frontmatter.id === planId)!;
    const s1 = deriveConductorState(proposal1, all1);

    // "wipe state/" is a no-op here (we never persist a cursor) — re-read events fresh and re-derive.
    const all2 = await readAllEvents(dir);
    const proposal2 = all2.find((e) => e.frontmatter.id === planId)!;
    const s2 = deriveConductorState(proposal2, all2);

    expect(JSON.stringify(s2)).toBe(JSON.stringify(s1));
    expect(s1.cursor).toBe(1); // step 0 done → cursor advanced to step 1
  });
});

async function firstTaskId(dir: string): Promise<string> {
  const all = await readAllEvents(dir);
  const t = all.find((e) => e.frontmatter.type === "task_created");
  return t!.frontmatter.id;
}

describe("check:{kind:'human'} parsing + machineUncertifiableSteps (P2a authoring gate input)", () => {
  it("parses an explicit human check marker", () => {
    const body = 'I\n\n1. review the docs <!-- boule:check {"kind":"human"} -->';
    expect(parsePlanStepRecords(body)).toEqual([{ text: "review the docs", check: { kind: "human" } }]);
  });

  it("machineUncertifiableSteps: checkless and explicit-human steps are listed; command/artifact steps are not", () => {
    const body = [
      "I",
      "",
      "1. checkless step",
      '2. checked step <!-- boule:check {"command":"true"} -->',
      '3. human step <!-- boule:check {"kind":"human"} -->',
      '4. artifact step <!-- boule:check {"artifact":"out.txt"} -->',
    ].join("\n");
    expect(machineUncertifiableSteps(body)).toEqual([
      { stepIndex: 0, explicitHuman: false },
      { stepIndex: 2, explicitHuman: true },
    ]);
  });

  it("kind:'human' DOMINATES a co-declared command/artifact (the step stays human-certified)", () => {
    const body = 'I\n\n1. odd step <!-- boule:check {"kind":"human","command":"true"} -->';
    expect(machineUncertifiableSteps(body)).toEqual([{ stepIndex: 0, explicitHuman: true }]);
  });

  it("an all-machine-checked plan yields no entries", () => {
    const body = 'I\n\n1. a <!-- boule:check {"command":"true"} -->\n2. b <!-- boule:check {"artifact":"x"} -->';
    expect(machineUncertifiableSteps(body)).toEqual([]);
  });
});
