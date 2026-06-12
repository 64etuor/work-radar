import type { GovEvent } from "../event/event.ts";
import { eventsForDecision } from "../decision/readEvents.ts";
import { derivePlanState, type PlanPhase } from "../plan/plan.ts";
import { deriveTaskState, type TaskPhase } from "../task/task.ts";
import { hasOpenBlock } from "../task/handlers.ts";
import type { Difficulty } from "../backends/difficulty.ts";
import type { AttemptOutcomeClass } from "../backends/attemptClass.ts";
import type { BackendSpec } from "../backends/config.ts";

export interface PlanStepCheck {
  command?: string;
  artifact?: string;
}

export interface PlanStepRecord {
  text: string;
  difficulty?: Difficulty;
  check?: PlanStepCheck;
}

export interface ExecutorAttemptProjection {
  currentAttemptIndex: number | null;
  latestStartedBackend: BackendSpec | null;
  latestFinishedAttemptIndex: number | null;
  latestFinishedOutcomeClass: AttemptOutcomeClass | null;
  latestFinishedWorktreeDirty: boolean | null;
}

/** One plan step, projected against its (maybe-absent) bound task. */
export interface ConductorStepState {
  stepIndex: number; // 0-based index into the parsed step list
  text: string;
  difficulty?: Difficulty;
  check?: PlanStepCheck;
  taskId: string | null; // the step_bound task, or null when unmaterialized
  sessionId: string | null; // the session_spawned event id, or null
  surface: string | null; // the session_spawned surface, or null
  worktreePath: string | null; // the session_spawned worktree path, or null
  taskPhase: TaskPhase | null;
  halted: boolean; // this step's task sits on an open decision_blocked
  attempts: ExecutorAttemptProjection;
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
export function parsePlanStepRecords(planBody: string): PlanStepRecord[] {
  const records: PlanStepRecord[] = [];
  for (const raw of planBody.split("\n")) {
    const m = raw.match(/^\s*\d+\.\s+(.*\S)\s*$/);
    if (!m) continue;
    records.push(parsePlanStepLine(m[1]!));
  }
  return records;
}

export function parsePlanSteps(planBody: string): string[] {
  return parsePlanStepRecords(planBody).map((s) => s.text);
}

function parsePlanStepLine(line: string): PlanStepRecord {
  const difficultyMarker = line.match(/<!--\s*boule:difficulty\s+(\S+)\s*-->/);
  const difficulty =
    difficultyMarker && isDifficulty(difficultyMarker[1]!) ? difficultyMarker[1] : undefined;
  const checkMarker = line.match(/<!--\s*boule:check\s+(\{.*?\})\s*-->/);
  const text = line
    .replace(/\s*<!--\s*boule:difficulty\s+\S+\s*-->/g, "")
    .replace(/\s*<!--\s*boule:check\s+\{.*?\}\s*-->/g, "")
    .trim();
  if (!checkMarker) {
    return {
      text,
      ...(difficulty ? { difficulty } : {}),
    };
  }
  try {
    const raw: unknown = JSON.parse(checkMarker[1]!);
    const rec = recordOf(raw);
    const command =
      typeof rec.command === "string" && rec.command.trim() ? rec.command.trim() : undefined;
    const artifact =
      typeof rec.artifact === "string" && rec.artifact.trim() ? rec.artifact.trim() : undefined;
    const check = {
      ...(command ? { command } : {}),
      ...(artifact ? { artifact } : {}),
    };
    return {
      text,
      ...(difficulty ? { difficulty } : {}),
      ...(Object.keys(check).length ? { check } : {}),
    };
  } catch {
    return {
      text: line.trim(),
      ...(difficulty ? { difficulty } : {}),
    };
  }
}

function isDifficulty(value: string): value is Difficulty {
  return value === "trivial" || value === "standard" || value === "hard";
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = Reflect.get(value, key);
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
  const stepRecords = parsePlanStepRecords(planProposed.body);

  // Index step_bound events: stepIndex → taskId (first binding wins; binds are append-only/immutable).
  const boundTaskByStep = new Map<number, string>();
  for (const e of allEvents) {
    if (e.frontmatter.type !== "step_bound") continue;
    const related = e.frontmatter.related_to ?? [];
    if (!related.includes(planId)) continue;
    const idx = parseStepIndex(e.body);
    const taskId = parseBoundTaskId(e.body);
    if (idx === null || taskId === null) continue;
    if (!boundTaskByStep.has(idx)) boundTaskByStep.set(idx, taskId);
  }

  // Latest session details per task from session_spawned. A task can have multiple executor
  // attempts; the status projection should point at the latest spawned surface/worktree.
  const sessionByTask = new Map<string, { sessionId: string; surface: string | null; worktreePath: string | null }>();
  for (const e of allEvents) {
    if (e.frontmatter.type !== "session_spawned") continue;
    const taskId = (e.frontmatter.related_to ?? [])[0];
    const surface = parseSurface(e.body);
    const worktreePath = parseWorktreePath(e.body);
    if (taskId) {
      sessionByTask.set(taskId, { sessionId: e.frontmatter.id, surface, worktreePath });
    }
  }

  const steps: ConductorStepState[] = stepRecords.map((step, stepIndex) => {
    const taskId = boundTaskByStep.get(stepIndex) ?? null;
    if (!taskId) {
      return {
        stepIndex,
        text: step.text,
        ...(step.difficulty ? { difficulty: step.difficulty } : {}),
        ...(step.check ? { check: step.check } : {}),
        taskId: null,
        sessionId: null,
        surface: null,
        worktreePath: null,
        taskPhase: null,
        halted: false,
        attempts: emptyAttemptProjection(),
      };
    }
    const tGrp = eventsForDecision(allEvents, taskId);
    const taskPhase = tGrp.proposal ? deriveTaskState(tGrp.proposal, tGrp.related).phase : null;
    const halted = hasOpenBlock(allEvents, taskId);
    const session = sessionByTask.get(taskId);
    return {
      stepIndex,
      text: step.text,
      ...(step.difficulty ? { difficulty: step.difficulty } : {}),
      ...(step.check ? { check: step.check } : {}),
      taskId,
      sessionId: session?.sessionId ?? null,
      surface: session?.surface ?? null,
      worktreePath: session?.worktreePath ?? null,
      taskPhase,
      halted,
      attempts: projectExecutorAttempts(allEvents, taskId),
    };
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

function emptyAttemptProjection(): ExecutorAttemptProjection {
  return {
    currentAttemptIndex: null,
    latestStartedBackend: null,
    latestFinishedAttemptIndex: null,
    latestFinishedOutcomeClass: null,
    latestFinishedWorktreeDirty: null,
  };
}

function projectExecutorAttempts(allEvents: GovEvent[], taskId: string): ExecutorAttemptProjection {
  let currentAttemptIndex: number | null = null;
  let latestStartedBackend: BackendSpec | null = null;
  let latestFinishedAttemptIndex: number | null = null;
  let latestFinishedOutcomeClass: AttemptOutcomeClass | null = null;
  let latestFinishedWorktreeDirty: boolean | null = null;

  for (const e of allEvents) {
    const related = e.frontmatter.related_to ?? [];
    if (!related.includes(taskId)) continue;
    if (e.frontmatter.type === "executor_attempt_started") {
      const body = safeAttemptBody(e.body);
      if (typeof body.attemptIndex !== "number" || !Number.isInteger(body.attemptIndex)) continue;
      if (currentAttemptIndex === null || body.attemptIndex >= currentAttemptIndex) {
        currentAttemptIndex = body.attemptIndex;
        latestStartedBackend = parseBackendSpec(body.backend);
      }
    } else if (e.frontmatter.type === "executor_attempt_finished") {
      const body = safeAttemptBody(e.body);
      if (typeof body.attemptIndex !== "number" || !Number.isInteger(body.attemptIndex)) continue;
      if (
        latestFinishedAttemptIndex === null ||
        body.attemptIndex >= latestFinishedAttemptIndex
      ) {
        latestFinishedAttemptIndex = body.attemptIndex;
        latestFinishedOutcomeClass = parseOutcomeClass(body.outcomeClass);
        latestFinishedWorktreeDirty =
          typeof body.worktreeDirty === "boolean" ? body.worktreeDirty : null;
      }
    }
  }

  return {
    currentAttemptIndex,
    latestStartedBackend,
    latestFinishedAttemptIndex,
    latestFinishedOutcomeClass,
    latestFinishedWorktreeDirty,
  };
}

function safeAttemptBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseOutcomeClass(value: unknown): AttemptOutcomeClass | null {
  if (value === "ok" || value === "token_exhausted" || value === "transient" || value === "fatal")
    return value;
  return null;
}

function parseBackendSpec(value: unknown): BackendSpec | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const provider = rec.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "command" && provider !== "deterministic")
    return null;
  const out: BackendSpec = { provider };
  if (typeof rec.model === "string" && rec.model) out.model = rec.model;
  if (typeof rec.command === "string" && rec.command) out.command = rec.command;
  if (Array.isArray(rec.args) && rec.args.every((arg) => typeof arg === "string"))
    out.args = rec.args;
  return out;
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
function parseWorktreePath(body: string): string | null {
  try {
    const v = (JSON.parse(body) as { worktree?: unknown }).worktree;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}
