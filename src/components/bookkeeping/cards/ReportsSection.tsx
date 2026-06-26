import { Landmark, Tags } from "lucide-react";

import type { BookkeepingCashflowRow, BookkeepingCategoryTrendRow } from "@/bindings";
import { formatMonthValue } from "@/components/periodNavigatorUtils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { SectionLabel } from "../../settings/SettingsKit";
import { reportSeriesMax } from "../reports";
import { EmptyState, ReportBar } from "./_shared";

export function ReportsSection({
  cashflow,
  categoryTrend,
}: {
  cashflow: BookkeepingCashflowRow[];
  categoryTrend: BookkeepingCategoryTrendRow[];
}) {
  const cashflowMax = reportSeriesMax(
    cashflow.flatMap((row) => [row.incomeMinor, row.expenseMinor, row.netMinor]),
  );
  const categoryTotals = Array.from(
    categoryTrend
      .reduce((map, row) => {
        const current = map.get(row.categoryCode) ?? {
          categoryCode: row.categoryCode,
          label: row.label,
          expenseMinor: 0,
        };
        current.expenseMinor += row.expenseMinor;
        map.set(row.categoryCode, current);
        return map;
      }, new Map<string, { categoryCode: string; label: string; expenseMinor: number }>())
      .values(),
  )
    .sort((a, b) => b.expenseMinor - a.expenseMinor || a.categoryCode.localeCompare(b.categoryCode))
    .slice(0, 5);
  const categoryMax = reportSeriesMax(categoryTotals.map((row) => row.expenseMinor));

  return (
    <section className="bk-reports" aria-labelledby="bk-reports-title">
      <div className="bk-reports-head">
        <div>
          <SectionLabel>Reports</SectionLabel>
          <h2 id="bk-reports-title" className="bk-section-title">
            리포트
          </h2>
        </div>
        <span className="typo-caption-sm text-muted-foreground">최근 6개월 · KRW net</span>
      </div>

      <div className="bk-report-grid">
        <Card className="bk-card">
          <CardHeader>
            <CardTitle className="bk-card-title">
              <Landmark className="size-4" />
              Cash-flow
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bk-report-list">
              {cashflow.length === 0 && <EmptyState>현금흐름 없음</EmptyState>}
              {cashflow.map((row) => (
                <div key={row.month} className="bk-report-row">
                  <span className="bk-report-label typo-body-strong">
                    {formatMonthValue(row.month)}
                  </span>
                  <div className="bk-report-bars">
                    <ReportBar
                      label="수입"
                      value={row.incomeMinor}
                      max={cashflowMax}
                      tone="income"
                    />
                    <ReportBar
                      label="지출"
                      value={row.expenseMinor}
                      max={cashflowMax}
                      tone="expense"
                    />
                    <ReportBar label="순액" value={row.netMinor} max={cashflowMax} tone="net" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="bk-card">
          <CardHeader>
            <CardTitle className="bk-card-title">
              <Tags className="size-4" />
              Category trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bk-report-list">
              {categoryTotals.length === 0 && <EmptyState>카테고리 지출 없음</EmptyState>}
              {categoryTotals.map((row) => (
                <div key={row.categoryCode} className="bk-report-row">
                  <span className="bk-report-label typo-body-strong">{row.label}</span>
                  <ReportBar
                    label="지출"
                    value={row.expenseMinor}
                    max={categoryMax}
                    tone="expense"
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
