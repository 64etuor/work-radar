import { currency } from "../bookkeepingFormat";
import { Metric } from "./_shared";

export function BookkeepingMetrics({
  totalExpenseMinor,
  totalIncomeMinor,
  netMinor,
  fixedRemainingMinor,
  needsReviewCount,
  approvedCount,
}: {
  totalExpenseMinor: number;
  totalIncomeMinor: number;
  netMinor: number;
  /** 아직 납부되지 않은 이번 달 고정비 합 — 납부분은 지출 합계에 이미 포함(이중집계 없음). */
  fixedRemainingMinor: number;
  needsReviewCount: number;
  approvedCount: number;
}) {
  return (
    <section className="bk-metrics" aria-label="월별 요약">
      <Metric label="지출 합계" value={currency.format(totalExpenseMinor)} />
      <Metric label="수입 합계" value={currency.format(totalIncomeMinor)} />
      <Metric label="순액" value={currency.format(netMinor)} />
      <Metric label="남은 고정비" value={currency.format(fixedRemainingMinor)} />
      <Metric label="리뷰 대기" value={String(needsReviewCount)} />
      <Metric label="승인" value={String(approvedCount)} />
    </section>
  );
}
