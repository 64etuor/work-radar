import { z } from "zod";
import {
  DEFAULT_FORBIDDEN_DECISION_CLASSES,
  type AutonomyEnvelope,
} from "../conductor/envelope.ts";

// Per-repo governance config (spec 2026-06-07 §B/§C). PURE: parse/validate + resolve policy.
// boule.config.json is the mutable settings surface (editable via `boule set` or the work-radar
// Settings UI). Per-kind defaults tune POST-acceptance autonomy only — accept_plan/accept_spec
// stay human gates regardless of kind (INVARIANT #1).

export type Kind = "personal" | "work";
export type AutoMode = "off" | "type2";

/** Type-1 classes a spawned session must escalate (envelope.forbiddenDecisionClasses domain). */
type DecisionClass = AutonomyEnvelope["forbiddenDecisionClasses"][number];

export interface ResolvedPolicy {
  kind: Kind;
  autoMode: AutoMode;
  reviewQuorum: number;
  forbiddenDecisionClasses: DecisionClass[];
  allowedType2Actions: string[];
}

// Per-kind defaults. work = strict (manual conduct, ≥2 review, all classes escalate); personal =
// loose (auto-dispatch on, single review, narrower forbidden set + broader Type-2 autonomy).
const WORK_DEFAULTS: Omit<ResolvedPolicy, "kind"> = {
  autoMode: "off",
  reviewQuorum: 2,
  forbiddenDecisionClasses: DEFAULT_FORBIDDEN_DECISION_CLASSES,
  allowedType2Actions: ["edit", "test", "lint"],
};
const PERSONAL_DEFAULTS: Omit<ResolvedPolicy, "kind"> = {
  autoMode: "type2",
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

const overridesSchema = z
  .object({
    autoMode: z.enum(["off", "type2"]).optional(),
    reviewQuorum: z.number().int().min(1).optional(),
    forbiddenDecisionClasses: z.array(decisionClassSchema).optional(),
    allowedType2Actions: z.array(z.string().min(1)).optional(),
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
  return {
    kind: config.kind,
    autoMode: o.autoMode ?? base.autoMode,
    reviewQuorum: o.reviewQuorum ?? base.reviewQuorum,
    forbiddenDecisionClasses: o.forbiddenDecisionClasses ?? base.forbiddenDecisionClasses,
    allowedType2Actions: o.allowedType2Actions ?? base.allowedType2Actions,
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
    BOULE_AUTO_MODE: policy.autoMode,
    BOULE_REVIEW_QUORUM: String(policy.reviewQuorum),
    BOULE_ENVELOPE_FORBIDDEN_CLASSES: policy.forbiddenDecisionClasses.join(","),
    BOULE_ENVELOPE_ALLOWED_TYPE2: policy.allowedType2Actions.join(","),
  };
}
