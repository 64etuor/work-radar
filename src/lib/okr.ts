import type { KeyResult, Objective, OkrCheckIn, WorkSignal } from "@/bindings";

export type KeyResultProgressSource = Pick<
  KeyResult,
  "kind" | "currentValue" | "targetValue" | "milestones"
>;

export function keyResultProgressRatio(kr: KeyResultProgressSource): number {
  if (kr.kind === "metric") {
    if (kr.currentValue == null || kr.targetValue == null || kr.targetValue <= 0) return 0;
    return kr.currentValue / kr.targetValue;
  }
  if (kr.milestones.length === 0) return 0;
  return kr.milestones.filter((milestone) => milestone.done).length / kr.milestones.length;
}

export function objectiveProgressRatio(krs: KeyResultProgressSource[]): number {
  if (krs.length === 0) return 0;
  return krs.reduce((sum, kr) => sum + keyResultProgressRatio(kr), 0) / krs.length;
}

/** signals.area_tags JSON array 안전 파싱 — 잘못된 JSON은 빈 배열. */
export function parseAreaTags(areaTags: string | null): string[] {
  if (!areaTags) return [];
  try {
    const parsed: unknown = JSON.parse(areaTags);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export type SignalObjectiveMatchSource = Pick<WorkSignal, "area" | "areaTags" | "projectId">;
export type ObjectiveMatchSource = Pick<
  Objective,
  "id" | "title" | "status" | "linkedAreaKeys" | "linkedProjectIds"
>;

/**
 * 신호 ↔ Objective 매칭(표시 전용 힌트 — 집계 정본은 okr.rs `stats_for_objective`의 SQL이고,
 * 이 함수는 그 규칙의 프런트 미러다: area 직접 일치 ∨ area_tags 포함 ∨ project_id 일치).
 * 규칙 변경 시 양쪽을 함께 바꾼다.
 */
export function signalMatchesObjective(
  signal: SignalObjectiveMatchSource,
  objective: ObjectiveMatchSource,
): boolean {
  if (objective.linkedAreaKeys.length > 0) {
    if (signal.area && objective.linkedAreaKeys.includes(signal.area)) return true;
    const tags = parseAreaTags(signal.areaTags);
    if (tags.some((tag) => objective.linkedAreaKeys.includes(tag))) return true;
  }
  return (
    objective.linkedProjectIds.length > 0 &&
    signal.projectId != null &&
    objective.linkedProjectIds.includes(signal.projectId)
  );
}

export type ObjectiveMatchVia = "area" | "project";
export type ObjectiveMatch<T> = { objective: T; via: ObjectiveMatchVia };

/**
 * 이 신호가 집계되는 활성 Objective 목록 + 매칭 근거(정렬 유지). 표시 전용 — 결정 입력 아님.
 * via="project"는 함정 소지가 큼: 캡처가 kind 기본 프로젝트(개인=My Life 등)를 자동 태깅하므로
 * Objective에 기본 프로젝트를 링크하면 그 kind 카드 전부가 매칭된다 — 툴팁에 근거를 밝힌다.
 */
export function objectiveMatchesForSignal<T extends ObjectiveMatchSource>(
  signal: SignalObjectiveMatchSource,
  objectives: T[],
): ObjectiveMatch<T>[] {
  const matches: ObjectiveMatch<T>[] = [];
  for (const objective of objectives) {
    if (objective.status !== "active") continue;
    const byArea =
      objective.linkedAreaKeys.length > 0 &&
      ((signal.area != null && objective.linkedAreaKeys.includes(signal.area)) ||
        parseAreaTags(signal.areaTags).some((tag) => objective.linkedAreaKeys.includes(tag)));
    if (byArea) {
      matches.push({ objective, via: "area" });
      continue;
    }
    if (
      objective.linkedProjectIds.length > 0 &&
      signal.projectId != null &&
      objective.linkedProjectIds.includes(signal.projectId)
    ) {
      matches.push({ objective, via: "project" });
    }
  }
  return matches;
}

/**
 * 보드 카드 OKR 배지는 사용자가 납득할 수 있는 직접 근거만 보여준다.
 * project-only 매칭은 Objective 통계에는 쓸 수 있지만, 기본 personal/work 프로젝트 태깅 때문에
 * 브레인덤프 카드 전체에 OKR처럼 보이는 잡음을 만든다.
 */
export function okrBadgeMatchesForSignal<T extends ObjectiveMatchSource>(
  signal: SignalObjectiveMatchSource,
  objectives: T[],
): ObjectiveMatch<T>[] {
  return objectiveMatchesForSignal(signal, objectives).filter((match) => match.via === "area");
}

/** 보드 ◎ 배지 툴팁 — 매칭 근거(영역/프로젝트)를 밝힌다(프로젝트 링크=그 프로젝트 카드 전부 함정 가시화). */
export function okrChipTooltip(matches: ObjectiveMatch<{ title: string }>[]): string {
  const lines = matches.map(
    (m) =>
      `· ${m.objective.title} — ${m.via === "area" ? "영역 태그 일치" : "프로젝트 링크(카드의 프로젝트가 Objective에 연결됨)"}`,
  );
  return `이번 분기 Objective에 집계됨:\n${lines.join("\n")}`;
}

/** 이 신호가 집계되는 활성 Objective 목록(정렬 유지). 표시 전용 — 결정 입력 아님. */
export function objectivesMatchingSignal<T extends ObjectiveMatchSource>(
  signal: SignalObjectiveMatchSource,
  objectives: T[],
): T[] {
  return objectiveMatchesForSignal(signal, objectives).map((match) => match.objective);
}

/**
 * 이번 주(weekStart 기준) 아직 체크인 안 된 활성 Objective KR 수 — Weekly/보드 넛지 공용.
 * 루틴 연결 KR은 제외한다(진행이 루틴 체크에서 자동 파생 — 체크인 입력 대상이 아님).
 */
export function uncheckedKrCount(
  objectives: {
    status: Objective["status"];
    keyResults: Pick<KeyResult, "id" | "routineId">[];
  }[],
  checkIns: Pick<OkrCheckIn, "keyResultId" | "weekStart">[],
  weekStart: string,
): number {
  const checked = new Set<string>();
  for (const checkIn of checkIns) {
    if (checkIn.weekStart === weekStart) checked.add(checkIn.keyResultId);
  }
  let count = 0;
  for (const objective of objectives) {
    if (objective.status !== "active") continue;
    for (const kr of objective.keyResults) {
      if (kr.routineId == null && !checked.has(kr.id)) count += 1;
    }
  }
  return count;
}

/** 'YYYY-Qn' → {start,end}(YYYY-MM-DD, inclusive). 형식 밖이면 null. okr.rs quarter_window 미러. */
export function quarterDateRange(quarter: string): { start: string; end: string } | null {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return null;
  const year = Number(match[1]);
  const q = Number(match[2]);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(new Date(year, (q - 1) * 3, 1)), end: fmt(new Date(year, q * 3, 0)) };
}

// ── 분기 키('YYYY-Qn') 헬퍼 — MissionView 계열 공용 ────────────────────────────

export function parseQuarter(quarter: string): { year: number; quarter: number } {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return { year: new Date().getFullYear(), quarter: 1 };
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

export function quarterFromIndex(year: number, quarter: number, offset: number): string {
  const zeroBased = year * 4 + (quarter - 1) + offset;
  return `${Math.floor(zeroBased / 4)}-Q${(zeroBased % 4) + 1}`;
}

export function adjacentQuarter(quarter: string, offset: number): string {
  const parsed = parseQuarter(quarter);
  return quarterFromIndex(parsed.year, parsed.quarter, offset);
}

/** 분기 선택 옵션 — 기준 분기 ±α(과거 4, 미래 2). */
export function quarterOptions(centerQuarter: string): string[] {
  const parsed = parseQuarter(centerQuarter);
  return Array.from({ length: 7 }, (_, index) =>
    quarterFromIndex(parsed.year, parsed.quarter, index - 4),
  );
}

export function quarterElapsedRatio(quarter: string, date = new Date()): number {
  const parsed = parseQuarter(quarter);
  const start = new Date(parsed.year, (parsed.quarter - 1) * 3, 1);
  const end = new Date(parsed.year, parsed.quarter * 3, 0, 23, 59, 59, 999);
  if (date <= start) return 0;
  if (date >= end) return 1;
  return (date.getTime() - start.getTime()) / (end.getTime() - start.getTime());
}

export function quarterLabel(quarter: string): string {
  const parsed = parseQuarter(quarter);
  return `${parsed.year}년 ${parsed.quarter}분기`;
}

export function percentLabel(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

export function weekStartMonday(date = new Date()): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = monday.getDay();
  monday.setDate(monday.getDate() - ((day + 6) % 7));
  const month = String(monday.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${month}-${dayOfMonth}`;
}
