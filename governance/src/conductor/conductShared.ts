import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import {
  deriveConductorState,
  type ConductorState,
  type PlanStepCheck,
} from "./conductor.ts";
import {
  buildEnvelope,
  envelopeHash,
  type AutonomyEnvelope,
  type ExecutorKind,
  type SelectedBackendRecord,
} from "./envelope.ts";
import type { ConductorAdapter } from "./adapter.ts";
import { buildPrompt } from "./prompt.ts";
import { type ConductorEnvelopeDefaults } from "./backend.ts";
import { MAX_SESSIONS_PER_TASK } from "../orchestrator/constants.ts";
import type { PreviousAttemptFeedback } from "./attemptFeedback.ts";

export { MAX_SESSIONS_PER_TASK };

// NOTE: the conductor modules import ZERO decision write handlers (no "../decision/handlers.ts").
// The Conductor mints task_created/task_started/step_bound/session_spawned and, after the
// completion gate passes, delegates task_completed to the guarded task lifecycle writer. Decision
// resolution flows exclusively through the existing human-gated choose/approve, never from here.

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

export async function loadConductor(
  workspaceDir: string,
  planId: string,
): Promise<{ state: ConductorState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, planId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "plan_proposed")
    throw new Error(`unknown plan: ${planId}`);
  return { state: deriveConductorState(grp.proposal, all), all };
}

/** The common spawn-and-record core shared by conduct/redispatch/resume (was duplicated 3×): build
 *  the isolated worktree, build + hash the envelope, build the prompt, write the envelope file, and
 *  spawn the cmux session. Writes NO governance events — each caller writes its own task-lifecycle
 *  events around this (conduct adds task_created/step_bound/task_started; retry/resume add only the
 *  session_spawned + executor_attempt_started pair via spawnRetryAttempt). */
export async function materializeSession(
  deps: {
    adapter: ConductorAdapter;
    envelopeDefaults?: ConductorEnvelopeDefaults;
  },
  params: {
    planId: string;
    stepIndex: number;
    taskId: string;
    promptText: string;
    check?: PlanStepCheck;
    executor: ExecutorKind;
    selectedBackend?: SelectedBackendRecord;
    attemptIndex: number;
    /** Omitted on the first conduct (createWorktree without an attemptIndex), set on retries. */
    createWorktreeAttemptIndex?: number;
    previousAttempt?: PreviousAttemptFeedback | null;
  },
): Promise<{
  worktreePath: string;
  envelopeHash: string;
  surface: string;
  envelope: AutonomyEnvelope;
}> {
  const wt = await deps.adapter.createWorktree({
    planId: params.planId,
    stepIndex: params.stepIndex,
    ...(params.createWorktreeAttemptIndex !== undefined
      ? { attemptIndex: params.createWorktreeAttemptIndex }
      : {}),
  });
  const envelope = buildEnvelope({
    planId: params.planId,
    stepIndex: params.stepIndex,
    taskId: params.taskId,
    worktreePath: wt.path,
    executor: params.executor,
    selectedBackend: params.selectedBackend,
    forbiddenDecisionClasses: deps.envelopeDefaults?.forbiddenDecisionClasses,
    allowedType2Actions: deps.envelopeDefaults?.allowedType2Actions,
  });
  const hash = envelopeHash(envelope);
  const prompt = buildPrompt(
    params.promptText,
    envelope,
    params.check,
    params.previousAttempt ?? null,
  );
  await deps.adapter.writeEnvelopeFile(wt.path, envelope, prompt);
  const session = await deps.adapter.spawnSession({
    worktreePath: wt.path,
    stepIndex: params.stepIndex,
    taskId: params.taskId,
    prompt,
    executor: params.executor,
    attemptIndex: params.attemptIndex,
  });
  return { worktreePath: wt.path, envelopeHash: hash, surface: session.surface, envelope };
}

/** The 2-event spawn tail shared by redispatch + resume (token-exhaustion retry and post-escalation
 *  resume produce byte-identical session_spawned/executor_attempt_started bodies; only the tags and
 *  the session_spawned related_to differ). Stamps distinct chronological ids via at(0)/at(1). */
export async function spawnRetryAttempt(
  workspaceDir: string,
  deps: {
    adapter: ConductorAdapter;
    envelopeDefaults?: ConductorEnvelopeDefaults;
  },
  params: {
    planId: string;
    stepIndex: number;
    taskId: string;
    promptText: string;
    check?: PlanStepCheck;
    executor: ExecutorKind;
    selectedBackend: SelectedBackendRecord;
    attemptIndex: number;
    previousAttempt?: PreviousAttemptFeedback | null;
    sessionTags: string[];
    sessionRelatedTo: string[];
    attemptTags: string[];
  },
  now: Date,
  rand: number,
): Promise<ConductStepReport> {
  const at = (i: number) => new Date(now.getTime() + i * 1000);
  const m = await materializeSession(deps, {
    planId: params.planId,
    stepIndex: params.stepIndex,
    taskId: params.taskId,
    promptText: params.promptText,
    check: params.check,
    executor: params.executor,
    selectedBackend: params.selectedBackend,
    attemptIndex: params.attemptIndex,
    createWorktreeAttemptIndex: params.attemptIndex,
    previousAttempt: params.previousAttempt,
  });

  const sessionEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(0), rand),
      type: "session_spawned",
      source: "hermes",
      actor: "conductor",
      tags: params.sessionTags,
      related_to: params.sessionRelatedTo,
    },
    body: JSON.stringify({
      surface: m.surface,
      worktree: m.worktreePath,
      envelopeHash: m.envelopeHash,
      envelope: m.envelope,
      selectedBackend: params.selectedBackend,
      attemptIndex: params.attemptIndex,
    }),
  };
  await writeEvent(workspaceDir, sessionEvt, at(0));

  const attemptStartedEvt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(1), rand),
      type: "executor_attempt_started",
      source: "hermes",
      actor: "conductor",
      tags: params.attemptTags,
      related_to: [params.taskId],
    },
    body: JSON.stringify({ attemptIndex: params.attemptIndex, backend: params.selectedBackend }),
  };
  await writeEvent(workspaceDir, attemptStartedEvt, at(1));

  return {
    stepIndex: params.stepIndex,
    taskId: params.taskId,
    surface: m.surface,
    worktreePath: m.worktreePath,
    envelopeHash: m.envelopeHash,
    attemptIndex: params.attemptIndex,
  };
}

export async function writeExecutorStall(
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
      eventReferences(e, taskId) &&
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

export function eventReferences(event: GovEvent, id: string): boolean {
  for (const ref of event.frontmatter.related_to ?? []) {
    if (ref === id) return true;
  }
  return false;
}

export function sessionSpawnCountForTask(all: readonly GovEvent[], taskId: string): number {
  let count = 0;
  for (const event of all) {
    if (event.frontmatter.type === "session_spawned" && eventReferences(event, taskId)) {
      count++;
    }
  }
  return count;
}

export function latestSessionSpawnByRelatedId(all: readonly GovEvent[]): Map<string, GovEvent> {
  const latestSpawnByRelatedId = new Map<string, GovEvent>();
  for (const event of all) {
    if (event.frontmatter.type !== "session_spawned") continue;
    for (const relatedId of event.frontmatter.related_to ?? []) {
      const latest = latestSpawnByRelatedId.get(relatedId);
      if (!latest || event.frontmatter.id > latest.frontmatter.id) {
        latestSpawnByRelatedId.set(relatedId, event);
      }
    }
  }
  return latestSpawnByRelatedId;
}

export function taskLinkWithFirstOtherRef(
  event: GovEvent,
  taskId: string,
): { firstOtherRef: string } | null {
  let referencesTask = false;
  let firstOtherRef: string | null = null;
  for (const ref of event.frontmatter.related_to ?? []) {
    if (ref === taskId) {
      referencesTask = true;
    } else if (!firstOtherRef) {
      firstOtherRef = ref;
    }
  }
  return referencesTask && firstOtherRef ? { firstOtherRef } : null;
}
