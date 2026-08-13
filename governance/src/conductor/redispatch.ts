import type { ConductorAdapter } from "./adapter.ts";
import type { ExecutorKind } from "./envelope.ts";
import type { ConductorStepState } from "./conductor.ts";
import { selectExecutorChain, type ResolveBudgetContext } from "../backends/resolve.ts";
import type { ResolvedPolicy } from "../repo/config.ts";
import { projectPreviousAttemptFeedback } from "./attemptFeedback.ts";
import {
  budgetContextFromJournal,
  isTerminal,
  sameBackend,
  selectNextViableExecutorBackend,
  selectedBackendRecord,
  FAIL_CLOSED_VIABILITY,
  type ConductorEnvelopeDefaults,
  type ExecutorViabilityProbes,
} from "./backend.ts";
import {
  loadConductor,
  spawnRetryAttempt,
  writeExecutorStall,
  sessionSpawnCountForTask,
  MAX_SESSIONS_PER_TASK,
  type ConductStepReport,
} from "./conductShared.ts";

export interface RedispatchExecutorAttemptInput {
  planId: string;
}

export type RedispatchExecutorAttemptResult =
  | { kind: "no_action"; reason: string }
  | { kind: "advanced"; advanced: ConductStepReport }
  | { kind: "stalled"; stepIndex: number; taskId: string; reason: "executor:stall" };

export async function redispatchExecutorAttempt(
  workspaceDir: string,
  input: RedispatchExecutorAttemptInput,
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
): Promise<RedispatchExecutorAttemptResult> {
  const { state, all } = await loadConductor(workspaceDir, input.planId);
  const step = state.steps.find((s) => shouldConsiderRetry(s));
  if (!step || !step.taskId) return { kind: "no_action", reason: "no retry-eligible attempt" };
  if (!deps.policy?.backends?.executor) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor chain unavailable", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const currentAttempt = step.attempts.currentAttemptIndex;
  if (currentAttempt === null) return { kind: "no_action", reason: "no started attempt" };

  if (sessionSpawnCountForTask(all, step.taskId) >= MAX_SESSIONS_PER_TASK) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor session spawn cap reached", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  if (step.attempts.latestFinishedWorktreeDirty !== false) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor token-exhausted attempt left a dirty worktree", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const budget = budgetContextFromJournal(all, deps.policy, deps.budget, step.taskId);
  const chainOrTerminal = budget
    ? selectExecutorChain(step, deps.policy, budget)
    : selectExecutorChain(step, deps.policy);
  if (isTerminal(chainOrTerminal)) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor chain exhausted", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const nextAttempt = currentAttempt + 1;
  const selected = await selectNextViableExecutorBackend(
    chainOrTerminal,
    step.attempts.latestStartedBackend,
    deps.viability ?? FAIL_CLOSED_VIABILITY,
  );
  if (isTerminal(selected)) {
    await writeExecutorStall(workspaceDir, step.taskId, "next executor backend is not viable", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }
  if (sameBackend(step.attempts.latestStartedBackend, selected.backend)) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor retry would repeat the same backend", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  // P4c failure feedback: the retry prompt names the prior failure (count/exit/stderr digest) so
  // the next attempt changes approach instead of blindly repeating it (OMC pattern #8).
  const advanced = await spawnRetryAttempt(
    workspaceDir,
    deps,
    {
      planId: input.planId,
      stepIndex: step.stepIndex,
      taskId: step.taskId,
      promptText: step.text,
      check: step.check,
      executor: selected.executor,
      selectedBackend: selectedBackendRecord(selected.backend),
      attemptIndex: nextAttempt,
      previousAttempt: projectPreviousAttemptFeedback(all, step.taskId),
      sessionTags: ["conductor"],
      sessionRelatedTo: [step.taskId],
      attemptTags: ["conductor", "attempt-hint"],
    },
    now,
    rand,
  );

  return { kind: "advanced", advanced };
}

export function shouldConsiderRetry(step: ConductorStepState): boolean {
  const attempts = step.attempts;
  return (
    step.taskId !== null &&
    step.taskPhase === "active" &&
    attempts.currentAttemptIndex !== null &&
    attempts.latestFinishedAttemptIndex === attempts.currentAttemptIndex &&
    attempts.latestFinishedOutcomeClass === "token_exhausted"
  );
}
