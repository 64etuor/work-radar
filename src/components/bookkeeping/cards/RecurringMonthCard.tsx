import { CalendarCheck, RefreshCw } from "lucide-react";

import type { BookkeepingRecurringOccurrence } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { EmptyState } from "./_shared";
import { RecurringOccurrenceRow } from "./RecurringOccurrenceRow";

export function RecurringMonthCard({
  rows,
  ensurePending,
  actionPending,
  onEnsure,
  onConfirm,
  onSkip,
}: {
  rows: BookkeepingRecurringOccurrence[];
  ensurePending: boolean;
  actionPending: boolean;
  onEnsure: () => void;
  onConfirm: (occurrence: BookkeepingRecurringOccurrence) => void;
  onSkip: (occurrence: BookkeepingRecurringOccurrence) => void;
}) {
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-header-row">
        <div>
          <CardTitle className="bk-card-title">
            <CalendarCheck className="size-4" />
            이번 달 고정비
          </CardTitle>
          <CardDescription>
            메일로 관측되지 않는 지출은 예정 건으로 만든 뒤 거래로 확정합니다.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onEnsure} disabled={ensurePending}>
          <RefreshCw className="size-3.5" />월 예정 반영
        </Button>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>예정 고정비 없음</EmptyState>}
          {rows.map((occurrence) => (
            <RecurringOccurrenceRow
              key={occurrence.id}
              occurrence={occurrence}
              disabled={actionPending}
              onConfirm={() => onConfirm(occurrence)}
              onSkip={() => onSkip(occurrence)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
