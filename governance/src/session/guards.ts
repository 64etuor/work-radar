import type { SessionState } from "./session.ts";

export interface SessionGate {
  ok: boolean;
  reason: string;
}

const terminal = (s: SessionState) => s.verdict !== null; // verdict==="closed" ⇒ terminal

/** Recover is allowed ONLY from crashed (master §8: crashed → recovering). */
export function canRecover(s: SessionState): SessionGate {
  if (s.phase !== "crashed")
    return { ok: false, reason: `cannot recover a ${s.phase} session (only crashed)` };
  return { ok: true, reason: "recovering" };
}

/** Wait/block/handoff_ready: any non-terminal session. */
export function canWait(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  return { ok: true, reason: "waiting" };
}
export function canBlock(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  return { ok: true, reason: "blocking" };
}
export function canHandoffReady(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  return { ok: true, reason: "handoff ready" };
}

/** Pressure/checkpoint: refuse terminal AND crashed — you can't checkpoint a dead session
 *  (master §8 "can't checkpoint/pressure a terminal session", generalized to crashed). */
export function canPressure(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  if (s.phase === "crashed")
    return { ok: false, reason: "cannot record pressure on a crashed session" };
  return { ok: true, reason: "pressure recorded" };
}
export function canCheckpoint(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  if (s.phase === "crashed") return { ok: false, reason: "cannot checkpoint a crashed session" };
  return { ok: true, reason: "checkpoint requested" };
}

/** Close request: any non-terminal session. */
export function canRequestClose(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  return { ok: true, reason: "close requested" };
}

/** Close: ONLY after a close request (phase===closing). This is the structural gate behind the
 *  no-auto-close guarantee — close_session is the sole session_closed path AND it refuses unless
 *  a human/producer first requested the close. */
export function canClose(s: SessionState): SessionGate {
  if (terminal(s)) return { ok: false, reason: "session already closed" };
  if (s.phase !== "closing")
    return {
      ok: false,
      reason: `close_session requires a prior session_close_requested (is ${s.phase})`,
    };
  return { ok: true, reason: "closing" };
}
