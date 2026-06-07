import { assertProviderAllowed, type BackendSpec, type Role } from "./config.ts";

// Fail-closed fallback across a backend chain. The governing rule (confirmed design decision):
// **a fallback degrades capability, never a gate.** When a chain is exhausted (every backend out of
// tokens, or a fatal misconfig), each role terminates to a HUMAN-pending state — never an
// auto-approval or an auto-completion. This preserves INVARIANT #1 (no automated self-approval) and
// INVARIANT #5 (bounded — no silent skip).

/** Why one backend attempt did not yield a usable result. */
export type AttemptError =
  /** quota / usage-limit / auth-exhausted → this backend is out; try the next in the chain. */
  | { kind: "token_exhausted" }
  /** network / timeout / transient spawn failure → also try the next backend (per-attempt retry,
   *  if any, is the runner's concern; from the chain's view it is fallback-eligible). */
  | { kind: "transient" }
  /** misconfiguration (bad command, unparseable output) → STOP the chain. Still terminates
   *  fail-closed (a misconfig must not open a gate), it just does not waste later rungs. */
  | { kind: "fatal"; detail: string };

/** Provider-agnostic classification of a finished backend process into success or an AttemptError.
 *  Pure: (exitCode, stderr) in, verdict out. Token signatures are matched case-insensitively across
 *  the known agent CLIs (claude usage-limit / credit-balance, codex quota / 429 / insufficient_quota,
 *  generic rate-limit). Unknown non-zero exits are `fatal` (fail-closed: do not assume retryable). */
export function classifyAttempt(exitCode: number | null, stderr: string): "ok" | AttemptError {
  if (exitCode === 0) return "ok";
  const s = stderr.toLowerCase();
  const tokenSignatures = [
    "usage limit",
    "rate limit",
    "rate_limit",
    "quota",
    "insufficient_quota",
    "credit balance",
    "out of credits",
    "429",
    "too many requests",
    "overloaded",
  ];
  if (tokenSignatures.some((sig) => s.includes(sig))) return { kind: "token_exhausted" };
  const transientSignatures = [
    "etimedout",
    "econnreset",
    "econnrefused",
    "socket hang up",
    "network",
    "timed out",
    "timeout",
    "503",
    "502",
  ];
  if (exitCode === null || transientSignatures.some((sig) => s.includes(sig)))
    return { kind: "transient" };
  return { kind: "fatal", detail: stderr.slice(0, 200) };
}

/** Fail-closed terminal when a role's whole chain is exhausted. NEVER an approval/completion. */
export type Terminal =
  | { role: "executor"; outcome: "stall" } // bounded: hand the step back to a human, no silent skip
  | { role: "reviewer"; outcome: "blocked" } // decision stays blocked — never auto-approve
  | { role: "evaluator"; outcome: "needs_human" }; // step not marked complete — never auto-complete

export function exhaustedTerminal(role: Role): Terminal {
  switch (role) {
    case "executor":
      return { role, outcome: "stall" };
    case "reviewer":
      return { role, outcome: "blocked" };
    case "evaluator":
      return { role, outcome: "needs_human" };
  }
}

export type FallbackResult<T> =
  | { ok: true; value: T; via: BackendSpec }
  | { ok: false; terminal: Terminal };

/** Run a chain with fallback. `attempt(spec)` performs ONE backend invocation and reports either a
 *  usable value or a classified AttemptError. Returns the first success (with the backend that
 *  produced it), or — when the chain is exhausted / hits a fatal — the role's fail-closed Terminal.
 *  `deterministic` is validated per-rung via assertProviderAllowed (throws on executor/reviewer). */
export async function runWithFallback<T>(
  role: Role,
  chain: BackendSpec[],
  attempt: (spec: BackendSpec) => Promise<{ ok: true; value: T } | { ok: false; error: AttemptError }>,
): Promise<FallbackResult<T>> {
  for (const spec of chain) {
    assertProviderAllowed(role, spec);
    const r = await attempt(spec);
    if (r.ok) return { ok: true, value: r.value, via: spec };
    if (r.error.kind === "fatal") break; // stop wasting rungs; still terminates fail-closed below
    // token_exhausted | transient → advance to the next backend in the chain
  }
  return { ok: false, terminal: exhaustedTerminal(role) };
}
