import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { canAdvance } from "./guards.ts";
import type { ExecutorKind, SelectedBackendRecord } from "./envelope.ts";
import type { ConductorAdapter } from "./adapter.ts";
import { selectExecutorChain, type ResolveBudgetContext } from "../backends/resolve.ts";
import type { ResolvedPolicy } from "../repo/config.ts";
import {
  budgetContextFromJournal,
  defaultBackendForExecutor,
  isTerminal,
  selectViableExecutorBackend,
  selectedBackendRecord,
  FAIL_CLOSED_VIABILITY,
  type ConductorEnvelopeDefaults,
  type ExecutorViabilityProbes,
} from "./backend.ts";
import {
  loadConductor,
  materializeSession,
  type ConductPlanInput,
  type ConductPlanResult,
} from "./conductShared.ts";

/** conduct_plan — advance a human-accepted plan by AT MOST ONE step. Mints (in chronological
 *  order, distinct ids via per-event second-offset stamps, mirroring escalate.ts):
 *    task_created (actor:conductor) → step_bound → session_spawned → task_started
 *  and creates the worktree + envelope file + cmux session via the injected adapter. Refuses
 *  (writes NOTHING) when the plan is not active / halted / done / a step is in-flight. */
export async function conductPlan(
  workspaceDir: string,
  input: ConductPlanInput,
  deps: {
    adapter: ConductorAdapter;
    executor?: ExecutorKind;
    envelopeDefaults?: ConductorEnvelopeDefaults;
    policy?: ResolvedPolicy;
    budget?: ResolveBudgetContext;
    viability?: ExecutorViabilityProbes;
  },
  now: Date,
  rand: number,
): Promise<ConductPlanResult> {
  const { state, all } = await loadConductor(workspaceDir, input.planId);
  const gate = canAdvance(state);
  if (!gate.ok) return { ok: false, reason: gate.reason, advanced: null };

  const k = state.cursor!; // canAdvance guarantees non-null
  const step = state.steps[k]!;
  let executor: ExecutorKind = deps.executor ?? "claude";
  let selectedBackend: SelectedBackendRecord | undefined;
  const policy = deps.policy;
  if (policy?.backends?.executor !== undefined) {
    const budget = budgetContextFromJournal(all, policy, deps.budget);
    const chain = budget
      ? selectExecutorChain(step, policy, budget)
      : selectExecutorChain(step, policy);
    const selected = await selectViableExecutorBackend(
      chain,
      deps.viability ?? FAIL_CLOSED_VIABILITY,
    );
    if (isTerminal(selected)) {
      return { ok: false, reason: "executor:stall", advanced: null };
    }
    executor = selected.executor;
    selectedBackend = selectedBackendRecord(selected.backend);
  }

  // Per-event second-offset stamps → distinct chronological ids in one call (escalate.ts trick).
  const at = (i: number) => new Date(now.getTime() + i * 1000);

  // 1) task_created — actor:"conductor" (NOT user). Title line = the step text.
  const taskEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(0), rand),
      type: "task_created",
      source: "hermes",
      actor: "conductor",
      tags: ["task", "conductor"],
      related_to: [input.planId],
    },
    body: step.text,
  };
  await writeEvent(workspaceDir, taskEvt, at(0));
  const taskId = taskEvt.frontmatter.id;

  // Build worktree + envelope + prompt + spawn (worktree path is the ONLY writable tree —
  // INVARIANT #6). materializeSession returns the canonical envelope it spawned with.
  // NOTE: spawnSession now runs before step_bound is persisted (previously step_bound was written
  // first). Happy-path events are byte-identical (step_bound stays at(1), session at(2)); the only
  // divergence is on a spawnSession throw, where just task_created persists instead of
  // task_created+step_bound. Both leave the task unstarted, so the projection stays consistent.
  const m = await materializeSession(deps, {
    planId: input.planId,
    stepIndex: k,
    taskId,
    promptText: step.text,
    check: step.check,
    executor,
    selectedBackend,
    attemptIndex: 0,
  });

  // 2) step_bound — binds step index ↔ task (verdict-free). Body = canonical JSON.
  const stepBound: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(1), rand),
      type: "step_bound",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor"],
      related_to: [input.planId, taskId],
    },
    body: JSON.stringify({ stepIndex: k, taskId, planId: input.planId }),
  };
  await writeEvent(workspaceDir, stepBound, at(1));

  // 3) session_spawned — records the spawn (verdict-free). Carries envelope + tamper-evident hash.
  const sessionEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(2), rand),
      type: "session_spawned",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor"],
      related_to: [taskId],
    },
    body: JSON.stringify({
      surface: m.surface,
      worktree: m.worktreePath,
      envelopeHash: m.envelopeHash,
      envelope: m.envelope,
      ...(selectedBackend ? { selectedBackend } : {}),
    }),
  };
  await writeEvent(workspaceDir, sessionEvt, at(2));

  // 4) executor_attempt_started — observation-only hint. It has no completion/approval authority.
  const attemptStartedEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(3), rand),
      type: "executor_attempt_started",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor", "attempt-hint"],
      related_to: [taskId],
    },
    body: JSON.stringify({
      attemptIndex: 0,
      backend: selectedBackend ?? defaultBackendForExecutor(executor),
    }),
  };
  await writeEvent(workspaceDir, attemptStartedEvt, at(3));

  // 5) task_started — the bound task is now active (the session is running).
  const startedEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(4), rand),
      type: "task_started",
      source: "hermes",
      actor: "conductor",
      tags: ["task", "conductor"],
      related_to: [taskId],
    },
    body: `Started ${taskId}`,
  };
  await writeEvent(workspaceDir, startedEvt, at(4));

  return {
    ok: true,
    reason: `materialized step ${k}`,
    advanced: {
      stepIndex: k,
      taskId,
      surface: m.surface,
      worktreePath: m.worktreePath,
      envelopeHash: m.envelopeHash,
    },
  };
}
