import { normalizeModelId } from "../decision/modelId.ts";
import { DEFAULT_FORBIDDEN_DECISION_CLASSES } from "../conductor/envelope.ts";
import type { ExecutorKind, AutonomyEnvelope } from "../conductor/envelope.ts";

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
export function quorumCollisionWarning(models: string[], env: Env, quorum: number): string | null {
  if (quorum < 2 || models.length < quorum) return null;
  const byIdentity = new Map<string, string[]>();
  for (const model of models) {
    const id = reviewerIdentity(resolveReviewerCommand(model, env));
    const labels = byIdentity.get(id) ?? [];
    labels.push(model);
    byIdentity.set(id, labels);
  }
  if (byIdentity.size >= quorum) return null;
  const colliding = [...byIdentity.values()].flatMap((labels) =>
    labels.length > 1 ? [labels.join(", ")] : [],
  );
  return (
    `⚠ fake-quorum: ${byIdentity.size} distinct reviewer(s) < quorum ${quorum} — ` +
    `these labels share a reviewer command: [${colliding.join("; ")}]`
  );
}

/** Parse a positive integer env value; junk / <1 / unset → dflt. (Fail-closed clamp.) */
export function parsePositiveInt(raw: string | undefined, dflt: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : dflt;
}

/** v3 Phase C Conductor knobs (design §6). Safe defaults keep CI deterministic: mode!=="live"
 *  ⇒ the stub adapter (no git/cmux/fs). Only an explicit BOULE_CONDUCTOR_MODE=live arms the
 *  real cmux adapter. Mirrors the BOULE_REVIEWER_MODE stub-vs-live gating. */
export interface ConductorConfig {
  /** true only when BOULE_CONDUCTOR_MODE==="live" — otherwise the deterministic stub. */
  live: boolean;
  /** the cmux binary (defaults to the app bin name); used only by the live adapter. */
  cmuxCmd: string;
  /** gitignored root for per-step worktrees (NEVER the user tree); used only by the live adapter. */
  worktreesRoot: string;
  /** which CLI executor a spawned session runs (L3). "claude" is preserved only when explicitly
   *  requested, where the live adapter refuses it until an OS sandbox exists. All other values use
   *  the workspace-sandboxed codex executor. Run-level default; per-step
   *  override is a follow-up (needs a plan-step schema field). */
  executor: ExecutorKind;
}

/** Parse BOULE_CONDUCTOR_EXECUTOR. Autonomous execution defaults to the sandboxed codex path. */
export function parseConductorExecutor(raw: string | undefined): ExecutorKind {
  return (raw ?? "").trim().toLowerCase() === "claude" ? "claude" : "codex";
}

type DecisionClass = AutonomyEnvelope["forbiddenDecisionClasses"][number];

/** Per-repo policy envelope defaults (spec 2026-06-07 §E), set by the launcher via comma-list env.
 *  Unset ⇒ field omitted ⇒ the conductor's built-in envelope defaults apply. Unknown class tokens
 *  are dropped (fail-safe: never widen the forbidden set with garbage). */
export interface EnvelopeDefaults {
  forbiddenDecisionClasses?: DecisionClass[];
  allowedType2Actions?: string[];
}

export function parseEnvelopeDefaults(env: Record<string, string | undefined>): EnvelopeDefaults {
  const valid = new Set<string>(DEFAULT_FORBIDDEN_DECISION_CLASSES);
  const classes = (env.BOULE_ENVELOPE_FORBIDDEN_CLASSES ?? "").split(",").flatMap((s) => {
    const trimmed = s.trim();
    return valid.has(trimmed) ? [trimmed as DecisionClass] : [];
  });
  const actions = (env.BOULE_ENVELOPE_ALLOWED_TYPE2 ?? "").split(",").flatMap((s) => {
    const trimmed = s.trim();
    return trimmed ? [trimmed] : [];
  });
  const out: EnvelopeDefaults = {};
  if (classes.length) out.forbiddenDecisionClasses = classes;
  if (actions.length) out.allowedType2Actions = actions;
  return out;
}

/** Parse BOULE_CONDUCTOR_MODE: "live" (case-insensitive, trimmed) arms the real adapter; anything
 *  else (unset/junk) → stub. Fail-closed: an unrecognized value never accidentally goes live. */
export function parseConductorMode(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "live";
}

/** Parse BOULE_CONDUCTOR_CMUX_CMD → the cmux binary; blank/unset → "cmux". */
function parseConductorCmuxCmd(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return v || "cmux";
}

/** Parse BOULE_CONDUCTOR_WORKTREES_ROOT → the gitignored worktrees root; blank/unset →
 *  ".boule-worktrees" (the gitignored default; never the user tree). */
function parseConductorWorktreesRoot(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return v || ".boule-worktrees";
}

/** Parse BOULE_AUTO_MODE. Only exact "type2" opts into the narrow Phase-I dispatch loop.
 *  Anything else fails closed to off. This gates dispatch only; it is never passed to approval
 *  gates such as canApprove/canComplete/canAdvance. */
export function parseAutoMode(raw: string | undefined): "off" | "type2" {
  return (raw ?? "").trim().toLowerCase() === "type2" ? "type2" : "off";
}

/** Parse BOULE_AUTONOMY_LEVEL (config-driven graduated autonomy). Fail-closed: anything
 *  unrecognized → "manual" (fully human-gated). auto_plan/full OPEN INVARIANT #1's acceptance gate,
 *  so a typo/unknown value must NEVER accidentally land there. */
export function parseAutonomyLevel(
  raw: string | undefined,
): "manual" | "dispatch" | "auto_plan" | "full" {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "dispatch" || v === "auto_plan" || v === "full" ? v : "manual";
}

/** Assemble the Conductor config from env (all safe defaults). */
export function parseConductorConfig(env: Record<string, string | undefined>): ConductorConfig {
  return {
    live: parseConductorMode(env.BOULE_CONDUCTOR_MODE),
    cmuxCmd: parseConductorCmuxCmd(env.BOULE_CONDUCTOR_CMUX_CMD),
    worktreesRoot: parseConductorWorktreesRoot(env.BOULE_CONDUCTOR_WORKTREES_ROOT),
    executor: parseConductorExecutor(env.BOULE_CONDUCTOR_EXECUTOR),
  };
}

/** v3 Phase D Observer knobs (design §5). Safe defaults keep CI deterministic: mode!=="live" ⇒
 *  the server does NOT reconcile (the stub touches no cmux). Only an explicit
 *  BOULE_OBSERVER_MODE=live arms the real `cmux tree --all --json` adapter. Mirrors the Conductor gating. */
export interface ObserverConfig {
  /** true only when BOULE_OBSERVER_MODE==="live" — otherwise observe_sessions is a no-op notice. */
  live: boolean;
  /** the cmux binary (defaults to the app bin name); used only by the live adapter. */
  cmuxCmd: string;
}

/** Parse BOULE_OBSERVER_MODE: "live" (case-insensitive, trimmed) arms the real adapter; anything
 *  else (unset/junk) → stub. Fail-closed: an unrecognized value never accidentally goes live. */
export function parseObserverMode(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "live";
}

/** Assemble the Observer config from env (all safe defaults; reuses the conductor cmux-cmd
 *  parser since both name the same binary). */
export function parseObserverConfig(env: Record<string, string | undefined>): ObserverConfig {
  return {
    live: parseObserverMode(env.BOULE_OBSERVER_MODE),
    cmuxCmd: parseConductorCmuxCmd(env.BOULE_OBSERVER_CMUX_CMD),
  };
}

export interface PatternConfig {
  minEvidence: number;
  confFull: number;
  evidenceCap: number;
}

/** Pattern detector knobs from env (safe defaults; evidenceCap is a fixed display cap). */
export function parsePatternConfig(env: Record<string, string | undefined>): PatternConfig {
  return {
    minEvidence: parsePositiveInt(env.BOULE_PATTERN_MIN_EVIDENCE, 5),
    confFull: parsePositiveInt(env.BOULE_PATTERN_CONF_FULL, 50),
    evidenceCap: 20,
  };
}
