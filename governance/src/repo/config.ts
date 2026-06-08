import { z } from "zod";
import {
  DEFAULT_FORBIDDEN_DECISION_CLASSES,
  type AutonomyEnvelope,
} from "../conductor/envelope.ts";
import {
  backendSpecSchema,
  backendsConfigSchema,
  type BackendsConfig,
} from "../backends/config.ts";
import {
  budgetCapsSchema,
  priceTableSchema,
  type BudgetCaps,
  type PriceTable,
} from "../backends/budget.ts";

// Per-repo governance config (spec 2026-06-07 §B/§C). PURE: parse/validate + resolve policy.
// boule.config.json is the mutable settings surface (editable via `boule set` or the work-radar
// Settings UI). Per-kind defaults tune POST-acceptance autonomy only — accept_plan/accept_spec
// stay human gates regardless of kind (INVARIANT #1).

export type Kind = "personal" | "work";
export type AutoMode = "off" | "type2";

/** Graduated autonomy (INVARIANT #1 surface). Higher = more gates opened to the orchestrator.
 *  - manual:    accept_spec + accept_plan are HUMAN; no auto-dispatch. (production-safe default)
 *  - dispatch:  human accepts spec+plan; steps then auto-advance (= legacy autoMode type2).
 *  - auto_plan: + the orchestrator AUTO-ACCEPTS proposed PLANS (human still accepts specs).
 *  - full:      + the orchestrator AUTO-ACCEPTS proposed SPECS too (fully unattended ACCEPTANCE).
 *  ⚠️ auto_plan/full OPEN INVARIANT #1's human gate — test/dev only. Even at `full`, Type-1
 *  decisions + stalls STILL halt for a human (auto-accept is acceptance-only; it never resolves a
 *  decision_blocked or recovers a stall), and a spawned EXECUTOR session still cannot self-accept
 *  (verdict tools structurally absent). Auto-accepts are recorded actor:"system" + an autonomy
 *  marker — never forged as a human approval. */
export type AutonomyLevel = "manual" | "dispatch" | "auto_plan" | "full";
const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  manual: 0,
  dispatch: 1,
  auto_plan: 2,
  full: 3,
};
/** true if `level` opens the named gate (monotonic). */
export const autonomyAllows = {
  dispatch: (l: AutonomyLevel) => AUTONOMY_RANK[l] >= AUTONOMY_RANK.dispatch,
  autoAcceptPlan: (l: AutonomyLevel) => AUTONOMY_RANK[l] >= AUTONOMY_RANK.auto_plan,
  autoAcceptSpec: (l: AutonomyLevel) => AUTONOMY_RANK[l] >= AUTONOMY_RANK.full,
};

/** Type-1 classes a spawned session must escalate (envelope.forbiddenDecisionClasses domain). */
type DecisionClass = AutonomyEnvelope["forbiddenDecisionClasses"][number];

export interface ResolvedPolicy {
  kind: Kind;
  autonomyLevel: AutonomyLevel;
  autoMode: AutoMode;
  reviewQuorum: number;
  forbiddenDecisionClasses: DecisionClass[];
  allowedType2Actions: string[];
  /** Per-role backend chains. undefined ⇒ env-derived defaults (consumed by the conductor/reviewer
   *  wiring; the fail-closed fallback runner lives in backends/fallback.ts). */
  backends?: BackendsConfig;
  /** Executor-only difficulty routing. Selectors can only promote already-configured candidates. */
  routing?: RoutingConfig;
  /** Optional pure budget caps. undefined ⇒ no budget filtering unless the caller supplies caps. */
  budget?: BudgetCaps;
  /** Optional provider/model pricing table. Unknown entries under active caps fail closed. */
  priceTable?: PriceTable;
}

// Per-kind defaults. work = strict (manual gates, ≥2 review, all classes escalate); personal =
// loose (auto-dispatch on, single review, narrower forbidden set + broader Type-2 autonomy).
// autoMode is DERIVED from autonomyLevel (manual→off, else→type2); the per-kind autonomy default is
// the source of truth. auto_plan/full are NEVER a default — they are explicit opt-in (INVARIANT #1).
const WORK_DEFAULTS: Omit<ResolvedPolicy, "kind" | "autoMode"> = {
  autonomyLevel: "manual",
  reviewQuorum: 2,
  forbiddenDecisionClasses: DEFAULT_FORBIDDEN_DECISION_CLASSES,
  allowedType2Actions: ["edit", "test", "lint"],
};
const PERSONAL_DEFAULTS: Omit<ResolvedPolicy, "kind" | "autoMode"> = {
  autonomyLevel: "dispatch",
  reviewQuorum: 1,
  // drop product-behavior + dependency from the forbidden set ⇒ those become Type-2-autonomous.
  forbiddenDecisionClasses: [
    "scope",
    "architecture",
    "irreversible-design",
    "security",
    "data-loss",
  ],
  allowedType2Actions: ["edit", "test", "lint", "refactor"],
};

const decisionClassSchema = z.enum([
  "scope",
  "architecture",
  "irreversible-design",
  "security",
  "product-behavior",
  "dependency",
  "data-loss",
]);

const routingByDifficultySchema = z
  .object({
    trivial: backendSpecSchema.optional(),
    standard: backendSpecSchema.optional(),
    hard: backendSpecSchema.optional(),
  })
  .strict();

const routingConfigSchema = z
  .object({
    executor: routingByDifficultySchema.optional(),
  })
  .strict();
export type RoutingConfig = z.infer<typeof routingConfigSchema>;

const overridesSchema = z
  .object({
    // autonomyLevel is the SINGLE autonomy knob; autoMode is DERIVED from it (no separate override —
    // that previously let status disagree with the server's effective mode). auto_plan/full open
    // INVARIANT #1's human gate — settable per-repo (config-file-only) for test/dev; fail-closed.
    autonomyLevel: z.enum(["manual", "dispatch", "auto_plan", "full"]).optional(),
    reviewQuorum: z.number().int().min(1).optional(),
    forbiddenDecisionClasses: z.array(decisionClassSchema).optional(),
    allowedType2Actions: z.array(z.string().min(1)).optional(),
    // Configurable per-role agent backends + token-exhaustion fallback chains (backends/config.ts).
    // Omitted ⇒ the harness keeps its current env-derived backend defaults (backward compatible).
    backends: backendsConfigSchema.optional(),
    routing: routingConfigSchema.optional(),
    budget: budgetCapsSchema.optional(),
    priceTable: priceTableSchema.optional(),
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    kind: z.enum(["personal", "work"]),
    overrides: overridesSchema.optional(),
  })
  .strict();

export type PolicyOverrides = z.infer<typeof overridesSchema>;
export type BouleConfig = z.infer<typeof configSchema>;

/** Strict parse (unknown fields rejected). THROWS on invalid — callers that need fail-closed
 *  behavior use STRICT_FALLBACK_POLICY (the launcher degrades to work/strict, never silently loose). */
export function parseBouleConfig(value: unknown): BouleConfig {
  return configSchema.parse(value);
}

/** Pure: kind default with per-field override precedence. */
export function resolvePolicy(config: BouleConfig): ResolvedPolicy {
  const base = config.kind === "work" ? WORK_DEFAULTS : PERSONAL_DEFAULTS;
  const o = config.overrides ?? {};
  const autonomyLevel = o.autonomyLevel ?? base.autonomyLevel;
  return {
    kind: config.kind,
    autonomyLevel,
    // autoMode is DERIVED solely from the level (single source — status always matches the server).
    autoMode: autonomyLevel === "manual" ? "off" : "type2",
    reviewQuorum: o.reviewQuorum ?? base.reviewQuorum,
    forbiddenDecisionClasses: o.forbiddenDecisionClasses ?? base.forbiddenDecisionClasses,
    allowedType2Actions: o.allowedType2Actions ?? base.allowedType2Actions,
    // No per-kind default: undefined ⇒ env-derived backend defaults downstream (additive surface).
    backends: o.backends,
    routing: o.routing,
    budget: o.budget,
    priceTable: o.priceTable,
  };
}

/** The fail-closed policy used when a repo's config is missing/unparseable: strictest (work). */
export const STRICT_FALLBACK_POLICY: ResolvedPolicy = resolvePolicy({
  schemaVersion: 1,
  kind: "work",
});

/** Build a default config for a kind (used by `boule init`). */
export function defaultConfig(
  kind: Kind,
  meta?: { projectId?: string; projectName?: string },
): BouleConfig {
  return { schemaVersion: 1, kind, ...meta };
}

/** Recursively sort object keys (arrays preserved) for byte-stable output. NOT a JSON.stringify
 *  replacer array — that is an allowlist and would DROP nested keys (e.g. overrides.*). */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** Stable, pretty JSON (recursively sorted keys) + trailing newline → clean diffs for the
 *  settings-editable file. */
export function serializeConfig(config: BouleConfig): string {
  return JSON.stringify(sortKeysDeep(config), null, 2) + "\n";
}

/** Pure: resolved policy + repo dirs → the env map a per-repo MCP server runs under. The single
 *  policy→env mapping, reused by the launcher (exec env) and mcp.json generation. Array knobs go as
 *  comma lists (parsed back by mcp/config.ts parseEnvelopeDefaults). */
export function policyEnv(
  policy: ResolvedPolicy,
  dirs: { repoRoot: string; workspace: string; worktrees: string },
): Record<string, string> {
  return {
    BOULE_WORKSPACE: dirs.workspace,
    BOULE_REPO_ROOT: dirs.repoRoot,
    BOULE_CONDUCTOR_WORKTREES_ROOT: dirs.worktrees,
    BOULE_AUTONOMY_LEVEL: policy.autonomyLevel,
    BOULE_AUTO_MODE: policy.autoMode,
    BOULE_REVIEW_QUORUM: String(policy.reviewQuorum),
    BOULE_ENVELOPE_FORBIDDEN_CLASSES: policy.forbiddenDecisionClasses.join(","),
    BOULE_ENVELOPE_ALLOWED_TYPE2: policy.allowedType2Actions.join(","),
  };
}
