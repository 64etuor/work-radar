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
import { autoDispatch } from "./dispatch/dispatch.ts";
import type { ConductorAdapter } from "../conductor/adapter.ts";
import type { ExecutorKind } from "../conductor/envelope.ts";
import type { ConductorEnvelopeDefaults } from "../conductor/handlers.ts";
import type { ExecutorViabilityProbes } from "../conductor/handlers.ts";
import { resumeChosenEscalation } from "../conductor/handlers.ts";
import type { ReadinessReport } from "../live/readiness.ts";
import type { AutonomyLevel, AutoMode, ResolvedPolicy } from "../repo/config.ts";
import type { ResolveBudgetContext } from "../backends/resolve.ts";
import type { UnmergedPlanBranch } from "../repo/planBranches.ts";

/** Stable reason categories (a contract for cron alerting / dashboards / tests — NOT events). */
export type TickOutcome =
  | "advanced" // conducted >=1 ready step this tick
  | "idle" // nothing to do (no active non-terminal plan with pending work)
  | "in_flight" // active plan(s) exist but their step is already running — wait for next tick
  | "halted_decision" // an open decision_blocked — human must choose
  | "needs_human" // completion evaluator could not pass deterministically — human must inspect
  | "stalled" // a crashed-session in-flight task — human must re-dispatch/recover
  | "readiness_failed" // infra ok but posture not unattended-safe (e.g. observer not live)
  | "infra_failed" // preflight infra missing (cmux/git)
  | "locked"; // another tick holds the workspace mutex — benign no-op (CLI-level; runTick never returns this)

/** Clamp --max-steps to [1, ceiling] (ceiling from BOULE_TICK_MAX, default 10). The blast-radius
 *  bound is ALWAYS finite — a tick can never become an unbounded run (INVARIANT #5). */
export function clampMaxSteps(raw: string | boolean | undefined, ceilingRaw?: string): number {
  const ceiling = Math.max(1, Number.isInteger(Number(ceilingRaw)) ? Number(ceilingRaw) : 10);
  const n = typeof raw === "string" ? Number(raw) : 1;
  if (!Number.isInteger(n) || n < 1) return 1;
  return Math.min(n, ceiling);
}

/** outcome → process exit code: 0 ok (advanced/idle/in_flight/locked) · 10 needs-human
 *  (halted/stalled) · 1 broken-env (readiness/infra failed). Lets cron alert on 10 (page a human)
 *  vs 1 (fix infra). "locked" is 0 — a concurrent tick is the system WORKING, not failing. */
export function tickExitCode(outcome: TickOutcome): number {
  if (outcome === "halted_decision" || outcome === "needs_human" || outcome === "stalled") return 10;
  if (outcome === "readiness_failed" || outcome === "infra_failed") return 1;
  return 0; // advanced | idle | in_flight | locked
}

export interface TickReport {
  outcome: TickOutcome;
  conducted: number;
  specsAccepted: number;
  plansAccepted: number;
  haltedPlans: string[];
  stalledCount: number;
  blockers: string[];
  warnings: string[];
  /** P3c — attached by the CLI AFTER runTick (never set here): the opt-in outbound
   *  escalation-sync hook's outcome. Absent when the repo doesn't configure `escalationSync`. */
  escalationSync?: "ok" | "failed" | "skipped";
  /** P4a — attached by the CLI AFTER runTick (never set here): completed-but-unmerged
   *  `boule/<planId>` branches awaiting HUMAN merge-back (R5 — finished work must not strand
   *  silently). Absent when the git listing failed (fail-soft observability, never a gate);
   *  `[]` when there are genuinely none. Additive JSON only — the app's Rust TickReport
   *  deserializer ignores unknown fields (no deny_unknown_fields), proven by `escalationSync`. */
  unmergedPlanBranches?: UnmergedPlanBranch[];
}

export interface TickDeps {
  adapter: ConductorAdapter;
  executor?: ExecutorKind;
  envelopeDefaults?: ConductorEnvelopeDefaults;
  policy?: ResolvedPolicy;
  budget?: ResolveBudgetContext;
  viability?: ExecutorViabilityProbes;
  /** Pre-computed by the caller (the CLI runs the infra probes + stall count). */
  readiness: ReadinessReport;
  autonomyLevel: AutonomyLevel;
  autoMode: AutoMode;
  /** Hard cap on conducts this tick (blast-radius bound). */
  maxSteps: number;
  /** Stall count the caller already computed (also fed to evaluateReadiness) — avoids a re-read and
   *  categorizes the not-ready outcome structurally (no blocker-string regex). */
  stalledCount: number;
  completionDeps?: CompletionDeps;
  /** Completion-gate options (P2b): when the resolved policy configures `backends.evaluator`, the
   *  CLI passes { policy, evaluate, readWorktreeDiff } so the LLM evaluator rung is reachable from
   *  the tick path. Omitted ⇒ byte-identical legacy behavior (deterministic rung only). */
  completionOptions?: CompletionRunOptions;
}

/** One bounded heartbeat: readiness gate → halt/stall gate → autoAccept(level) → autoDispatch(<=N).
 *  NO sleep/poll/retry loop (INVARIANT #5: cadence is external — the cron is the clock). Never
 *  resolves a decision or recovers a stall (INVARIANT #1: it reports and stops). Returns a
 *  structured report; the CLI maps the outcome to an exit code. */
export async function runTick(
  workspaceDir: string,
  deps: TickDeps,
  now: Date,
  rand: number,
): Promise<TickReport> {
  const base = {
    conducted: 0,
    specsAccepted: 0,
    plansAccepted: 0,
    haltedPlans: [] as string[],
    stalledCount: deps.stalledCount,
    blockers: deps.readiness.blockers,
    warnings: deps.readiness.warnings,
  };

  // Gate 1 — readiness (infra + unattended posture; readiness already folds the stall guard).
  // Categorize structurally (no blocker-string parsing): infra first, then stall, then posture.
  if (!deps.readiness.ready) {
    const outcome: TickOutcome = !deps.readiness.preflight.ready
      ? "infra_failed"
      : deps.stalledCount > 0
        ? "stalled"
        : "readiness_failed";
    return { ...base, outcome };
  }

  // Gate 2 — halt (readiness does not cover an open decision_blocked). Stop, do not advance past it.
  const all = await readAllEvents(workspaceDir);
  const activeStates = plansOf(all).flatMap((p) => {
    const state = deriveConductorState(p, all);
    return isTerminalPlanPhase(state.planPhase) ? [] : [state];
  });
  const haltedPlans = activeStates.flatMap((s) => (s.halted ? [s.planId] : []));
  if (haltedPlans.length) return { ...base, outcome: "halted_decision", haltedPlans };

  // Gate 2.5 — post-choose resume. A task whose escalation a human just resolved must be
  // re-dispatched WITH the decision BEFORE the completion gate runs: the gate would re-check work
  // the escalated session declined to do and park the tick at needs_human forever (live limbo
  // 2026-06-10). Dispatch-gated like autoDispatch — at autoMode "off" (manual) the human dispatches.
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

  const completion = await completeReportedDone(
    workspaceDir,
    deps.completionDeps,
    now,
    rand,
    deps.completionOptions,
  );
  if (completion.needsHuman > 0) {
    // Name the task, step, check, and reason — a bare count sent operators spelunking raw event
    // files to find WHICH step was stuck and why (live 2026-06-10).
    const details = completion.needsHumanDetails.map(
      (d) =>
        `needs_human: plan ${d.planId} step ${d.stepIndex} task ${d.taskId} — ${d.reason}` +
        (d.checkCommand ? ` (check: ${d.checkCommand})` : ""),
    );
    return {
      ...base,
      outcome: "needs_human",
      blockers: [
        ...base.blockers,
        `${completion.needsHuman} completion check(s) need a human`,
        ...details,
      ],
    };
  }

  // Conduct — auto-accept per autonomyLevel (orchestrator-only; honest actor:system), then advance
  // at most maxSteps ready steps (the cap is enforced under the dispatch boundary).
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
    deps.maxSteps,
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
  // Nothing conducted: in_flight ONLY if a step is actually RUNNING (a materialized task in `active`
  // phase) — NOT merely a non-terminal plan. A draft awaiting human accept (at dispatch) or a
  // needs_revision plan has no active task ⇒ idle (the tick can't advance it; it's not "running").
  // (A crashed-session active task is caught earlier by the readiness stall guard.)
  const after = await readAllEvents(workspaceDir);
  const running = projectTasks(after).some((t) => t.phase === "active");
  return {
    ...base,
    outcome: running ? "in_flight" : "idle",
    specsAccepted: acc.specsAccepted,
    plansAccepted: acc.plansAccepted,
  };
}
