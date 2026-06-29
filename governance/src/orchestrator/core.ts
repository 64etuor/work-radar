import { readAllEvents } from "../decision/readEvents.ts";
import { plansOf } from "../plan/plan.ts";
import { deriveConductorState } from "../conductor/conductor.ts";
import {
  completeReportedDone,
  type CompletionDeps,
  type CompletionRunOptions,
} from "../conductor/completion.ts";
import { isTerminalPlanPhase } from "./dispatch/policy.ts";
import { projectTasks } from "../task/project.ts";
import { autoAccept } from "./autoAccept.ts";
import { autoDispatch, DEFAULT_MAX_CONDUCTS } from "./dispatch/dispatch.ts";
import { resumeChosenEscalation } from "../conductor/handlers.ts";
import type { ConductorAdapter } from "../conductor/adapter.ts";
import type { ExecutorKind } from "../conductor/envelope.ts";
import type { ConductorEnvelopeDefaults, ExecutorViabilityProbes } from "../conductor/handlers.ts";
import type { AutonomyLevel, AutoMode, ResolvedPolicy } from "../repo/config.ts";
import type { ResolveBudgetContext } from "../backends/resolve.ts";

export { DEFAULT_MAX_CONDUCTS };

/** Shared outcome type for runOrchestrationCore — a strict subset of TickOutcome
 *  (excludes infra_failed / readiness_failed / locked which are tick-CLI concerns). */
export type OrchestrationCoreOutcome =
  | "advanced"
  | "idle"
  | "in_flight"
  | "halted_decision"
  | "needs_human"
  | "stalled";

export interface OrchestrationCoreDeps {
  adapter: ConductorAdapter;
  executor?: ExecutorKind;
  envelopeDefaults?: ConductorEnvelopeDefaults;
  policy?: ResolvedPolicy;
  budget?: ResolveBudgetContext;
  viability?: ExecutorViabilityProbes;
  autonomyLevel: AutonomyLevel;
  autoMode: AutoMode;
  /** Hard cap on conducts this pass. Defaults to DEFAULT_MAX_CONDUCTS. */
  maxSteps?: number;
  /** Pre-computed stall count — caller is responsible for reading listStalledTasks. */
  stalledCount: number;
  completionDeps?: CompletionDeps;
  completionOptions?: CompletionRunOptions;
}

export interface OrchestrationCoreReport {
  outcome: OrchestrationCoreOutcome;
  conducted: number;
  specsAccepted: number;
  plansAccepted: number;
  haltedPlans: string[];
  stalledCount: number;
  blockers: string[];
}

/** The single authority for advancing a plan safely.
 *
 *  Gates (in order):
 *    1. Stall      — crashed/closed-incomplete session blocks all dispatch
 *    2. Halt       — open decision_blocked requires human resolution
 *    3. Resume     — post-choose re-dispatch before the completion gate
 *    4. Completion — deterministic (and optionally LLM) check gate
 *    5. Conduct    — auto-accept then advance ≤ maxSteps ready steps
 *
 *  The infra readiness gate (preflight + observer posture) is deliberately
 *  excluded — it is a tick-CLI concern. The tick lock must be held by the
 *  caller before entering this function to prevent concurrent conduct.
 *
 *  Both `boule tick` and MCP `auto_dispatch` call this function. */
export async function runOrchestrationCore(
  workspaceDir: string,
  deps: OrchestrationCoreDeps,
  now: Date,
  rand: number,
): Promise<OrchestrationCoreReport> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_CONDUCTS;
  const base = {
    conducted: 0,
    specsAccepted: 0,
    plansAccepted: 0,
    haltedPlans: [] as string[],
    stalledCount: deps.stalledCount,
    blockers: [] as string[],
  };

  // Gate 1 — stall: a crashed/closed-incomplete session blocks all dispatch.
  if (deps.stalledCount > 0) {
    return {
      ...base,
      outcome: "stalled",
      blockers: [`${deps.stalledCount} stalled task(s) — resolve before unattended dispatch`],
    };
  }

  // Gate 2 — halt: an open decision_blocked must be resolved by a human first.
  const all = await readAllEvents(workspaceDir);
  const activeStates = plansOf(all).flatMap((p) => {
    const state = deriveConductorState(p, all);
    return isTerminalPlanPhase(state.planPhase) ? [] : [state];
  });
  const haltedPlans = activeStates.flatMap((s) => (s.halted ? [s.planId] : []));
  if (haltedPlans.length) return { ...base, outcome: "halted_decision", haltedPlans };

  // Gate 3 — resume: a task whose escalation was resolved must be re-dispatched
  // WITH the decision BEFORE the completion gate (otherwise the gate re-checks
  // work the session declined to do and parks at needs_human forever).
  if (deps.autoMode !== "off") {
    let resumed = 0;
    for (const s of activeStates) {
      const r = await resumeChosenEscalation(
        workspaceDir,
        { planId: s.planId },
        {
          adapter: deps.adapter,
          ...(deps.executor ? { executor: deps.executor } : {}),
          ...(deps.envelopeDefaults ? { envelopeDefaults: deps.envelopeDefaults } : {}),
        },
        now,
        rand,
      );
      if (r.kind === "advanced") resumed++;
    }
    if (resumed > 0) return { ...base, outcome: "advanced", conducted: resumed };
  }

  // Gate 4 — completion: deterministic (and optionally LLM) check.
  const completion = await completeReportedDone(
    workspaceDir,
    deps.completionDeps,
    now,
    rand,
    deps.completionOptions,
  );
  if (completion.needsHuman > 0) {
    const details = completion.needsHumanDetails.map(
      (d) =>
        `needs_human: plan ${d.planId} step ${d.stepIndex} task ${d.taskId} — ${d.reason}` +
        (d.checkCommand ? ` (check: ${d.checkCommand})` : ""),
    );
    return {
      ...base,
      outcome: "needs_human",
      blockers: [`${completion.needsHuman} completion check(s) need a human`, ...details],
    };
  }

  // Gate 5 — conduct: auto-accept per autonomyLevel then advance ≤ maxSteps.
  const acc = await autoAccept(workspaceDir, deps.autonomyLevel, now, rand);
  const disp = await autoDispatch(
    workspaceDir,
    {
      adapter: deps.adapter,
      executor: deps.executor,
      envelopeDefaults: deps.envelopeDefaults,
      policy: deps.policy,
      budget: deps.budget,
      viability: deps.viability,
    },
    deps.autoMode,
    now,
    rand,
    maxSteps,
  );

  if (disp.executed > 0) {
    return {
      ...base,
      outcome: "advanced",
      conducted: disp.executed,
      specsAccepted: acc.specsAccepted,
      plansAccepted: acc.plansAccepted,
    };
  }

  // Nothing conducted: in_flight only if a step is actually RUNNING.
  const after = await readAllEvents(workspaceDir);
  const running = projectTasks(after).some((t) => t.phase === "active");
  return {
    ...base,
    outcome: running ? "in_flight" : "idle",
    specsAccepted: acc.specsAccepted,
    plansAccepted: acc.plansAccepted,
  };
}
