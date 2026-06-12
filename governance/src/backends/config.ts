import { z } from "zod";

// Configurable agent backends for the conductor's three roles (executor / reviewer / evaluator).
// PURE schema only — no I/O. This is an ADDITIVE settings surface: it lives under
// boule.config.json `overrides.backends` (see repo/config.ts), and when omitted the harness keeps
// its current env-derived defaults (fully backward compatible). The fallback SEMANTICS that consume
// these chains live in backends/fallback.ts and are fail-closed (a token-exhausted chain never opens
// a gate — INVARIANT #1).

/** Where an attempt runs.
 *  - claude / codex: the two agent CLIs (codex spawns must run under a clean CODEX_HOME so the
 *    operator's global OMX/cmux hooks don't hijack the autonomous session — wiring concern, not here).
 *  - command: an arbitrary CLI (escape hatch; `command` + `args` required).
 *  - deterministic: a NON-LLM check (e.g. "the step's declared command exited 0 / artifact exists").
 *    Valid only as an EVALUATOR fallback — it consumes no tokens, so it is the last rung that lets a
 *    step complete when no model is available. It is NOT a reviewer (a decision verdict needs a model
 *    or a human — never a deterministic rubber-stamp). */
const PROVIDERS = ["claude", "codex", "command", "deterministic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const backendSpecSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    /** model id / tier hint (claude|codex). */
    model: z.string().min(1).optional(),
    /** required when provider === "command". */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
  })
  .strict()
  .refine((s) => s.provider !== "command" || !!s.command, {
    message: "provider 'command' requires a command",
  });
export type BackendSpec = z.infer<typeof backendSpecSchema>;

/** An ordered fallback chain: try entries left→right until one succeeds (see runWithFallback). */
const backendChainSchema = z
  .object({ chain: z.array(backendSpecSchema).min(1) })
  .strict();
export type BackendChain = z.infer<typeof backendChainSchema>;

/** The three role backends. `reviewers` is an ARRAY of chains — one per quorum member, so a ≥2
 *  distinct-provider quorum is expressed directly. `deterministic` is rejected for reviewer/executor
 *  roles (only evaluator may use it) — enforced by `assertProviderAllowed`, not the schema, so the
 *  error names the offending role. */
export const backendsConfigSchema = z
  .object({
    executor: backendChainSchema.optional(),
    reviewers: z.array(backendChainSchema).optional(),
    evaluator: backendChainSchema.optional(),
  })
  .strict();
export type BackendsConfig = z.infer<typeof backendsConfigSchema>;

export type Role = "executor" | "reviewer" | "evaluator";

/** `deterministic` is an evaluator-only rung. Throws (fail-closed: a misconfig must not silently
 *  degrade a gate) if it appears in an executor/reviewer chain. */
export function assertProviderAllowed(role: Role, spec: BackendSpec): void {
  if (spec.provider === "deterministic" && role !== "evaluator") {
    throw new Error(`backend 'deterministic' is not allowed for role '${role}' (evaluator only)`);
  }
}
