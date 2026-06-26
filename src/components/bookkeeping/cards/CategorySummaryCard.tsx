import { ReceiptText } from "lucide-react";

import type { BookkeepingCategorySummary } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { currency } from "../bookkeepingFormat";
import { EmptyState } from "./_shared";

export function CategorySummaryCard({
  rows,
  recurringCount,
}: {
  rows: BookkeepingCategorySummary[];
  recurringCount: number;
}) {
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          카테고리
        </CardTitle>
        <CardDescription>등록된 고정비 {recurringCount}개</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bk-category-list">
          {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
          {rows.map((row) => (
            <div key={row.category} className="bk-category-row typo-body-md">
              <span>{row.category}</span>
              <span>{currency.format(row.amountMinor)}</span>
              <Badge variant="outline">{row.count}</Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
