// Single source of truth for orchestration blast-radius bounds. The architecture review
// (2026-06-29) found these caps were defined in two places that drifted apart — the MCP
// dispatch path defaulted to Number.POSITIVE_INFINITY while the tick path clamped. Centralizing
// them here makes "how many sessions can the orchestrator spawn?" answerable in one place.

/** Hard cap on conducts per orchestration pass (the blast-radius bound `boule tick --max-steps`
 *  clamps to, and the default for any direct dispatch call). */
export const MAX_CONDUCTS_PER_TICK = 5;

/** Defensive last line of defense: the most sessions any single task may ever spawn across all
 *  attempts (first conduct + token-exhaustion redispatch + post-escalation resume). */
export const MAX_SESSIONS_PER_TASK = 10;

/** A spawned session that emits neither executor_attempt_finished nor session_closed within this
 *  window is treated as stalled even when no Observer marked it crashed (TTL fallback — graceful
 *  degradation when the Observer process is not running). */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
