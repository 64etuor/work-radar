import type { GovEvent } from "../event/event.ts";

/** Runtime-only signals the SIDECAR cannot observe — supplied by the caller (MCP boundary / hermes). */
export interface RuntimeSignals {
  estimatedTokenRatio: number; // 0..1 of the model context window
  turnCount: number;
  wallClockMs: number;
  filesTouched: number;
}

export type PressureLevel = "low" | "medium" | "high" | "critical";

export interface PressureComponents {
  estimatedTokenRatio: number;
  turnCount: number;
  wallClockMs: number;
  filesTouched: number;
  unresolvedDecisions: number;
  planStepDistanceToSafeBoundary: number;
  lastHandoffAgeMs: number;
}

export interface ContextPressure {
  level: PressureLevel;
  score: number; // 0..1
  components: PressureComponents; // each NORMALIZED to 0..1 (the weighted inputs)
}

const HOUR_MS = 3_600_000;
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Weights sum to 1.0 (documented in the design §3). estimatedTokenRatio dominates because it is
 *  the direct cause of context saturation; event-derived signals are corroborating. By design,
 *  maxed runtime alone reaches ~0.75 ("high"); "critical" needs the event-derived signals too. */
const W = {
  estimatedTokenRatio: 0.30,
  turnCount: 0.15,
  wallClockMs: 0.10,
  filesTouched: 0.10,
  unresolvedDecisions: 0.15,
  planStepDistanceToSafeBoundary: 0.10,
  lastHandoffAgeMs: 0.10,
} as const;

/** Parse the embedded UTC stamp from an event id (prefix_YYYYMMDD_HHMMSS_hex) → epoch ms, or null. */
function idStampMs(id: string): number | null {
  const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/.exec(id);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Open decision_blocked count: a decision_blocked whose referenced decision_proposed has no
 *  verdict event (decision_approved/rejected/chosen) in the log. Conservative: unmatched → open. */
function countUnresolvedDecisions(log: GovEvent[]): number {
  const VERDICTS = new Set(["decision_approved", "decision_rejected", "decision_chosen"]);
  const resolved = new Set<string>();
  for (const e of log) {
    if (VERDICTS.has(e.frontmatter.type)) {
      for (const ref of e.frontmatter.related_to ?? []) resolved.add(ref);
    }
  }
  let n = 0;
  for (const e of log) {
    if (e.frontmatter.type !== "decision_blocked") continue;
    const refs = e.frontmatter.related_to ?? [];
    if (!refs.some((r) => resolved.has(r))) n++;
  }
  return n;
}

/** In-flight task count (active|blocked task lifecycle) as a bounded proxy for "distance to a safe
 *  stopping boundary": more live work = further from a clean checkpoint. PURE over the log. */
function inFlightTaskCount(log: GovEvent[]): number {
  const stateByTask = new Map<string, { terminal: boolean; live: boolean }>();
  for (const e of log) {
    if (e.frontmatter.type === "task_created") {
      stateByTask.set(e.frontmatter.id, { terminal: false, live: false });
    }
  }

  for (const e of log) {
    const type = e.frontmatter.type;
    const terminal = type === "task_completed" || type === "task_cancelled";
    const live = type === "task_started" || type === "task_blocked";
    if (!terminal && !live) continue;
    for (const taskId of e.frontmatter.related_to ?? []) {
      const state = stateByTask.get(taskId);
      if (!state) continue;
      if (terminal) state.terminal = true;
      if (live) state.live = true;
    }
  }

  let n = 0;
  for (const state of stateByTask.values()) {
    if (!state.terminal && state.live) n++;
  }
  return n;
}

/** Age (ms) since the most recent handoff_requested. No handoff ever → HOUR_MS (max component). */
function lastHandoffAgeMs(log: GovEvent[], now: Date): number {
  const births: number[] = [];
  for (const e of log) {
    if (e.frontmatter.type !== "handoff_requested") continue;
    const stamp = idStampMs(e.frontmatter.id);
    if (stamp !== null) births.push(stamp);
  }
  if (births.length === 0) return HOUR_MS;
  return Math.max(0, now.getTime() - Math.max(...births));
}

/** PURE: runtime signals + event-derived signals → an ADVISORY weighted pressure level. Emits
 *  NOTHING. `now` is supplied by the caller (Boule forbids Date.now() in source). Thresholds §9:
 *  low<0.50 · medium<0.70 · high<0.85 · critical>=0.85. */
export function computeContextPressure(rt: RuntimeSignals, log: GovEvent[], now: Date): ContextPressure {
  const components: PressureComponents = {
    estimatedTokenRatio: clamp01(rt.estimatedTokenRatio),
    turnCount: clamp01(rt.turnCount / 50),
    wallClockMs: clamp01(rt.wallClockMs / HOUR_MS),
    filesTouched: clamp01(rt.filesTouched / 20),
    unresolvedDecisions: clamp01(countUnresolvedDecisions(log) / 5),
    planStepDistanceToSafeBoundary: clamp01(inFlightTaskCount(log) / 5),
    lastHandoffAgeMs: clamp01(lastHandoffAgeMs(log, now) / HOUR_MS),
  };
  const score = clamp01(
    components.estimatedTokenRatio * W.estimatedTokenRatio +
      components.turnCount * W.turnCount +
      components.wallClockMs * W.wallClockMs +
      components.filesTouched * W.filesTouched +
      components.unresolvedDecisions * W.unresolvedDecisions +
      components.planStepDistanceToSafeBoundary * W.planStepDistanceToSafeBoundary +
      components.lastHandoffAgeMs * W.lastHandoffAgeMs,
  );
  const level: PressureLevel = score >= 0.85 ? "critical" : score >= 0.70 ? "high" : score >= 0.50 ? "medium" : "low";
  return { level, score, components };
}
