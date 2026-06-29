import type { GovEvent } from "../event/event.ts";
import { eventsForDecision } from "../decision/readEvents.ts";
import { deriveSessionState } from "../session/session.ts";
import type { ConductorAdapter } from "./adapter.ts";
import type { ExecutorKind } from "./envelope.ts";
import { projectPreviousAttemptFeedback } from "./attemptFeedback.ts";
import { defaultBackendForExecutor, type ConductorEnvelopeDefaults } from "./backend.ts";
import {
  loadConductor,
  spawnRetryAttempt,
  latestSessionSpawnByRelatedId,
  sessionSpawnCountForTask,
  taskLinkWithFirstOtherRef,
  MAX_SESSIONS_PER_TASK,
  type ConductStepReport,
} from "./conductShared.ts";

export interface ResumeChosenEscalationInput {
  planId: string;
}

export type ResumeChosenEscalationResult =
  | { kind: "no_action"; reason: string }
  | { kind: "advanced"; advanced: ConductStepReport };

/** A resolved escalation linked to a task: the human-chosen option + the original question. */
interface ResolvedEscalation {
  decisionId: string;
  question: string;
  chosenLabel: string;
}

/** Find a decision_blocked bound to this task whose fork was RESOLVED (decision_chosen) and not
 *  yet consumed by a resume. Consume-exactly-once is enforced by a DECISION-KEYED marker: every
 *  resume spawn carries the decisionId in related_to, and a resolution with such a marker is never
 *  eligible again — collision-proof regardless of event-id ordering (generateId is second-granular,
 *  so a chosen and a resume spawn in the same second compare arbitrarily). */
function findResolvedEscalation(all: GovEvent[], taskId: string): ResolvedEscalation | null {
  const chosenByDecisionId = new Map<string, GovEvent>();
  const resumedDecisionIds = new Set<string>();
  for (const e of all) {
    if (e.frontmatter.type === "decision_chosen") {
      for (const ref of e.frontmatter.related_to ?? []) chosenByDecisionId.set(ref, e);
    }
    if (
      e.frontmatter.type === "session_spawned" &&
      (e.frontmatter.tags ?? []).includes("resume")
    ) {
      for (const ref of e.frontmatter.related_to ?? []) resumedDecisionIds.add(ref);
    }
  }

  for (const blocked of all) {
    if (blocked.frontmatter.type !== "decision_blocked") continue;
    const linked = taskLinkWithFirstOtherRef(blocked, taskId);
    if (!linked) continue;
    const decisionId = linked.firstOtherRef;
    const chosen = chosenByDecisionId.get(decisionId);
    if (!chosen) continue;
    // Hard consume-once: a resume spawn already references this decision — never resume it again.
    if (resumedDecisionIds.has(decisionId)) continue;
    const token =
      (chosen.frontmatter.tags ?? [])
        .find((t) => t.startsWith("option:"))
        ?.slice("option:".length) ?? null;
    let chosenLabel = token ?? "(unknown option)";
    let question = "";
    try {
      const body = JSON.parse(blocked.body) as {
        question?: string;
        options?: Array<{ token: string; label: string }>;
      };
      question = body.question ?? "";
      const optionsByToken = new Map(body.options?.map((o) => [o.token, o]) ?? []);
      const opt = token ? optionsByToken.get(token) : undefined;
      if (opt) chosenLabel = `${opt.token} — ${opt.label}`;
    } catch {
      // body unparseable — keep the bare token; the resume context degrades, never blocks
    }
    return { decisionId, question, chosenLabel };
  }
  return null;
}

/** Post-choose resume (live gap 2026-06-10): an executor that escalates exits cleanly, so after
 *  the human resolved the fork the task sat in completion-gate limbo forever — the gate re-ran a
 *  check against work the session explicitly declined to do, and nothing ever re-dispatched. This
 *  pass re-dispatches the step ONCE per resolution with the chosen option appended to the step
 *  prompt. Eligibility is strict: task active + NOT halted (no open block) + latest session
 *  terminal + a decision_chosen bound to the task NEWER than the latest spawn (a resumed session
 *  that escalates again re-halts; each resolution is consumed exactly once). The new worktree is
 *  created through the chained createWorktree, so the resumed session also sees prior steps'
 *  committed output. Human gates stay intact — this only acts AFTER a human chose. Backend
 *  selection is deliberately simple (deps.executor default, NOT the policy backend chain): a
 *  resume continues the same work, not a token-exhaustion fallback; chain-aware resume routing is
 *  a documented follow-up, not an oversight. */
export async function resumeChosenEscalation(
  workspaceDir: string,
  input: ResumeChosenEscalationInput,
  deps: {
    adapter: ConductorAdapter;
    executor?: ExecutorKind;
    envelopeDefaults?: ConductorEnvelopeDefaults;
  },
  now: Date,
  rand: number,
): Promise<ResumeChosenEscalationResult> {
  const { state, all } = await loadConductor(workspaceDir, input.planId);
  const latestSpawnByRelatedId = latestSessionSpawnByRelatedId(all);
  for (const step of state.steps) {
    if (!step.taskId || !step.sessionId) continue;
    if (step.taskPhase !== "active" || step.halted) continue;
    // Latest spawn for the task (resume spawns append here, so ordering self-terminates).
    const latestSpawn = latestSpawnByRelatedId.get(step.taskId);
    if (!latestSpawn) continue;
    // Never spawn beside a live session: the latest one must be terminal.
    const grp = eventsForDecision(all, latestSpawn.frontmatter.id);
    const sess = deriveSessionState(latestSpawn, grp.related);
    if (sess.phase !== "closed" && sess.phase !== "crashed") continue;
    const resolved = findResolvedEscalation(all, step.taskId);
    if (!resolved) continue;
    if (sessionSpawnCountForTask(all, step.taskId) >= MAX_SESSIONS_PER_TASK) {
      return { kind: "no_action", reason: "session spawn cap reached" };
    }

    const executor = deps.executor ?? "claude";
    const nextAttempt = (step.attempts.currentAttemptIndex ?? -1) + 1;
    const stepTextWithDecision =
      `${step.text}\n\n## Resolved decision (human-chosen)\n` +
      (resolved.question ? `${resolved.question}\n\n` : "") +
      `**Chosen:** ${resolved.chosenLabel}\n` +
      `The fork above is RESOLVED — proceed accordingly and do NOT re-escalate the same question.`;
    // P4c: a resume after failed attempts also carries the failure feedback (null when the prior
    // session exited cleanly to escalate — the common resume case — keeping that prompt unchanged).
    // decisionId is the consume-once marker: findResolvedEscalation refuses any resolution a resume
    // spawn already references (id ordering alone is second-granular and collides).
    const advanced = await spawnRetryAttempt(
      workspaceDir,
      deps,
      {
        planId: input.planId,
        stepIndex: step.stepIndex,
        taskId: step.taskId,
        promptText: stepTextWithDecision,
        check: step.check,
        executor,
        selectedBackend: defaultBackendForExecutor(executor),
        attemptIndex: nextAttempt,
        previousAttempt: projectPreviousAttemptFeedback(all, step.taskId),
        sessionTags: ["conductor", "resume"],
        sessionRelatedTo: [step.taskId, resolved.decisionId],
        attemptTags: ["conductor", "attempt-hint", "resume"],
      },
      now,
      rand,
    );

    return { kind: "advanced", advanced };
  }
  return { kind: "no_action", reason: "no resolved-escalation step" };
}
