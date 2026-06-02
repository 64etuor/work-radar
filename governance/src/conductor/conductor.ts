import type { GovEvent } from "../event/event.ts";
import { eventsForDecision } from "../decision/readEvents.ts";
import { derivePlanState, type PlanPhase } from "../plan/plan.ts";
import { deriveTaskState, type TaskPhase } from "../task/task.ts";
import { hasOpenBlock } from "../task/handlers.ts";

/** One plan step, projected against its (maybe-absent) bound task. */
export interface ConductorStepState {
  stepIndex: number; // 0-based index into the parsed step list
  text: string;
  taskId: string | null; // the step_bound task, or null when unmaterialized
  surface: string | null; // the session_spawned surface, or null
  taskPhase: TaskPhase | null;
  halted: boolean; // this step's task sits on an open decision_blocked
}

export interface ConductorState {
  planId: string;
  planPhase: PlanPhase;
  steps: ConductorStepState[];
  cursor: number | null; // next step to materialize, or null (halted / in-flight / done / inactive)
  halted: boolean; // ANY step has an open block
  done: boolean; // every step materialized AND terminal
}

/** Parse a plan body's numbered steps. The Planner writes `${intent}\n\n1. a\n2. b` (plan/handlers).
 *  We extract every `^\d+\.\s` line in order; the leading intent line and blanks are ignored.
 *  The returned text is the step content with its `N. ` prefix stripped. */
export function parsePlanSteps(planBody: string): string[] {
  const out: string[] = [];
  for (const raw of planBody.split("\n")) {
    const m = raw.match(/^\s*\d+\.\s+(.*\S)\s*$/);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** PURE composing projection over a plan + the full event list. Reads `step_bound`/
 *  `session_spawned` and DELEGATES phase to derivePlanState/deriveTaskState/hasOpenBlock.
 *  Owns NO terminal verdict. Fail-closed on foreign event types (god-fold ban §8).
 *
 *  - planId is the plan_proposed event id; planPhase comes from the human-gated plan fold.
 *  - step k ↔ task via the step_bound whose body.stepIndex===k AND related_to ∋ planId.
 *  - cursor = the lowest unmaterialized step whose every prior step is terminal-done.
 *    A prior step that is active/blocked/ready (in-flight) blocks advancement → cursor null.
 *  - halted = ANY materialized step's task has an open decision_blocked (no auto-default §4.4#1).
 *  - done = every step materialized AND terminal (done|cancelled). */
export function deriveConductorState(planProposed: GovEvent, allEvents: GovEvent[]): ConductorState {
  const planId = planProposed.frontmatter.id;
  const planGrp = eventsForDecision(allEvents, planId);
  const planPhase = derivePlanState(planProposed, planGrp.related).phase;
  const stepTexts = parsePlanSteps(planProposed.body);

  // Index step_bound events: stepIndex → taskId (first binding wins; binds are append-only/immutable).
  const boundTaskByStep = new Map<number, string>();
  for (const e of allEvents) {
    if (e.frontmatter.type !== "step_bound") continue;
    if (!(e.frontmatter.related_to ?? []).includes(planId)) continue;
    const idx = parseStepIndex(e.body);
    const taskId = parseBoundTaskId(e.body);
    if (idx === null || taskId === null) continue;
    if (!boundTaskByStep.has(idx)) boundTaskByStep.set(idx, taskId);
  }

  // surface per task from session_spawned.
  const surfaceByTask = new Map<string, string>();
  for (const e of allEvents) {
    if (e.frontmatter.type !== "session_spawned") continue;
    const taskId = (e.frontmatter.related_to ?? [])[0];
    const surface = parseSurface(e.body);
    if (taskId && surface !== null && !surfaceByTask.has(taskId)) surfaceByTask.set(taskId, surface);
  }

  const steps: ConductorStepState[] = stepTexts.map((text, stepIndex) => {
    const taskId = boundTaskByStep.get(stepIndex) ?? null;
    if (!taskId) {
      return { stepIndex, text, taskId: null, surface: null, taskPhase: null, halted: false };
    }
    const tGrp = eventsForDecision(allEvents, taskId);
    const taskPhase = tGrp.proposal ? deriveTaskState(tGrp.proposal, tGrp.related).phase : null;
    const halted = hasOpenBlock(allEvents, taskId);
    return { stepIndex, text, taskId, surface: surfaceByTask.get(taskId) ?? null, taskPhase, halted };
  });

  const halted = steps.some((s) => s.halted);
  const isTerminal = (s: ConductorStepState) => s.taskPhase === "done" || s.taskPhase === "cancelled";
  const done = steps.length > 0 && steps.every((s) => s.taskId !== null && isTerminal(s));

  // cursor: lowest unmaterialized step with all prior steps terminal-done. A non-terminal prior
  // (active/blocked/ready, OR an open block) means in-flight → advance nothing.
  let cursor: number | null = null;
  if (!halted) {
    for (let k = 0; k < steps.length; k++) {
      const s = steps[k]!;
      if (s.taskId === null) {
        cursor = k;
        break;
      }
      if (!isTerminal(s)) {
        cursor = null; // step k is in-flight → wait
        break;
      }
    }
  }

  return { planId, planPhase, steps, cursor, halted, done };
}

// step_bound / session_spawned bodies are canonical JSON minted by the conductor (handlers.ts).
function parseStepIndex(body: string): number | null {
  try {
    const v = (JSON.parse(body) as { stepIndex?: unknown }).stepIndex;
    return typeof v === "number" && Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}
function parseBoundTaskId(body: string): string | null {
  try {
    const v = (JSON.parse(body) as { taskId?: unknown }).taskId;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}
function parseSurface(body: string): string | null {
  try {
    const v = (JSON.parse(body) as { surface?: unknown }).surface;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}
