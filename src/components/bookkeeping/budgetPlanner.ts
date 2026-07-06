// 예산 탭 순수 헬퍼 — KPI 합산·한도 입력 파싱·산정 기준 월 옵션. (표현/IO 없음)

import type { BookkeepingBudgetPlanRow } from "@/bindings";

export const BUDGET_SUGGESTION_MONTH_OPTIONS = [3, 6, 12] as const;
export const DEFAULT_BUDGET_SUGGESTION_MONTHS = 3;

export type BudgetPlanSummary = {
  totalLimitMinor: number;
  totalSpentMinor: number;
  totalRemainingMinor: number;
  unsetCount: number;
};

/** 상단 KPI 합산 — 총 예산(설정된 한도 합)·총 지출(전 행)·총 잔여·미설정 카테고리 수. */
export function summarizeBudgetPlan(rows: readonly BookkeepingBudgetPlanRow[]): BudgetPlanSummary {
  let totalLimitMinor = 0;
  let totalSpentMinor = 0;
  let totalRemainingMinor = 0;
  let unsetCount = 0;
  for (const row of rows) {
    totalSpentMinor += row.spentMinor;
    if (row.hasBudget) {
      totalLimitMinor += row.limitMinor ?? 0;
      totalRemainingMinor += row.remainingMinor;
    } else {
      unsetCount += 1;
    }
  }
  return { totalLimitMinor, totalSpentMinor, totalRemainingMinor, unsetCount };
}

/** 인라인 한도 입력 파싱 — 콤마/공백/₩ 허용. 빈값·음수·NaN은 null(저장 스킵). */
export function parseBudgetAmount(value: string): number | null {
  const normalized = value.replace(/[,\s₩]/g, "");
  if (normalized === "") return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}
