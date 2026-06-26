import { RotateCcw } from "lucide-react";

import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { currency } from "../bookkeepingFormat";
import { sourceLabel } from "../bookkeepingLabels";

export function TrashTransactionRow({
  tx,
  disabled,
  onRestore,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  onRestore: () => void;
}) {
  const reason = tx.deletedAt ? "삭제됨" : "중복·무시";
  return (
    <article className="bk-row bk-transaction" data-status={tx.reviewStatus}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{tx.merchant}</strong>
          {tx.description && (
            <span className="text-muted-foreground typo-caption-sm">{tx.description}</span>
          )}
        </div>
        <div className="bk-row-meta typo-caption-sm">
          <Badge variant={tx.deletedAt ? "destructive" : "secondary"}>{reason}</Badge>
          <span>{tx.spentAt}</span>
          <span>{currency.format(tx.amountMinor)}</span>
          <Badge variant="outline">{sourceLabel(tx.source)}</Badge>
          {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
        </div>
      </div>
      <div className="bk-row-actions">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRestore}>
          <RotateCcw className="size-3.5" />
          복원
        </Button>
      </div>
    </article>
  );
}
