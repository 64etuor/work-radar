import { ShieldAlert } from "lucide-react";
import { useState } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useFindBookkeepingDuplicateCandidates, useMarkBookkeepingDuplicate } from "@/lib/query";

import { pushMutationError } from "../bookkeepingFieldUtils";
import { currency } from "../bookkeepingFormat";
import { reviewReasonCodes, sourceLabel } from "../bookkeepingLabels";
import { duplicateQueryFromTransaction, formatDuplicateScore } from "../duplicates";

export function DuplicateCandidates({
  tx,
  disabled,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
}) {
  // Forward-looking auto-open: expands when the row carries a `possible_duplicate` review reason.
  // No ingest path emits that reason yet (a producer is a deferred Rust follow-up), so in practice
  // the panel is opened manually via the button below — this wiring is ready for when a detector lands.
  const flagged = reviewReasonCodes(tx.reviewReasonsJson).includes("possible_duplicate");
  const [open, setOpen] = useState(flagged);
  const query = useFindBookkeepingDuplicateCandidates(duplicateQueryFromTransaction(tx), open);
  const markDuplicate = useMarkBookkeepingDuplicate();
  const busy = disabled || markDuplicate.isPending;
  const candidates = query.data ?? [];

  return (
    <section className="bk-duplicates" aria-label="중복 후보">
      <Button
        type="button"
        size="sm"
        variant={flagged ? "outline" : "ghost"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ShieldAlert className="size-3.5" />
        중복 의심{flagged ? " · 검토 필요" : ""}
      </Button>
      {open &&
        (query.isPending ? (
          <p className="text-muted-foreground typo-caption-sm">중복 후보 확인 중…</p>
        ) : candidates.length === 0 ? (
          <p className="text-muted-foreground typo-caption-sm">중복 후보 없음</p>
        ) : (
          <ul className="bk-duplicates-list">
            {candidates.map((candidate) => (
              <li key={candidate.transaction.id} className="bk-duplicate-row">
                <div className="bk-duplicate-info typo-caption-sm">
                  <strong className="typo-body-strong">{candidate.transaction.merchant}</strong>
                  <span>{candidate.transaction.spentAt}</span>
                  <span>{currency.format(candidate.transaction.amountMinor)}</span>
                  <Badge variant="outline">{sourceLabel(candidate.transaction.source)}</Badge>
                  {candidate.score != null && (
                    <Badge variant="secondary">
                      유사도 {formatDuplicateScore(candidate.score)}
                    </Badge>
                  )}
                  {candidate.reasons.map((reason) => (
                    <Badge key={reason} variant="outline">
                      {reason}
                    </Badge>
                  ))}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    markDuplicate.mutate(
                      { id: tx.id, duplicateOfTransactionId: candidate.transaction.id },
                      {
                        onError: (error) => pushMutationError("bookkeeping.markDuplicate", error),
                      },
                    )
                  }
                >
                  이 거래를 중복으로 표시
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
