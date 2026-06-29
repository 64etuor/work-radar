import type { ConductorAdapter } from "../../conductor/adapter.ts";
import type { ExecutorKind } from "../../conductor/envelope.ts";
import { deriveConductorState } from "../../conductor/conductor.ts";
import {
  conductPlan,
  redispatchExecutorAttempt,
  type ConductorEnvelopeDefaults,
} from "../../conductor/handlers.ts";
import type { ExecutorViabilityProbes } from "../../conductor/handlers.ts";
import { readAllEvents } from "../../decision/readEvents.ts";
import type { GovEvent } from "../../event/event.ts";
import { generateId } from "../../event/id.ts";
import { writeEvent } from "../../event/writeEvent.ts";
import { plansOf } from "../../plan/plan.ts";
import { evaluateAutoDispatch, isTerminalPlanPhase, type AutoMode } from "./policy.ts";
import type { ResolveBudgetContext } from "../../backends/resolve.ts";
import type { ResolvedPolicy } from "../../repo/config.ts";

// IMPORTANT: this module imports ZERO decision write handlers. Its own writes are only the four
// verdict-free dispatch events; decision resolution remains human-gated elsewhere.

export interface DispatchSummary {
  executed: number;
  failed: number;
  denied: number;
  skipped: number;
}

const SEP = " ";
const DEFAULT_MAX_CONDUCTS = 5;

function materializedKey(planId: string, stepIndex: number): string {
  return `mat${SEP}${planId}${SEP}${stepIndex}`;
}

function deniedKey(planId: string, stepIndex: number | null, reason: string): string {
  return `denied${SEP}${planId}${SEP}${stepIndex}${SEP}${reason}`;
}

function safeBody(body: string): { planId?: string; stepIndex?: number; reason?: string } {
  try {
    return JSON.parse(body) as { planId?: string; stepIndex?: number; reason?: string };
  } catch {
    return {};
  }
}

function dispatchEvent(
  type: GovEvent["frontmatter"]["type"],
  planId: string,
  body: object,
  stamp: Date,
  rand: number,
  extraRelated: string[] = [],
): GovEvent {
  return {
    frontmatter: {
      id: generateId("evt", stamp, rand),
      type,
      source: "system",
      actor: "system",
      tags: ["orchestrator", "dispatch"],
      related_to: [planId, ...extraRelated],
    },
    body: JSON.stringify(body),
  };
}

/** One on-demand pass over current plan_proposed events. Off mode writes nothing. */
export async function autoDispatch(
  workspaceDir: string,
  deps: {
    adapter: ConductorAdapter;
    executor?: ExecutorKind;
    envelopeDefaults?: ConductorEnvelopeDefaults;
    policy?: ResolvedPolicy;
    budget?: ResolveBudgetContext;
    viability?: ExecutorViabilityProbes;
  },
  mode: AutoMode,
  now: Date,
  rand: number,
  /** Hard cap on CONDUCTS this pass (the blast-radius bound enforced under the dispatch boundary —
   *  `boule tick --max-steps`). Default stays bounded for direct MCP auto_dispatch calls. */
  maxConducts: number = DEFAULT_MAX_CONDUCTS,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { executed: 0, failed: 0, denied: 0, skipped: 0 };
  if (mode !== "type2") return summary;

  const all = await readAllEvents(workspaceDir);
  const existing = new Set<string>();
  for (const e of all) {
    const body = safeBody(e.body);
    if (e.frontmatter.type === "step_bound" && body.planId && typeof body.stepIndex === "number") {
      existing.add(materializedKey(body.planId, body.stepIndex));
    } else if (e.frontmatter.type === "action_denied" && body.planId && body.reason) {
      existing.add(
        deniedKey(
          body.planId,
          typeof body.stepIndex === "number" ? body.stepIndex : null,
          body.reason,
        ),
      );
    }
  }

  let offset = 0;
  const nextStamp = () => new Date(now.getTime() + offset++ * 1000);

  for (const planProposed of plansOf(all)) {
    if (summary.executed >= maxConducts) break; // blast-radius cap reached → rest waits for next tick
    const conductor = deriveConductorState(planProposed, all);
    if (isTerminalPlanPhase(conductor.planPhase)) continue;

    if (summary.executed < maxConducts && conductor.planPhase === "active" && !conductor.halted && !conductor.done) {
      const retryNow = new Date(now.getTime() + offset * 1000);
      offset += 2;
      try {
        const retry = await redispatchExecutorAttempt(
          workspaceDir,
          { planId: conductor.planId },
          deps,
          retryNow,
          rand,
        );
        if (retry.kind === "advanced") {
          const outcomeAt = nextStamp();
          await writeEvent(
            workspaceDir,
            dispatchEvent(
              "orchestrator_action_executed",
              conductor.planId,
              {
                planId: conductor.planId,
                stepIndex: retry.advanced.stepIndex,
                taskId: retry.advanced.taskId,
                attemptIndex: retry.advanced.attemptIndex,
              },
              outcomeAt,
              rand,
              [retry.advanced.taskId],
            ),
            outcomeAt,
          );
          summary.executed++;
          continue;
        }
        if (retry.kind === "stalled") {
          const outcomeAt = nextStamp();
          await writeEvent(
            workspaceDir,
            dispatchEvent(
              "orchestrator_action_failed",
              conductor.planId,
              {
                planId: conductor.planId,
                stepIndex: retry.stepIndex,
                taskId: retry.taskId,
                reason: retry.reason,
              },
              outcomeAt,
              rand,
              [retry.taskId],
            ),
            outcomeAt,
          );
          summary.failed++;
          continue;
        }
      } catch (err) {
        const outcomeAt = nextStamp();
        const reason = err instanceof Error ? err.message : String(err);
        await writeEvent(
          workspaceDir,
          dispatchEvent(
            "orchestrator_action_failed",
            conductor.planId,
            { planId: conductor.planId, stepIndex: conductor.cursor, reason },
            outcomeAt,
            rand,
          ),
          outcomeAt,
        );
        summary.failed++;
        continue;
      }
    }

    const verdict = evaluateAutoDispatch(conductor, mode);
    if (verdict.decision === "deny") {
      const key = deniedKey(verdict.planId, conductor.cursor, verdict.reason);
      if (existing.has(key)) {
        summary.skipped++;
        continue;
      }
      const stamp = nextStamp();
      await writeEvent(
        workspaceDir,
        dispatchEvent(
          "action_denied",
          verdict.planId,
          { planId: verdict.planId, stepIndex: conductor.cursor, reason: verdict.reason },
          stamp,
          rand,
        ),
        stamp,
      );
      existing.add(key);
      summary.denied++;
      continue;
    }

    const matKey = materializedKey(verdict.planId, verdict.stepIndex);
    if (existing.has(matKey)) {
      summary.skipped++;
      continue;
    }

    const plannedAt = nextStamp();
    await writeEvent(
      workspaceDir,
      dispatchEvent(
        "instruction_planned",
        verdict.planId,
        { planId: verdict.planId, stepIndex: verdict.stepIndex },
        plannedAt,
        rand,
      ),
      plannedAt,
    );

    const conductNow = new Date(now.getTime() + offset * 1000);
    offset += 5;
    try {
      const result = await conductPlan(
        workspaceDir,
        { planId: verdict.planId },
        deps,
        conductNow,
        rand,
      );
      const outcomeAt = nextStamp();
      if (result.ok && result.advanced) {
        await writeEvent(
          workspaceDir,
          dispatchEvent(
            "orchestrator_action_executed",
            verdict.planId,
            {
              planId: verdict.planId,
              stepIndex: result.advanced.stepIndex,
              taskId: result.advanced.taskId,
            },
            outcomeAt,
            rand,
            [result.advanced.taskId],
          ),
          outcomeAt,
        );
        existing.add(materializedKey(verdict.planId, result.advanced.stepIndex));
        summary.executed++;
      } else {
        await writeEvent(
          workspaceDir,
          dispatchEvent(
            "orchestrator_action_failed",
            verdict.planId,
            { planId: verdict.planId, stepIndex: verdict.stepIndex, reason: result.reason },
            outcomeAt,
            rand,
          ),
          outcomeAt,
        );
        summary.failed++;
      }
    } catch (err) {
      const outcomeAt = nextStamp();
      const reason = err instanceof Error ? err.message : String(err);
      await writeEvent(
        workspaceDir,
        dispatchEvent(
          "orchestrator_action_failed",
          verdict.planId,
          { planId: verdict.planId, stepIndex: verdict.stepIndex, reason },
          outcomeAt,
          rand,
        ),
        outcomeAt,
      );
      summary.failed++;
    }
  }

  return summary;
}
