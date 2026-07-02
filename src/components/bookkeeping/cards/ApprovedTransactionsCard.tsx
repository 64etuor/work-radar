import { ReceiptText } from "lucide-react";
import { useState } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { EmptyState } from "./_shared";
import { TransactionEditForm } from "./TransactionEditForm";
import { TransactionReadRow } from "./TransactionReadRow";

export function ApprovedTransactionsCard({
  rows,
  disabled,
  onDelete,
  onSave,
  onCategoryChange,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onDelete: (tx: BookkeepingTransaction) => void;
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => void;
  /** 인라인 분류 quick action — audit이 남는 override 경로로 처리한다. */
  onCategoryChange: (tx: BookkeepingTransaction, categoryCode: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          확정 거래
        </CardTitle>
        <CardDescription>
          최근 원장 거래입니다. 행을 클릭하면 전체 필드를 수정하고, 분류는 바로 바꿀 수 있습니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
          {rows
            .slice(0, 12)
            .map((tx) =>
              expandedId === tx.id ? (
                <TransactionEditForm
                  key={tx.id}
                  tx={tx}
                  disabled={disabled}
                  onDelete={() => onDelete(tx)}
                  onSave={(draft) => onSave(tx, draft)}
                  onCancel={() => setExpandedId(null)}
                />
              ) : (
                <TransactionReadRow
                  key={tx.id}
                  tx={tx}
                  disabled={disabled}
                  onEdit={() => setExpandedId(tx.id)}
                  onDelete={() => onDelete(tx)}
                  onCategoryChange={(categoryCode) => onCategoryChange(tx, categoryCode)}
                />
              ),
            )}
        </div>
      </CardContent>
    </Card>
  );
}
