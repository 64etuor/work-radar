import type {
  HandoffPhase,
  PlanPhase,
  PreflightCheck,
  ProjectTickerStatusRow,
  ReadinessGates,
  SessionPhase,
  SpecPhase,
  TaskPhase,
  TickerSchedulerStatus,
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

/** Resolve which project's snapshot the Control Room should show. Honors the user's
 *  `selected` choice while it still exists in `available`; otherwise falls back to the
 *  first available project (and `null` when there are none). Pure → testable, and avoids
 *  a setState-in-effect by being derived each render. */
export function pickActiveProjectId(
  available: readonly string[],
  selected: string | null,
): string | null {
  if (selected != null && available.includes(selected)) return selected;
  return available[0] ?? null;
}

/** Project-tab status dot tone. Mirrors the INFRA tone vocabulary so the dot reads the same
 *  as the chips: a "down" project needs the operator, "ok" = armed clock (enabled + live),
 *  "advisory" = clock on but not live, "muted" = clock off. Pure → testable. */
export type ProjectDotTone = "down" | "ok" | "advisory" | "muted";

export function projectDotTone(row: ProjectTickerStatusRow): ProjectDotTone {
  if (row.attentionRequired) return "down";
  if (row.tickEnabled && row.liveEnabled) return "ok";
  if (row.tickEnabled) return "advisory";
  return "muted";
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

export type InfraTone = "ok" | "down" | "advisory";

/** ok → green, failing-required → red (down), failing-advisory → amber. */
export function infraTone(check: PreflightCheck): InfraTone {
  if (check.ok) return "ok";
  return check.level === "required" ? "down" : "advisory";
}

/** Armed ⇔ every readiness gate passes. */
export function isArmed(gates: ReadinessGates): boolean {
  return gates.preflight && gates.conductor && gates.observer && gates.auto && gates.stall;
}

/** Past this heartbeat age (3× the scheduler's 30s base wake) the scheduler task is
 *  presumed dead, not merely between wakes. */
export const SCHEDULER_STALE_AFTER_SEC = 90;

export interface SchedulerChip {
  tone: InfraTone;
  label: string;
  title: string;
}

/** App-bound scheduler heartbeat → INFRA chip. `null` = never woke on this database. */
export function schedulerChip(status: TickerSchedulerStatus | null): SchedulerChip {
  if (!status) {
    return {
      tone: "advisory",
      label: "scheduler ○",
      title: "앱 스케줄러가 아직 깨어난 적 없음",
    };
  }
  if (!status.runnerOk) {
    return {
      tone: "down",
      label: "scheduler ✕",
      title: `Boule runner 사용 불가: ${status.runnerError ?? "원인 불명"} — 매 wake 재시도 중`,
    };
  }
  if (status.secondsSinceWake > SCHEDULER_STALE_AFTER_SEC) {
    return {
      tone: "down",
      label: "scheduler stale",
      title: `마지막 wake ${status.secondsSinceWake}s 전 — 스케줄러 태스크가 죽었을 수 있음`,
    };
  }
  if (!status.scanOk) {
    return {
      tone: "advisory",
      label: "scheduler !",
      title: "마지막 due-scan 실패 — 다음 wake에 재시도",
    };
  }
  return {
    tone: "ok",
    label: "scheduler ●",
    title: `마지막 wake ${status.secondsSinceWake}s 전 · ${status.fired} fired`,
  };
}
