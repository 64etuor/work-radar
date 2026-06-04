import type {
  HandoffPhase,
  PlanPhase,
  SessionPhase,
  SessionRow,
  SpecPhase,
  TaskPhase,
} from "../bindings";

/** Master §12 node-status buckets, collapsed to the tones the UI renders. */
export type StatusTone = "done" | "active" | "waiting" | "pressure" | "blocked" | "muted";

type AnyPhase = SessionPhase | TaskPhase | PlanPhase | SpecPhase | HandoffPhase;

export function statusTone(phase: AnyPhase): StatusTone {
  switch (phase) {
    case "done":
    case "completed":
    case "consumed":
    case "accepted":
      return "done";
    case "active":
    case "opening":
      return "active";
    case "waiting":
    case "needs_revision":
    case "validating":
    case "ready":
    case "requested":
    case "planned":
    case "draft":
      return "waiting";
    case "context_pressure_high":
    case "checkpoint_requested":
    case "handoff_ready":
    case "pending":
    case "recovering":
      return "pressure";
    case "blocked":
    case "crashed":
    case "invalid":
      return "blocked";
    case "closed":
    case "closing":
    case "cancelled":
    case "archived":
    case "superseded":
    case "unknown":
      return "muted";
    default:
      return "muted";
  }
}

export interface SessionBuckets {
  active: SessionRow[];
  waiting: SessionRow[];
  pressure: SessionRow[];
  terminal: SessionRow[];
}

export function bucketSessions(sessions: SessionRow[]): SessionBuckets {
  const out: SessionBuckets = { active: [], waiting: [], pressure: [], terminal: [] };
  for (const s of sessions) {
    const tone = statusTone(s.phase);
    if (tone === "active") out.active.push(s);
    else if (tone === "pressure") out.pressure.push(s);
    else if (tone === "muted") out.terminal.push(s);
    else out.waiting.push(s); // waiting + blocked share the "needs attention" column
  }
  return out;
}

/** Humanize the snapshot mtime. `nowMs` is injected so the function is pure/testable. */
export function relativeAgo(generatedAt: string | null, nowMs: number): string {
  if (!generatedAt) return "아직 프로젝션 없음";
  const then = Date.parse(generatedAt);
  if (Number.isNaN(then)) return "프로젝션 시각 불명";
  const mins = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (mins === 0) return "방금 프로젝션";
  if (mins < 60) return `${mins}분 전 프로젝션`;
  const hrs = Math.round(mins / 60);
  return `${hrs}시간 전 프로젝션`;
}
