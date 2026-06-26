import { AlertTriangle, Ban, Check } from "lucide-react";

import type { BookkeepingRecurringOccurrence } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { currency } from "../bookkeepingFormat";
import { expenseKindLabel, occurrenceStatusLabel } from "../bookkeepingLabels";
import { paymentSummary } from "./cardHelpers";

export function RecurringOccurrenceRow({
  occurrence,
  disabled,
  onConfirm,
  onSkip,
}: {
  occurrence: BookkeepingRecurringOccurrence;
  disabled: boolean;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  return (
    <article className="bk-row bk-transaction" data-status={occurrence.status}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{occurrence.recurringName}</strong>
          {occurrence.merchant && (
            <span className="text-muted-foreground typo-caption-sm">{occurrence.merchant}</span>
          )}
        </div>
        <div className="bk-row-meta typo-caption-sm">
          <span>{occurrence.dueDate}</span>
          <Badge variant="outline">{occurrence.category}</Badge>
          <Badge variant="secondary">{expenseKindLabel(occurrence.expenseKind)}</Badge>
          <span>
            {paymentSummary(
              occurrence.paymentMethodKind,
              occurrence.paymentMethodLabel,
              occurrence.paymentMethodLast4,
            )}
          </span>
          <span>{occurrenceStatusLabel(occurrence.status)}</span>
        </div>
        {occurrence.note && (
          <p className="text-muted-foreground typo-caption-sm">{occurrence.note}</p>
        )}
      </div>
      <div className="bk-row-amount typo-title-sm">{currency.format(occurrence.amountMinor)}</div>
      <div className="bk-row-actions">
        {occurrence.status === "planned" && (
          <>
            <Button size="sm" variant="outline" disabled={disabled} onClick={onConfirm}>
              <Check className="size-3.5" />
              확정
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={onSkip}>
              <Ban className="size-3.5" />
              건너뜀
            </Button>
          </>
        )}
        {occurrence.status === "posted" && <Check className="size-4 text-[color:var(--success)]" />}
        {occurrence.status === "skipped" && (
          <AlertTriangle className="text-muted-foreground size-4" />
        )}
      </div>
    </article>
  );
}
