import { Repeat } from "lucide-react";

import type { BookkeepingRecurringMonthStatus } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { currency } from "../bookkeepingFormat";
import { recurringPaymentBadge } from "../recurringMirror";
import { EmptyState } from "./_shared";

const BADGE_VARIANT = {
  paid: "secondary",
  upcoming: "outline",
  overdue: "destructive",
} as const;

/** 고정비 미러 카드 — 머니매니저가 원장(읽기 전용). 납부 여부는 임포트된 실거래
 *  매칭으로 파생되므로 이 카드에는 어떤 편집/확정 동작도 없다. */
export function RecurringMirrorCard({
  status,
  today,
}: {
  status: BookkeepingRecurringMonthStatus | null;
  today: string;
}) {
  const rows = status?.rows ?? [];
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-header-row">
        <div>
          <CardTitle className="bk-card-title">
            <Repeat className="size-4" />
            이번 달 고정비
          </CardTitle>
          <CardDescription className="bk-card-desc">
            머니매니저(원장)의 반복 지출을 읽기 전용으로 미러합니다 — 수정은 머니매니저 앱에서
            해주세요.
          </CardDescription>
        </div>
        {status && rows.length > 0 && (
          <span className="text-muted-foreground typo-caption-sm">
            합계 {currency.format(status.plannedTotalMinor)} · 납부{" "}
            {currency.format(status.paidTotalMinor)} · 남음{" "}
            {currency.format(status.remainingTotalMinor)}
          </span>
        )}
      </CardHeader>
      <CardContent className="bk-card-body">
        <div className="bk-transaction-list">
          {rows.length === 0 && (
            <EmptyState>이번 달 고정비 없음 — 머니매니저 백업에서 자동으로 미러됩니다</EmptyState>
          )}
          {rows.map((row) => {
            const badge = recurringPaymentBadge(row, today);
            return (
              <article key={row.ruleId} className="bk-row bk-transaction" data-status={badge.kind}>
                <div className="bk-row-main">
                  <div className="bk-row-title">
                    <strong className="typo-body-strong">{row.name}</strong>
                    {row.merchant && (
                      <span className="text-muted-foreground typo-caption-sm">{row.merchant}</span>
                    )}
                  </div>
                  <div className="bk-row-meta typo-caption-sm">
                    <span>매월 {row.scheduleDay}일</span>
                    <Badge variant="outline">{row.category}</Badge>
                    <Badge variant={BADGE_VARIANT[badge.kind]}>{badge.label}</Badge>
                  </div>
                </div>
                <div className="bk-row-amount typo-title-sm">
                  {currency.format(row.amountMinor)}
                </div>
              </article>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
