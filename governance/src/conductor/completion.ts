import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { BackendSpec } from "../backends/config.ts";
import { runWithFallback, type AttemptError } from "../backends/fallback.ts";
import { planBranchName } from "./adapter.ts";
import { deriveConductorState, type PlanStepCheck } from "./conductor.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import type { GovEvent } from "../event/event.ts";
import { plansOf } from "../plan/plan.ts";
import { sessionsOf, deriveSessionState, type SessionState } from "../session/session.ts";
import { completeTask } from "../task/handlers.ts";
import type { ResolvedPolicy } from "../repo/config.ts";

export interface CompletionDeps {
  pathExists(path: string): Promise<boolean>;
  runCommand(command: string, cwd: string | null): Promise<{ status: number | null }>;
  /** Step chaining (optional dep — fakes without it keep legacy no-chain behavior): after the
   *  completion gate passes, commit the step worktree's changes and advance the plan branch
   *  (`planBranchName`) so the next step's worktree sees them. `committed:false` = clean tree
   *  (nothing to chain). A failure must NOT complete the task — the caller degrades to
   *  needs_human (fail-closed: never mark a step done with its output left unchained). */
  commitStepOutput?(input: {
    worktreePath: string;
    planId: string;
    stepIndex: number;
  }): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }>;
}

export const nodeCompletionDeps: CompletionDeps = {
  async pathExists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  async runCommand(command, cwd) {
    const r = spawnSync(command, { cwd: cwd ?? undefined, shell: true, stdio: "ignore" });
    return { status: r.status };
  },
  async commitStepOutput({ worktreePath, planId, stepIndex }) {
    // All ops are -C <worktree> (detached HEAD) — the user tree is never touched (INVARIANT #6).
    // .boule/ and node_modules are gitignored, so add -A stages only real step output.
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", worktreePath, ...args], { stdio: "ignore" }).status;
    if (git("add", "-A") !== 0) return { ok: false, error: "git add -A failed" };
    const staged = git("diff", "--cached", "--quiet");
    if (staged === 0) return { ok: true, committed: false }; // clean tree — nothing to chain
    if (staged !== 1) return { ok: false, error: "git diff --cached --quiet failed" };
    // --no-verify: husky's pre-commit (cargo fmt / lint-staged) is the interactive tree's gate;
    // chain commits are internal artifacts re-verified by each step's boule:check.
    if (git("commit", "--no-verify", "-m", `boule(${planId}): step ${stepIndex} output`) !== 0)
      return { ok: false, error: "git commit failed" };
    // Boule's own worktrees are all detached, so the branch is normally never checked out; if an
    // operator has it checked out (e.g. mid merge-back), branch -f fails here and we fail closed.
    if (git("branch", "-f", planBranchName(planId), "HEAD") !== 0)
      return { ok: false, error: "git branch -f failed" };
    return { ok: true, committed: true };
  },
};

export type CompletionDecision = "pass" | "needs_human" | "wait";
export type EvaluationVerdict = "pass" | "fail" | "inconclusive";
export interface EvaluationRequest {
  taskId: string;
  sessionId: string;
  stepPrompt: string;
  worktreeDiff: string;
  backend: BackendSpec;
}
export type EvaluateFnResult =
  | { ok: true; verdict: EvaluationVerdict; rationale: string }
  | { ok: false; error: AttemptError };
export type EvaluateFn = (req: EvaluationRequest) => Promise<EvaluateFnResult>;

export interface CompletionGateOptions {
  policy?: ResolvedPolicy;
  evaluate?: EvaluateFn;
}

export interface CompletionRunOptions extends CompletionGateOptions {
  readWorktreeDiff?: (worktreePath: string | null) => Promise<string>;
}

export interface CompletionGateInput {
  taskId: string;
  sessionId: string;
  taskActive: boolean;
  sessionTerminal: boolean;
  hasHint: boolean;
  stepPrompt?: string;
  worktreeDiff?: string;
  check?: PlanStepCheck;
  worktreePath: string | null;
}
export interface CompletionGateResult {
  decision: CompletionDecision;
  reason: string;
}

const DETERMINISTIC_RUNG: BackendSpec = { provider: "deterministic" };

function evaluatorChain(policy: ResolvedPolicy | undefined): BackendSpec[] {
  const configured = policy?.backends?.evaluator?.chain;
  if (!configured) return [DETERMINISTIC_RUNG];
  return [...configured.filter((spec) => spec.provider !== "deterministic"), DETERMINISTIC_RUNG];
}

async function evaluateDeterministicCheck(
  input: CompletionGateInput,
  deps: CompletionDeps,
): Promise<{ verdict: EvaluationVerdict; rationale: string }> {
  if (!input.check?.command && !input.check?.artifact) {
    return { verdict: "fail", rationale: "no deterministic check contract" };
  }

  if (input.check.command) {
    try {
      const r = await deps.runCommand(input.check.command, input.worktreePath);
      if (r.status === 0) return { verdict: "pass", rationale: "check.command exited 0" };
    } catch {
      // fall through to artifact, if present; otherwise fail closed below.
    }
  }

  if (input.check.artifact) {
    const artifactPath = isAbsolute(input.check.artifact)
      ? input.check.artifact
      : join(input.worktreePath ?? "", input.check.artifact);
    if (await deps.pathExists(artifactPath)) {
      return { verdict: "pass", rationale: "check.artifact exists" };
    }
  }

  return { verdict: "fail", rationale: "deterministic check was not satisfied" };
}

export async function evaluateCompletionGate(
  input: CompletionGateInput,
  deps: CompletionDeps,
  options: CompletionGateOptions = {},
): Promise<CompletionGateResult> {
  if (!input.taskActive) return { decision: "wait", reason: "task is not active" };
  if (!input.sessionTerminal) return { decision: "wait", reason: "session is not terminal" };
  if (!input.hasHint) return { decision: "wait", reason: "no executor_reported_done hint" };

  let lastRationale = "no evaluator rung passed";
  const fallback = await runWithFallback<CompletionGateResult>(
    "evaluator",
    evaluatorChain(options.policy),
    async (backend) => {
      const result =
        backend.provider === "deterministic"
          ? { ok: true as const, ...(await evaluateDeterministicCheck(input, deps)) }
          : options.evaluate
            ? await options.evaluate({
                taskId: input.taskId,
                sessionId: input.sessionId,
                stepPrompt: input.stepPrompt ?? "",
                worktreeDiff: input.worktreeDiff ?? "",
                backend,
              })
            : { ok: false as const, error: { kind: "token_exhausted" as const } };

      if (!result.ok) return result;
      lastRationale = result.rationale;
      if (result.verdict === "pass") {
        return { ok: true, value: { decision: "pass", reason: result.rationale } };
      }
      // A non-pass judgement is not a completion signal. Continue to later rungs; exhaustion still
      // terminates as evaluator:needs_human via runWithFallback.
      return { ok: false, error: { kind: "transient" } };
    },
  );
  if (fallback.ok) return fallback.value;
  return { decision: "needs_human", reason: lastRationale };
}

export interface CompletionPassSummary {
  completed: number;
  needsHuman: number;
  waited: number;
}

function bodySessionId(evt: GovEvent): string | null {
  try {
    const v = (JSON.parse(evt.body) as { sessionId?: unknown }).sessionId;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

function hintsFor(all: GovEvent[], taskId: string, sessionId: string): GovEvent[] {
  return all.filter((e) => {
    if (e.frontmatter.type !== "executor_reported_done") return false;
    const related = e.frontmatter.related_to ?? [];
    if (!related.includes(taskId)) return false;
    const bodySession = bodySessionId(e);
    return related.includes(sessionId) || bodySession === sessionId || (!bodySession && related.length === 1);
  });
}

function sessionById(all: GovEvent[]): Map<string, SessionState> {
  const out = new Map<string, SessionState>();
  for (const birth of sessionsOf(all)) {
    const grp = eventsForDecision(all, birth.frontmatter.id);
    out.set(birth.frontmatter.id, deriveSessionState(birth, grp.related));
  }
  return out;
}

function isSessionTerminal(s: SessionState | undefined): boolean {
  return s?.phase === "closed" || s?.phase === "crashed";
}

export async function completeReportedDone(
  workspaceDir: string,
  deps: CompletionDeps = nodeCompletionDeps,
  now: Date,
  rand: number,
  options: CompletionRunOptions = {},
): Promise<CompletionPassSummary> {
  const summary: CompletionPassSummary = { completed: 0, needsHuman: 0, waited: 0 };
  const all = await readAllEvents(workspaceDir);
  const sessions = sessionById(all);
  let offset = 0;

  for (const plan of plansOf(all)) {
    const conductor = deriveConductorState(plan, all);
    for (const step of conductor.steps) {
      if (!step.taskId || !step.sessionId) continue;
      const worktreeDiff = options.readWorktreeDiff ? await options.readWorktreeDiff(step.worktreePath) : "";
      const result = await evaluateCompletionGate(
        {
          taskId: step.taskId,
          sessionId: step.sessionId,
          taskActive: step.taskPhase === "active",
          sessionTerminal: isSessionTerminal(sessions.get(step.sessionId)),
          hasHint: hintsFor(all, step.taskId, step.sessionId).length > 0,
          stepPrompt: step.text,
          worktreeDiff,
          ...(step.check ? { check: step.check } : {}),
          worktreePath: step.worktreePath,
        },
        deps,
        options,
      );
      if (result.decision === "wait") {
        summary.waited++;
        continue;
      }
      if (result.decision === "needs_human") {
        summary.needsHuman++;
        continue;
      }
      // Chain the passed step's output BEFORE completing the task: commit the worktree and advance
      // the plan branch so the next step's worktree sees it. Fail-closed — a chain failure degrades
      // to needs_human instead of completing a task whose output would be orphaned.
      if (deps.commitStepOutput && step.worktreePath) {
        const chained = await deps.commitStepOutput({
          worktreePath: step.worktreePath,
          planId: plan.frontmatter.id,
          stepIndex: step.stepIndex,
        });
        if (!chained.ok) {
          summary.needsHuman++;
          continue;
        }
      }
      const stamp = new Date(now.getTime() + offset++ * 1000);
      const r = await completeTask(workspaceDir, { taskId: step.taskId }, stamp, rand);
      if (r.ok) summary.completed++;
      else summary.needsHuman++;
    }
  }

  return summary;
}
