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

/** 이번 주(weekStart 기준) 아직 체크인 안 된 활성 Objective KR 수 — Weekly/보드 넛지 공용. */
export function uncheckedKrCount(
  objectives: { status: Objective["status"]; keyResults: Pick<KeyResult, "id">[] }[],
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
      if (!checked.has(kr.id)) count += 1;
    }
  }
  return count;
}

export function weekStartMonday(date = new Date()): string {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = monday.getDay();
  monday.setDate(monday.getDate() - ((day + 6) % 7));
  const month = String(monday.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(monday.getDate()).padStart(2, "0");
  return `${monday.getFullYear()}-${month}-${dayOfMonth}`;
}
