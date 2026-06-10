/** Canonical list of verdict tools — the SINGLE source of truth for INVARIANT #1's
 *  structural session-role wall. Two consumers MUST stay in sync, and both derive from here:
 *
 *  1. `src/mcp/server.ts` `registerVerdictTool` — registers these ONLY when
 *     BOULE_SESSION_ROLE != executor (structural absence, not prompt-advisory).
 *  2. `src/conductor/adapter.ts` `SESSION_DENIED_TOOLS` — the spawned session's CLI denylist
 *     (defense-in-depth on top of the structural unregistration).
 *
 *  Adding a verdict tool = add the name here first; `registerVerdictTool` throws on names
 *  outside this list, and `test/mcp/verdictGating.test.ts` pins that every name is registered
 *  through the gated helper (never via a bare `server.registerTool`).
 */

export const VERDICT_TOOL_NAMES = [
  // Human gates over decisions/reviews: resolving a fork is never the executor's call.
  "approve",
  "reject",
  "choose",
  // Human gates over plan/spec acceptance (draft → active/accepted, actor=user).
  "accept_plan",
  "accept_spec",
  // auto_dispatch is an ORCHESTRATOR tool: it can auto-accept plans/specs (autonomyLevel) and spawn
  // sub-sessions. An executor session must never reach it — else it could open INVARIANT #1's gate
  // for its own plan. Denied in the CLI denylist AND structurally unregistered for executor role;
  // the guarantee does not rely on env isolation.
  "auto_dispatch",
  // Pattern curation shapes the curated set that steers future detection — a judgment call an
  // executor must not make about its own observation stream.
  "activate_pattern",
  "archive_pattern",
  // archive_prune's pattern half moves stale candidates into the curated set — curation by the
  // clock. Same wall as the explicit curation tools. (`detect` is deliberately executor-reachable:
  // candidates never steer detection until curated.)
  "archive_prune",
] as const;

export type VerdictToolName = (typeof VERDICT_TOOL_NAMES)[number];

export const VERDICT_TOOL_NAME_SET: ReadonlySet<string> = new Set(VERDICT_TOOL_NAMES);

/** Fully-qualified MCP tool ids (`mcp__<alias>__<tool>`) for a session denylist. */
export function sessionDeniedTools(alias: string): string[] {
  return VERDICT_TOOL_NAMES.map((name) => `mcp__${alias}__${name}`);
}
