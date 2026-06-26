import { currency } from "../bookkeepingFormat";
import { Metric } from "./_shared";

export function BookkeepingMetrics({
  totalExpenseMinor,
  totalIncomeMinor,
  netMinor,
  plannedTotal,
  needsReviewCount,
  approvedCount,
}: {
  totalExpenseMinor: number;
  totalIncomeMinor: number;
  netMinor: number;
  plannedTotal: number;
  needsReviewCount: number;
  approvedCount: number;
}) {
  return (
    <section className="bk-metrics" aria-label="월별 요약">
      <Metric label="지출 합계" value={currency.format(totalExpenseMinor)} />
      <Metric label="수입 합계" value={currency.format(totalIncomeMinor)} />
      <Metric label="순액" value={currency.format(netMinor)} />
      <Metric label="예정 고정비" value={currency.format(plannedTotal)} />
      <Metric label="리뷰 대기" value={String(needsReviewCount)} />
      <Metric label="승인" value={String(approvedCount)} />
    </section>
  );
}
