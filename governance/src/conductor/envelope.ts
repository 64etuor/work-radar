import { sha256hex } from "../event/id.ts";
import type { AmbiguityKind } from "../escalate/escalate.ts";

/** Which CLI executor a Conductor-spawned session runs (L3, master plan 2026-06-07). Both run on
 *  the SAME worktree + autonomy-envelope substrate and close the loop the same way (the session
 *  calls complete_task / escalate over the executor-role MCP). Default "claude". */
export type ExecutorKind = "claude" | "codex";

/** The autonomy envelope handed to a Conductor-spawned session. Structural fields (worktreePath)
 *  are load-bearing isolation; the glob/action/class fields are ADVISORY prompt contracts + audit
 *  surface in Phase C (design §5 — in-worktree path-glob enforcement is a Phase-D/I follow-up). */
export interface AutonomyEnvelope {
  planId: string;
  stepIndex: number;
  taskId: string;
  worktreePath: string; // the ONLY writable tree (INVARIANT #6); structural via session --cwd
  executor: ExecutorKind; // which CLI runs this step (claude|codex) — audited + tamper-evident
  allowedPathGlobs: string[]; // ADVISORY
  allowedType2Actions: string[]; // ADVISORY whitelist
  forbiddenDecisionClasses: AmbiguityKind[];
  escalationTriggers: string[];
  escalateOnAnyBoundaryCrossing: true; // MUST escalate+halt, never self-resolve
}

export interface BuildEnvelopeInput {
  planId: string;
  stepIndex: number;
  taskId: string;
  worktreePath: string;
  executor?: ExecutorKind;
  allowedPathGlobs?: string[];
  allowedType2Actions?: string[];
  forbiddenDecisionClasses?: AmbiguityKind[];
  escalationTriggers?: string[];
}

/** Default Type-1 boundary classes a spawned session must NEVER self-resolve. */
export const DEFAULT_FORBIDDEN_DECISION_CLASSES: AmbiguityKind[] = [
  "scope",
  "architecture",
  "irreversible-design",
  "security",
  "product-behavior",
  "dependency",
  "data-loss",
];

export const DEFAULT_ESCALATION_TRIGGERS: string[] = [
  "new dependency",
  "invariant conflict",
  "ambiguous intent",
  "boundary crossing",
];

/** Build the envelope with safe defaults. escalateOnAnyBoundaryCrossing is a literal `true`. */
export function buildEnvelope(input: BuildEnvelopeInput): AutonomyEnvelope {
  return {
    planId: input.planId,
    stepIndex: input.stepIndex,
    taskId: input.taskId,
    worktreePath: input.worktreePath,
    executor: input.executor ?? "claude",
    allowedPathGlobs: input.allowedPathGlobs ?? ["**"],
    allowedType2Actions: input.allowedType2Actions ?? ["edit", "test", "lint"],
    forbiddenDecisionClasses: input.forbiddenDecisionClasses ?? DEFAULT_FORBIDDEN_DECISION_CLASSES,
    escalationTriggers: input.escalationTriggers ?? DEFAULT_ESCALATION_TRIGGERS,
    escalateOnAnyBoundaryCrossing: true,
  };
}

/** Canonical JSON: object keys in a fixed, sorted order so the serialization (and its hash) is
 *  byte-stable regardless of construction order. Arrays keep their semantic order. */
export function canonicalEnvelopeJson(env: AutonomyEnvelope): string {
  return JSON.stringify(env, Object.keys(env).sort());
}

/** Tamper-evident hash of the canonical envelope JSON (reuses event sha256hex). */
export function envelopeHash(env: AutonomyEnvelope): string {
  return sha256hex(canonicalEnvelopeJson(env));
}
