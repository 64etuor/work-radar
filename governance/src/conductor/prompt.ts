import type { AutonomyEnvelope } from "./envelope.ts";
import type { PlanStepCheck } from "./conductor.ts";
import { previousAttemptLines, type PreviousAttemptFeedback } from "./attemptFeedback.ts";

/** What will certify this step's completion — told to the executor up front (P2c). Previously a
 *  checkless step dead-ended at needs_human AFTER execution with the session never warned, and a
 *  checked step's contract lived only in the plan body the session never saw. */
export function completionCertificationLines(check?: PlanStepCheck): string[] {
  const head = "## Completion certification";
  if (check?.kind === "human") {
    return [
      head,
      "This step declares check: human — completion requires human certification. No command or",
      "artifact will auto-complete it: finish the work, call complete_task, and an operator certifies.",
    ];
  }
  const contract: string[] = [];
  if (check?.command) contract.push(`- this command must exit 0 (run in your worktree): ${check.command}`);
  if (check?.artifact) contract.push(`- this artifact must exist (worktree-relative): ${check.artifact}`);
  if (contract.length > 0) {
    return [
      head,
      "After your session ends, completion is certified by this deterministic check:",
      ...contract,
      "Make it pass before calling complete_task — otherwise the step parks at needs_human.",
    ];
  }
  return [
    head,
    "This step declares NO machine check contract — after your session ends, completion requires",
    "HUMAN certification (the step parks at needs_human until an operator certifies it).",
  ];
}

/** The spawn prompt = step text + inlined envelope + the escalate-and-stop contract (design §6)
 *  + the completion-certification contract (P2c) + the previous-attempt failure feedback (P4c —
 *  only when the bound task has recorded FAILED attempts; first attempts are byte-identical). */
export function buildPrompt(
  stepText: string,
  envelope: AutonomyEnvelope,
  check?: PlanStepCheck,
  previousAttempt?: PreviousAttemptFeedback | null,
): string {
  return [
    `# Conductor-dispatched step ${envelope.stepIndex} (task ${envelope.taskId})`,
    "",
    stepText,
    "",
    "## Autonomy envelope",
    "```json",
    JSON.stringify(envelope, null, 2),
    "```",
    "",
    "Type-2 micro-decisions inside allowedPathGlobs are yours. The instant you hit a Type-1",
    "boundary / new dependency / invariant conflict / ambiguous intent, call",
    `escalate(question, options[], relatedTaskId='${envelope.taskId}') and STOP. You have NO`,
    "approve/reject/choose.",
    "",
    "## Required final action (do NOT skip)",
    `When the step's work is complete and no Type-1 boundary is open, your FINAL action MUST be the`,
    `tool call complete_task('${envelope.taskId}'). This is a verdict-free hint to the conductor's`,
    "completion evaluator; it does NOT certify completion by itself. If you are blocked or uncertain,",
    "call escalate(...) and stop instead.",
    "",
    ...completionCertificationLines(check),
    ...(previousAttempt ? ["", ...previousAttemptLines(previousAttempt)] : []),
  ].join("\n");
}
