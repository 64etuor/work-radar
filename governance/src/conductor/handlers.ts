import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveConductorState, type ConductorState, type ConductorStepState } from "./conductor.ts";
import { canAdvance } from "./guards.ts";
import {
  buildEnvelope,
  envelopeHash,
  type AutonomyEnvelope,
  type ExecutorKind,
  type SelectedBackendRecord,
} from "./envelope.ts";
import type { ConductorAdapter } from "./adapter.ts";
import {
  selectExecutorChain,
  type ResolveBudgetContext,
} from "../backends/resolve.ts";
import {
  assertProviderAllowed,
  type BackendChain,
  type BackendSpec,
} from "../backends/config.ts";
import { exhaustedTerminal, type Terminal } from "../backends/fallback.ts";
import type { ResolvedPolicy } from "../repo/config.ts";

// NOTE: this module imports ZERO decision write handlers (no "../decision/handlers.ts"). The
// Conductor mints task_created/task_started/step_bound/session_spawned and, after the completion
// gate passes, delegates task_completed to the guarded task lifecycle writer. Decision resolution
// flows exclusively through the existing human-gated choose/approve, never from here.

async function loadConductor(
  workspaceDir: string,
  planId: string,
): Promise<{ state: ConductorState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, planId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "plan_proposed")
    throw new Error(`unknown plan: ${planId}`);
  return { state: deriveConductorState(grp.proposal, all), all };
}

/** The spawn prompt = step text + inlined envelope + the escalate-and-stop contract (design §6). */
function buildPrompt(stepText: string, envelope: AutonomyEnvelope): string {
  return [
    `# Conductor-dispatched step ${envelope.stepIndex} (task ${envelope.taskId})`,
    "",
    stepText,
    "",
    "## Autonomy envelope",
    "```json",
    JSON.stringify(envelope, null, 2),
    "```",
    "",
    "Type-2 micro-decisions inside allowedPathGlobs are yours. The instant you hit a Type-1",
    "boundary / new dependency / invariant conflict / ambiguous intent, call",
    `escalate(question, options[], relatedTaskId='${envelope.taskId}') and STOP. You have NO`,
    "approve/reject/choose.",
    "",
    "## Required final action (do NOT skip)",
    `When the step's work is complete and no Type-1 boundary is open, your FINAL action MUST be the`,
    `tool call complete_task('${envelope.taskId}'). This is a verdict-free hint to the conductor's`,
    "completion evaluator; it does NOT certify completion by itself. If you are blocked or uncertain,",
    "call escalate(...) and stop instead.",
  ].join("\n");
}

export interface ConductPlanInput {
  planId: string;
}
export interface ConductStepReport {
  stepIndex: number;
  taskId: string;
  surface: string;
  worktreePath: string;
  envelopeHash: string;
  attemptIndex?: number;
}
export interface ConductPlanResult {
  ok: boolean;
  reason: string;
  advanced: ConductStepReport | null; // the one step materialized this call, or null
}

/** conduct_plan — advance a human-accepted plan by AT MOST ONE step. Mints (in chronological
 *  order, distinct ids via per-event second-offset stamps, mirroring escalate.ts):
 *    task_created (actor:conductor) → step_bound → session_spawned → task_started
 *  and creates the worktree + envelope file + cmux session via the injected adapter. Refuses
 *  (writes NOTHING) when the plan is not active / halted / done / a step is in-flight. */
/** Per-repo policy envelope defaults (spec 2026-06-07 §E). Omitted fields fall back to
 *  buildEnvelope's built-in defaults. */
export interface ConductorEnvelopeDefaults {
  forbiddenDecisionClasses?: AutonomyEnvelope["forbiddenDecisionClasses"];
  allowedType2Actions?: string[];
}

export interface ExecutorViabilityProbes {
  commandExists(command: string): boolean | Promise<boolean>;
  codexAuthAvailable(): boolean | Promise<boolean>;
  ensureCleanCodexHome(): boolean | Promise<boolean>;
}

export interface SelectedExecutorBackend {
  executor: ExecutorKind;
  backend: BackendSpec;
}

const FAIL_CLOSED_VIABILITY: ExecutorViabilityProbes = {
  commandExists: () => false,
  codexAuthAvailable: () => false,
  ensureCleanCodexHome: () => false,
};

export async function selectViableExecutorBackend(
  resolved: BackendChain | Terminal,
  probes: ExecutorViabilityProbes,
): Promise<SelectedExecutorBackend | Terminal> {
  if (isTerminal(resolved)) return resolved;
  for (const spec of resolved.chain) {
    const executor = await viableExecutorKind(spec, probes);
    if (executor) return { executor, backend: spec };
  }
  return exhaustedTerminal("executor");
}

async function selectViableExecutorBackendAtIndex(
  chain: BackendChain,
  index: number,
  probes: ExecutorViabilityProbes,
): Promise<SelectedExecutorBackend | Terminal> {
  const spec = chain.chain[index];
  if (!spec) return exhaustedTerminal("executor");
  const executor = await viableExecutorKind(spec, probes);
  if (!executor) return exhaustedTerminal("executor");
  return { executor, backend: spec };
}

async function viableExecutorKind(
  spec: BackendSpec,
  probes: ExecutorViabilityProbes,
): Promise<ExecutorKind | null> {
  try {
    assertProviderAllowed("executor", spec);
  } catch {
    return null;
  }
  const executor = executorKindForBackend(spec);
  if (!executor) return null;
  const command = spec.provider === "command" ? spec.command : executor;
  if (!command || !(await probes.commandExists(command))) return null;
  if (executor !== "codex") return executor;
  if (!(await probes.codexAuthAvailable())) return null;
  if (!(await probes.ensureCleanCodexHome())) return null;
  return executor;
}

function executorKindForBackend(spec: BackendSpec): ExecutorKind | null {
  if (spec.provider === "claude") return "claude";
  if (spec.provider === "codex") return "codex";
  if (spec.provider === "command") return commandProviderExecutor(spec.command);
  return null;
}

function commandProviderExecutor(command: string | undefined): ExecutorKind | null {
  if (command === "claude") return "claude";
  if (command === "codex") return "codex";
  return null;
}

function selectedBackendRecord(spec: BackendSpec): SelectedBackendRecord {
  return {
    provider: spec.provider,
    ...(spec.model ? { model: spec.model } : {}),
  };
}

function sameBackend(a: BackendSpec | SelectedBackendRecord | null, b: BackendSpec): boolean {
  if (!a) return false;
  if (a.provider !== b.provider) return false;
  if (a.model !== b.model) return false;
  const command = "command" in a ? a.command : undefined;
  return command === b.command;
}

function defaultBackendForExecutor(executor: ExecutorKind): SelectedBackendRecord {
  return { provider: executor };
}

function isTerminal(value: BackendChain | Terminal | SelectedExecutorBackend): value is Terminal {
  return "role" in value;
}

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
  const { state } = await loadConductor(workspaceDir, input.planId);
  const step = state.steps.find((s) => shouldConsiderRetry(s));
  if (!step || !step.taskId) return { kind: "no_action", reason: "no retry-eligible attempt" };
  if (!deps.policy?.backends?.executor) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor chain unavailable", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const currentAttempt = step.attempts.currentAttemptIndex;
  if (currentAttempt === null) return { kind: "no_action", reason: "no started attempt" };

  if (step.attempts.latestFinishedWorktreeDirty !== false) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor token-exhausted attempt left a dirty worktree", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const chainOrTerminal = deps.budget
    ? selectExecutorChain(step, deps.policy, deps.budget)
    : selectExecutorChain(step, deps.policy);
  if (isTerminal(chainOrTerminal)) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor chain exhausted", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const nextAttempt = currentAttempt + 1;
  if (nextAttempt >= chainOrTerminal.chain.length) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor chain exhausted", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const nextSpec = chainOrTerminal.chain[nextAttempt]!;
  if (sameBackend(step.attempts.latestStartedBackend, nextSpec)) {
    await writeExecutorStall(workspaceDir, step.taskId, "executor retry would repeat the same backend", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const selected = await selectViableExecutorBackendAtIndex(
    chainOrTerminal,
    nextAttempt,
    deps.viability ?? FAIL_CLOSED_VIABILITY,
  );
  if (isTerminal(selected)) {
    await writeExecutorStall(workspaceDir, step.taskId, "next executor backend is not viable", now, rand);
    return { kind: "stalled", stepIndex: step.stepIndex, taskId: step.taskId, reason: "executor:stall" };
  }

  const at = (i: number) => new Date(now.getTime() + i * 1000);
  const selectedBackend = selectedBackendRecord(selected.backend);
  const wt = await deps.adapter.createWorktree({
    planId: input.planId,
    stepIndex: step.stepIndex,
    attemptIndex: nextAttempt,
  });
  const envelope = buildEnvelope({
    planId: input.planId,
    stepIndex: step.stepIndex,
    taskId: step.taskId,
    worktreePath: wt.path,
    executor: selected.executor,
    selectedBackend,
    forbiddenDecisionClasses: deps.envelopeDefaults?.forbiddenDecisionClasses,
    allowedType2Actions: deps.envelopeDefaults?.allowedType2Actions,
  });
  const hash = envelopeHash(envelope);
  const prompt = buildPrompt(step.text, envelope);
  await deps.adapter.writeEnvelopeFile(wt.path, envelope, prompt);
  const session = await deps.adapter.spawnSession({
    worktreePath: wt.path,
    stepIndex: step.stepIndex,
    taskId: step.taskId,
    prompt,
    executor: selected.executor,
    attemptIndex: nextAttempt,
  });

  const sessionEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(0), rand),
      type: "session_spawned",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor"],
      related_to: [step.taskId],
    },
    body: JSON.stringify({
      surface: session.surface,
      worktree: wt.path,
      envelopeHash: hash,
      envelope,
      selectedBackend,
      attemptIndex: nextAttempt,
    }),
  };
  await writeEvent(workspaceDir, sessionEvt, at(0));

  const attemptStartedEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(1), rand),
      type: "executor_attempt_started",
      source: "hermes",
      actor: "conductor",
      tags: ["conductor", "attempt-hint"],
      related_to: [step.taskId],
    },
    body: JSON.stringify({
      attemptIndex: nextAttempt,
      backend: selectedBackend,
    }),
  };
  await writeEvent(workspaceDir, attemptStartedEvt, at(1));

  return {
    kind: "advanced",
    advanced: {
      stepIndex: step.stepIndex,
      taskId: step.taskId,
      surface: session.surface,
      worktreePath: wt.path,
      envelopeHash: hash,
      attemptIndex: nextAttempt,
    },
  };
}

function shouldConsiderRetry(step: ConductorStepState): boolean {
  const attempts = step.attempts;
  return (
    step.taskId !== null &&
    step.taskPhase === "active" &&
    attempts.currentAttemptIndex !== null &&
    attempts.latestFinishedAttemptIndex === attempts.currentAttemptIndex &&
    attempts.latestFinishedOutcomeClass === "token_exhausted"
  );
}

async function writeExecutorStall(
  workspaceDir: string,
  taskId: string,
  reason: string,
  now: Date,
  rand: number,
): Promise<void> {
  const all = await readAllEvents(workspaceDir);
  const alreadyBlocked = all.some(
    (e) =>
      e.frontmatter.type === "task_blocked" &&
      (e.frontmatter.related_to ?? []).includes(taskId) &&
      e.body.includes("executor:stall"),
  );
  if (alreadyBlocked) return;
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type: "task_blocked",
      source: "hermes",
      actor: "conductor",
      tags: ["task", "conductor", "executor-stall"],
      related_to: [taskId],
    },
    body: `Blocked ${taskId}: executor:stall (${reason})`,
  };
  await writeEvent(workspaceDir, evt, now);
}

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
  const { state } = await loadConductor(workspaceDir, input.planId);
  const gate = canAdvance(state);
  if (!gate.ok) return { ok: false, reason: gate.reason, advanced: null };

  const k = state.cursor!; // canAdvance guarantees non-null
  const step = state.steps[k]!;
  let executor: ExecutorKind = deps.executor ?? "claude";
  let selectedBackend: SelectedBackendRecord | undefined;
  const policy = deps.policy;
  if (policy?.backends?.executor !== undefined) {
    const chain = deps.budget
      ? selectExecutorChain(step, policy, deps.budget)
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

  // Build worktree + envelope (worktree path is the ONLY writable tree — INVARIANT #6).
  const wt = await deps.adapter.createWorktree({ planId: input.planId, stepIndex: k });
  const envelope = buildEnvelope({
    planId: input.planId,
    stepIndex: k,
    taskId,
    worktreePath: wt.path,
    executor,
    selectedBackend,
    forbiddenDecisionClasses: deps.envelopeDefaults?.forbiddenDecisionClasses,
    allowedType2Actions: deps.envelopeDefaults?.allowedType2Actions,
  });
  const hash = envelopeHash(envelope);
  const prompt = buildPrompt(step.text, envelope);
  await deps.adapter.writeEnvelopeFile(wt.path, envelope, prompt);

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

  // 3) spawn one isolated cmux session bound to the task.
  const session = await deps.adapter.spawnSession({
    worktreePath: wt.path,
    stepIndex: k,
    taskId,
    prompt,
    executor,
    attemptIndex: 0,
  });

  // 4) session_spawned — records the spawn (verdict-free). Carries envelope + tamper-evident hash.
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
      surface: session.surface,
      worktree: wt.path,
      envelopeHash: hash,
      envelope,
      ...(selectedBackend ? { selectedBackend } : {}),
    }),
  };
  await writeEvent(workspaceDir, sessionEvt, at(2));

  // 5) executor_attempt_started — observation-only hint. It has no completion/approval authority.
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

  // 6) task_started — the bound task is now active (the session is running).
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
      surface: session.surface,
      worktreePath: wt.path,
      envelopeHash: hash,
    },
  };
}

export interface ConductorStatusStep {
  stepIndex: number;
  text: string;
  taskId: string | null;
  surface: string | null;
  taskPhase: string | null;
  halted: boolean;
}
export interface ConductorStatusResult {
  planId: string;
  planPhase: string;
  cursor: number | null;
  halted: boolean;
  done: boolean;
  steps: ConductorStatusStep[];
}

/** conductor_status — READ-ONLY render of the derived projection. Writes nothing. */
export async function conductorStatus(
  workspaceDir: string,
  input: ConductPlanInput,
): Promise<ConductorStatusResult> {
  const { state } = await loadConductor(workspaceDir, input.planId);
  return {
    planId: state.planId,
    planPhase: state.planPhase,
    cursor: state.cursor,
    halted: state.halted,
    done: state.done,
    steps: state.steps.map((s) => ({
      stepIndex: s.stepIndex,
      text: s.text,
      taskId: s.taskId,
      surface: s.surface,
      taskPhase: s.taskPhase,
      halted: s.halted,
    })),
  };
}
