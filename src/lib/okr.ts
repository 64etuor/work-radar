import type { KeyResult, Objective, OkrCheckIn } from "@/bindings";

export type KeyResultProgressSource = Pick<
  KeyResult,
  "kind" | "currentValue" | "targetValue" | "milestones"
>;

export function keyResultProgressRatio(kr: KeyResultProgressSource): number {
  if (kr.kind === "metric") {
    if (kr.currentValue == null || kr.targetValue == null || kr.targetValue <= 0) return 0;
    if (kr.currentValue > kr.targetValue) return kr.targetValue / kr.currentValue;
    return kr.currentValue / kr.targetValue;
  }
  if (kr.milestones.length === 0) return 0;
  return kr.milestones.filter((milestone) => milestone.done).length / kr.milestones.length;
}

export function objectiveProgressRatio(krs: KeyResultProgressSource[]): number {
  if (krs.length === 0) return 0;
  return krs.reduce((sum, kr) => sum + keyResultProgressRatio(kr), 0) / krs.length;
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

function parseQuarter(quarter: string): { year: number; quarter: number } {
  const match = quarter.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return { year: new Date().getFullYear(), quarter: 1 };
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function quarterFromIndex(year: number, quarter: number, offset: number): string {
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
