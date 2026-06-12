import type {
  HandoffPhase,
  PlanPhase,
  PreflightCheck,
  ProjectTickerStatusRow,
  ReadinessGates,
  ReadinessView,
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

/** P1(a) — `last_report_json`에서 사람이 읽을 래치 사유 라인 추출. 두 형태를 받는다:
 *  에러 리포트 `{"error":{"code","message"}}`(spawn/timeout/parse/dispatch 실패) 와
 *  TickReport(blockers/haltedPlans/stalledCount). 파싱 불가/없음 ⇒ 빈 배열(패널은
 *  last_outcome만 표시). 순수 → 테스트 가능. */
export function parseLatchDetail(lastReportJson: string | null | undefined): string[] {
  if (!lastReportJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastReportJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const report = parsed as {
    error?: { code?: unknown; message?: unknown };
    blockers?: unknown;
    haltedPlans?: unknown;
    stalledCount?: unknown;
  };
  const lines: string[] = [];
  if (report.error && typeof report.error.message === "string") {
    const code = typeof report.error.code === "string" ? `${report.error.code}: ` : "";
    lines.push(`${code}${report.error.message}`);
  }
  if (Array.isArray(report.blockers)) {
    for (const b of report.blockers) if (typeof b === "string") lines.push(b);
  }
  if (Array.isArray(report.haltedPlans)) {
    for (const p of report.haltedPlans) if (typeof p === "string") lines.push(`halted plan: ${p}`);
  }
  if (typeof report.stalledCount === "number" && report.stalledCount > 0) {
    lines.push(`stalled task ${report.stalledCount}개`);
  }
  return lines;
}

/** Go-Live 체크리스트의 실패 항목 1행: 게이트 태그 + 한 줄 처방(어떻게 고침). */
export interface GoLiveRemedy {
  /** React key용 안정 id. */
  key: string;
  /** 게이트/항목 짧은 라벨 (READINESS 칩 어휘와 동일). */
  gate: string;
  /** 한 줄 처방 — 같은 콘솔에 있는 토글은 새 컨트롤이 아니라 그 토글을 지시한다. */
  remedy: string;
}

/** infra preflight id별 처방 (READINESS preflight 게이트를 실패 원인 단위로 세분). */
const INFRA_REMEDIES: Record<string, string> = {
  cmux_socket:
    "cmux 환경에서 앱을 실행하거나 .boule/boule.config.json에 cmuxSocketPath를 설정하세요",
  cmux_binary: "cmux CLI를 설치하고 PATH에 등록하세요",
  git_worktree: "git 설치를 확인하세요 — 레포 경로에서 `git worktree list`가 동작해야 합니다",
};

/** P1(b) — Go-Live 체크리스트: 실패 항목마다 "어떻게 고침" 한 줄. ticker 측 disarm
 *  상태(tick/interval/래치)와 스냅샷 readiness 게이트를 한 목록으로 합친다. 같은 콘솔의
 *  토글이 처방이면 그 토글을 직접 지시(새 컨트롤 없음). 모두 green ⇒ 빈 배열(렌더 0).
 *  순수 → 테스트 가능. */
export function buildGoLiveRemedies(
  row: ProjectTickerStatusRow,
  readiness: ReadinessView | undefined,
  infra: PreflightCheck[] | undefined,
): GoLiveRemedy[] {
  const out: GoLiveRemedy[] = [];
  if (!row.tickEnabled) {
    out.push({
      key: "tick",
      gate: "tick",
      remedy: "컨트롤의 Enabled 토글을 켜세요 — 꺼져 있으면 자동 tick 스캔에서 제외됩니다",
    });
  }
  if (row.tickEnabled && row.intervalSec == null) {
    out.push({
      key: "interval",
      gate: "interval",
      remedy: "Interval(초)을 설정하세요 — 비어 있으면 수동 Tick now만 동작합니다",
    });
  }
  if (row.attentionRequired) {
    out.push({
      key: "latch",
      gate: "latch",
      remedy: "attention 패널의 래치 해제 버튼을 사용하세요 — 래치 중엔 자동 tick이 멈춥니다",
    });
  }
  if (readiness === undefined) return out;
  const gates = readiness.gates;
  if (!gates.preflight) {
    const failing = (infra ?? []).filter((c) => !c.ok && c.id in INFRA_REMEDIES);
    if (failing.length > 0) {
      for (const check of failing) {
        out.push({
          key: `preflight:${check.id}`,
          gate: check.id === "git_worktree" ? "git" : "cmux",
          remedy: INFRA_REMEDIES[check.id],
        });
      }
    } else {
      out.push({
        key: "preflight",
        gate: "preflight",
        remedy: "INFRA 칩의 실패(required) 항목을 해소하세요",
      });
    }
  }
  if (!gates.conductor) {
    out.push({
      key: "conductor",
      gate: "conductor",
      remedy: "Live 토글을 켜세요 — stub adapter 상태라 실제 세션이 spawn되지 않습니다",
    });
  }
  if (!gates.observer) {
    out.push({
      key: "observer",
      gate: "observer",
      remedy: "Live 토글을 켜세요 — observer가 stub이면 크래시/stall을 감지하지 못합니다",
    });
  }
  if (!gates.auto) {
    out.push({
      key: "auto",
      gate: "auto",
      remedy:
        "설정의 Boule 설정에서 autonomyLevel을 dispatch 이상으로 — manual은 step auto-advance가 없습니다",
    });
  }
  if (!gates.stall) {
    out.push({
      key: "stall",
      gate: "stall",
      remedy: "stalled task를 해소하세요(redispatch 또는 plan 수정) — 해소 전 무인 dispatch 차단",
    });
  }
  return out;
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
