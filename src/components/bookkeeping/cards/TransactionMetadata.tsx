import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";

import {
  directionLabel,
  expenseKindLabel,
  reviewReasonCodes,
  sourceLabel,
  statusLabel,
} from "../bookkeepingLabels";
import { paymentSummary } from "./cardHelpers";

export function TransactionMetadata({
  tx,
  compact = false,
}: {
  tx: BookkeepingTransaction;
  compact?: boolean;
}) {
  const reasons = reviewReasonCodes(tx.reviewReasonsJson);
  return (
    <>
      <div className="bk-row-meta typo-caption-sm">
        <span>
          {tx.spentAt}
          {tx.spentAtTime ? ` ${tx.spentAtTime}` : ""}
        </span>
        <Badge variant={tx.direction === "income" ? "secondary" : "outline"}>
          {directionLabel(tx.direction)}
        </Badge>
        <Badge variant="outline">{tx.category}</Badge>
        {tx.subcategory && <Badge variant="outline">{tx.subcategory}</Badge>}
        {tx.account && <span>· {tx.account}</span>}
        <Badge variant="outline">{sourceLabel(tx.source)}</Badge>
        <Badge variant={tx.expenseKind === "variable" ? "outline" : "secondary"}>
          {expenseKindLabel(tx.expenseKind)}
        </Badge>
        {!compact && (
          <span>
            {paymentSummary(tx.paymentMethodKind, tx.paymentMethodLabel, tx.paymentMethodLast4)}
          </span>
        )}
        {tx.confidence != null && <span>신뢰도 {Math.round(tx.confidence * 100)}%</span>}
        {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
        <span>{statusLabel(tx.reviewStatus)}</span>
        <span>생성 {tx.createdAt}</span>
      </div>
      {reasons.length > 0 && (
        <div className="bk-row-reasons typo-caption-sm">
          {reasons.map((code) => (
            <Badge key={code} variant="secondary">
              {code}
            </Badge>
          ))}
        </div>
      )}
      {!compact && tx.note && <p className="text-muted-foreground typo-caption-sm">{tx.note}</p>}
    </>
  );
}
