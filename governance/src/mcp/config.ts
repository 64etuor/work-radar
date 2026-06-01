import { normalizeModelId } from "../decision/modelId.ts";

/** Parse BOULE_REVIEW_QUORUM into a positive integer. Junk / <1 / unset → 1.
 *  Fail-closed: an unparseable quorum must never silently LOWER the bar below 1. */
export function parseQuorum(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Parse BOULE_REVIEWER_ARGS (space-separated) → argv for the reviewer CLI.
 *  SAFE-by-default: when unset/blank, run `codex exec` in a **read-only** sandbox, runnable
 *  outside a git repo, without persisting session files — a one-shot adversarial review never
 *  needs to write. (Bare `exec` would inherit codex's workspace-write default, letting a live
 *  reviewer mutate the server's cwd — spec §7 "read-only-default sandbox, never danger-full".)
 *  An explicit value is honored verbatim: the operator opts into whatever sandbox they pass. */
export function parseReviewerArgs(raw: string | undefined): string[] {
  const parts = (raw ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length > 0
    ? parts
    : ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"];
}

/** Parse BOULE_REVIEWER_MODELS (comma list) → trimmed, non-empty, deduped-by-normalized-id
 *  model labels (first spelling of each normalized id wins). Falls back to [fallback] when
 *  the list is unset or empty. */
export function parseReviewerModels(raw: string | undefined, fallback: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const label = part.trim();
    if (!label) continue;
    const key = normalizeModelId(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.length > 0 ? out : [fallback];
}

type Env = Record<string, string | undefined>;

/** Map a model label to its env-var suffix: upper-case, every non-[A-Z0-9] run → a single
 *  `_`, leading/trailing `_` trimmed (e.g. `claude-opus-4-8` → `CLAUDE_OPUS_4_8`).
 *  Deliberately DISTINCT from normalizeModelId (which lowercases for same-model *comparison*) —
 *  this builds the `BOULE_REVIEWER_CMD_<SUFFIX>` env key, a different concern. */
export function reviewerEnvSuffix(model: string): string {
  return model
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolve one model label to its reviewer CLI, most-specific wins:
 *    command:  BOULE_REVIEWER_CMD_<SUFFIX>  ?? BOULE_REVIEWER_CMD  ?? "codex"
 *    args:     BOULE_REVIEWER_ARGS_<SUFFIX> ?? BOULE_REVIEWER_ARGS (→ parseReviewerArgs safe default)
 *  Lets a ≥2 distinct-model live quorum run genuinely different binaries while keeping the
 *  existing single-model globals working unchanged. parseReviewerArgs keeps the read-only
 *  default per model when no args var is set. */
export function resolveReviewerCommand(
  model: string,
  env: Env,
): { command: string; args: string[] } {
  const suffix = reviewerEnvSuffix(model);
  const command = env[`BOULE_REVIEWER_CMD_${suffix}`] ?? env.BOULE_REVIEWER_CMD ?? "codex";
  const rawArgs = env[`BOULE_REVIEWER_ARGS_${suffix}`] ?? env.BOULE_REVIEWER_ARGS;
  return { command, args: parseReviewerArgs(rawArgs) };
}

/** Stable key for a resolved (command, args): two reviewers are the SAME reviewer iff their
 *  identities match. Used to detect a fake quorum (distinct labels, identical binary+args). */
export function reviewerIdentity(resolved: { command: string; args: string[] }): string {
  return JSON.stringify([resolved.command, resolved.args]);
}

/** Genuine-quorum advisory (warn-but-continue). When enough labels are configured to nominally
 *  meet the quorum but they collapse to fewer DISTINCT reviewers than the quorum, return a
 *  PII-safe warning naming the colliding labels only (never args). Returns null when quorum < 2,
 *  when too few labels are configured (a different, approve-time-visible problem), or when a
 *  genuine quorum is reachable.
 *
 *  Scope: this is an advisory, NOT the gate (the gate is deriveDecisionState counting distinct
 *  normalizeModelId(actor)). Identity = resolved (command, args), so it CANNOT catch a fake
 *  quorum hiding behind the same binary with different args (e.g. `codex --model a` vs
 *  `codex --model b`), nor verify that two distinct binaries are truly distinct models. */
export function quorumCollisionWarning(
  models: string[],
  env: Env,
  quorum: number,
): string | null {
  if (quorum < 2 || models.length < quorum) return null;
  const byIdentity = new Map<string, string[]>();
  for (const model of models) {
    const id = reviewerIdentity(resolveReviewerCommand(model, env));
    const labels = byIdentity.get(id) ?? [];
    labels.push(model);
    byIdentity.set(id, labels);
  }
  if (byIdentity.size >= quorum) return null;
  const colliding = [...byIdentity.values()]
    .filter((labels) => labels.length > 1)
    .map((labels) => labels.join(", "));
  return (
    `⚠ fake-quorum: ${byIdentity.size} distinct reviewer(s) < quorum ${quorum} — ` +
    `these labels share a reviewer command: [${colliding.join("; ")}]`
  );
}
