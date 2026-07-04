import type { BookkeepingTransaction } from "@/bindings";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { sourceLabel } from "../bookkeepingLabels";
import { TransactionEditForm } from "./TransactionEditForm";

/**
 * 거래 전체 편집 — 행 인라인 확장(리스트를 밀어내는 큰 폼)을 대체하는 우측 Sheet.
 * 테이블이 뒤에 그대로 보여 맥락이 유지되고, 인라인 셀로 못 고치는 필드
 * (비용유형·주문/결제번호·설명·분할·중복 검토)가 여기로 온다.
 * tx=null이면 닫힘. 저장 성공 시 상위가 tx를 null로 되돌려 닫는다.
 */
export function TransactionEditSheet({
  tx,
  disabled,
  approveLabel,
  onApprove,
  onDelete,
  onSave,
  onClose,
}: {
  tx: BookkeepingTransaction | null;
  disabled: boolean;
  approveLabel?: string;
  onApprove?: (tx: BookkeepingTransaction) => void;
  onDelete: (tx: BookkeepingTransaction) => void;
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={tx !== null} onOpenChange={(open) => !open && onClose()}>
      {tx && (
        <SheetContent className="bk-edit-sheet sm:max-w-[560px]">
          <div className="bk-edit-sheet-head">
            <SheetTitle className="bk-edit-sheet-title">{tx.merchant}</SheetTitle>
            <div className="bk-edit-sheet-sub typo-caption-sm">
              <span data-direction={tx.direction} className="bk-edit-sheet-amount">
                {currency.format(tx.amountMinor)}
              </span>
              <span className="text-muted-foreground">
                {tx.source !== "manual" && tx.sourceRef
                  ? `${sourceLabel(tx.source)} · ${tx.sourceRef}`
                  : sourceLabel(tx.source)}
              </span>
            </div>
          </div>
          <div className="bk-edit-sheet-body">
            <TransactionEditForm
              key={tx.id}
              tx={tx}
              embedded
              disabled={disabled}
              approveLabel={approveLabel}
              onApprove={onApprove ? () => onApprove(tx) : undefined}
              onDelete={() => onDelete(tx)}
              onSave={(draft) => onSave(tx, draft)}
              onCancel={onClose}
            />
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}
