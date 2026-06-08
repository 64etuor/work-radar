import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveConductorState, type ConductorState } from "./conductor.ts";
import { canAdvance } from "./guards.ts";
import {
  buildEnvelope,
  envelopeHash,
  type AutonomyEnvelope,
  type ExecutorKind,
} from "./envelope.ts";
import type { ConductorAdapter } from "./adapter.ts";

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

export async function conductPlan(
  workspaceDir: string,
  input: ConductPlanInput,
  deps: {
    adapter: ConductorAdapter;
    executor?: ExecutorKind;
    envelopeDefaults?: ConductorEnvelopeDefaults;
  },
  now: Date,
  rand: number,
): Promise<ConductPlanResult> {
  const { state } = await loadConductor(workspaceDir, input.planId);
  const gate = canAdvance(state);
  if (!gate.ok) return { ok: false, reason: gate.reason, advanced: null };

  const executor: ExecutorKind = deps.executor ?? "claude";
  const k = state.cursor!; // canAdvance guarantees non-null
  const step = state.steps[k]!;

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
    }),
  };
  await writeEvent(workspaceDir, sessionEvt, at(2));

  // 5) task_started — the bound task is now active (the session is running).
  const startedEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(3), rand),
      type: "task_started",
      source: "hermes",
      actor: "conductor",
      tags: ["task", "conductor"],
      related_to: [taskId],
    },
    body: `Started ${taskId}`,
  };
  await writeEvent(workspaceDir, startedEvt, at(3));

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
