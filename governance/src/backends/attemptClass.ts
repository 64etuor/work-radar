import { classifyAttempt } from "./fallback.ts";

export type AttemptOutcomeClass = "ok" | "token_exhausted" | "transient" | "fatal";

export interface AttemptEvidenceInput {
  exitCode: number | null;
  launched: boolean;
  stderrDigest?: string;
}

export function classifyAttemptEvidence(input: AttemptEvidenceInput): AttemptOutcomeClass {
  const classified = classifyAttempt(input.exitCode, input.stderrDigest ?? "");
  if (classified === "ok") return "ok";
  if (classified.kind === "token_exhausted") return "token_exhausted";
  if (!input.launched) return "fatal";
  return classified.kind;
}
