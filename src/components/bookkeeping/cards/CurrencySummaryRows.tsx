import type { BookkeepingCurrencySummary } from "@/bindings";

import { formatCurrencyMinor } from "../bookkeepingFormat";

export function CurrencySummaryRows({ rows }: { rows: BookkeepingCurrencySummary[] }) {
  if (rows.length <= 1) return null;
  return (
    <section className="bk-currency-summary" aria-label="통화별 월 요약">
      {rows.map((row) => (
        <div key={row.currency} className="bk-currency-row">
          <strong className="typo-body-strong">{row.currency}</strong>
          <span className="typo-caption-sm">
            지출 {formatCurrencyMinor(row.expenseMinor, row.currency)}
          </span>
          <span className="typo-caption-sm">
            수입 {formatCurrencyMinor(row.incomeMinor, row.currency)}
          </span>
          <span className="typo-caption-sm">
            순액 {formatCurrencyMinor(row.netMinor, row.currency)}
          </span>
        </div>
      ))}
    </section>
  );
}
