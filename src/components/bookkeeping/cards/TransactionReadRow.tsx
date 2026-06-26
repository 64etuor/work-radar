import { Trash2 } from "lucide-react";

import type { BookkeepingTransaction } from "@/bindings";
import { Button } from "@/components/ui/button";

import { currency } from "../bookkeepingFormat";
import { TransactionMetadata } from "./TransactionMetadata";

export function TransactionReadRow({
  tx,
  disabled,
  onEdit,
  onDelete,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="bk-row bk-transaction" data-status={tx.reviewStatus}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{tx.merchant}</strong>
          {tx.description && (
            <span className="text-muted-foreground typo-caption-sm">{tx.description}</span>
          )}
        </div>
        <TransactionMetadata tx={tx} compact />
      </div>
      <div className="bk-row-amount typo-title-sm">{currency.format(tx.amountMinor)}</div>
      <div className="bk-row-actions">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onEdit}>
          편집
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
          <Trash2 className="size-3.5" />
          삭제
        </Button>
      </div>
    </article>
  );
}
