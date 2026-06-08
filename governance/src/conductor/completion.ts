import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { deriveConductorState, type PlanStepCheck } from "./conductor.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import type { GovEvent } from "../event/event.ts";
import { plansOf } from "../plan/plan.ts";
import { sessionsOf, deriveSessionState, type SessionState } from "../session/session.ts";
import { completeTask } from "../task/handlers.ts";

export interface CompletionDeps {
  pathExists(path: string): Promise<boolean>;
  runCommand(command: string, cwd: string | null): Promise<{ status: number | null }>;
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
};

export type CompletionDecision = "pass" | "needs_human" | "wait";
export interface CompletionGateInput {
  taskId: string;
  sessionId: string;
  taskActive: boolean;
  sessionTerminal: boolean;
  hasHint: boolean;
  check?: PlanStepCheck;
  worktreePath: string | null;
}
export interface CompletionGateResult {
  decision: CompletionDecision;
  reason: string;
}

export async function evaluateCompletionGate(
  input: CompletionGateInput,
  deps: CompletionDeps,
): Promise<CompletionGateResult> {
  if (!input.taskActive) return { decision: "wait", reason: "task is not active" };
  if (!input.sessionTerminal) return { decision: "wait", reason: "session is not terminal" };
  if (!input.hasHint) return { decision: "wait", reason: "no executor_reported_done hint" };
  if (!input.check?.command && !input.check?.artifact) {
    return { decision: "needs_human", reason: "no deterministic check contract" };
  }

  if (input.check.command) {
    try {
      const r = await deps.runCommand(input.check.command, input.worktreePath);
      if (r.status === 0) return { decision: "pass", reason: "check.command exited 0" };
    } catch {
      // fall through to artifact, if present; otherwise fail closed below.
    }
  }

  if (input.check.artifact) {
    const artifactPath = isAbsolute(input.check.artifact)
      ? input.check.artifact
      : join(input.worktreePath ?? "", input.check.artifact);
    if (await deps.pathExists(artifactPath)) {
      return { decision: "pass", reason: "check.artifact exists" };
    }
  }

  return { decision: "needs_human", reason: "deterministic check was not satisfied" };
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
): Promise<CompletionPassSummary> {
  const summary: CompletionPassSummary = { completed: 0, needsHuman: 0, waited: 0 };
  const all = await readAllEvents(workspaceDir);
  const sessions = sessionById(all);
  let offset = 0;

  for (const plan of plansOf(all)) {
    const conductor = deriveConductorState(plan, all);
    for (const step of conductor.steps) {
      if (!step.taskId || !step.sessionId) continue;
      const result = await evaluateCompletionGate(
        {
          taskId: step.taskId,
          sessionId: step.sessionId,
          taskActive: step.taskPhase === "active",
          sessionTerminal: isSessionTerminal(sessions.get(step.sessionId)),
          hasHint: hintsFor(all, step.taskId, step.sessionId).length > 0,
          ...(step.check ? { check: step.check } : {}),
          worktreePath: step.worktreePath,
        },
        deps,
      );
      if (result.decision === "wait") {
        summary.waited++;
        continue;
      }
      if (result.decision === "needs_human") {
        summary.needsHuman++;
        continue;
      }
      const stamp = new Date(now.getTime() + offset++ * 1000);
      const r = await completeTask(workspaceDir, { taskId: step.taskId }, stamp, rand);
      if (r.ok) summary.completed++;
      else summary.needsHuman++;
    }
  }

  return summary;
}
