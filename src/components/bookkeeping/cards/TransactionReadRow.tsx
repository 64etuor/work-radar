import { Pencil, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Button } from "@/components/ui/button";

import { effectiveCategoryCode } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { isInteractiveTarget } from "../rowActivation";
import { paymentSummary } from "./cardHelpers";
import { CategorySelect } from "./CategorySelect";

export function TransactionReadRow({
  tx,
  disabled,
  onEdit,
  onDelete,
  onCategoryChange,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /** 인라인 분류 변경 quick action — override 커맨드 경로로 라우팅된다. */
  onCategoryChange?: (categoryCode: string) => void;
}) {
  // 편집 폼과 동일한 유효 분류(레거시 행은 category fallback) — 표시와 변경이 같은 값을 본다.
  const currentCategory = effectiveCategoryCode(tx);
  // 메모가 있으면 메모, 없으면 원본 설명 — 상호 아래 한 줄 muted로 잘라 보여준다.
  const note = tx.note ?? tx.description;
  // 행 클릭 = 편집 열기 (마우스 편의). 키보드/AT 경로는 눈에 보이는 "편집" 버튼이
  // 담당한다 — article에 tabIndex/role을 얹으면 중첩 인터랙티브가 되므로 두지 않는다.
  // 안쪽 버튼·셀렉트에서 시작한 클릭은 건너뛰어 이중 동작을 막는다.
  const activateFromClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled || isInteractiveTarget(event.target)) return;
    onEdit();
  };
  return (
    <article
      className="bk-row bk-transaction bk-ledger-row bk-row-editable"
      data-status={tx.reviewStatus}
      onClick={activateFromClick}
    >
      <span className="bk-ledger-date typo-caption-sm">
        {tx.spentAt}
        {tx.spentAtTime && <span className="bk-ledger-time">{tx.spentAtTime}</span>}
      </span>
      <span className="bk-ledger-main">
        <strong className="bk-ledger-merchant typo-body-strong" title={tx.merchant}>
          {tx.merchant}
        </strong>
        {note && (
          <span className="bk-ledger-note text-muted-foreground typo-caption-sm" title={note}>
            {note}
          </span>
        )}
      </span>
      <span className="bk-ledger-category">
        {onCategoryChange && (
          <div className="bk-row-quick-category" data-category={currentCategory}>
            <CategorySelect
              id={`bk-quick-${tx.id}-category`}
              value={currentCategory}
              disabled={disabled}
              ariaLabel={`${tx.merchant} 분류 변경`}
              onValueChange={onCategoryChange}
            />
          </div>
        )}
      </span>
      <span className="bk-ledger-payment text-muted-foreground typo-caption-sm">
        {paymentSummary(tx.paymentMethodKind, tx.paymentMethodLabel, tx.paymentMethodLast4)}
      </span>
      <span
        className="bk-ledger-amount typo-title-sm"
        data-direction={tx.direction}
        title={tx.currency !== "KRW" ? tx.currency : undefined}
      >
        {currency.format(tx.amountMinor)}
      </span>
      <div className="bk-row-actions bk-ledger-actions">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onEdit}
          aria-label={`${tx.merchant} 편집`}
          title="편집"
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={onDelete}
          aria-label={`${tx.merchant} 삭제`}
          title="삭제"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </article>
  );
}
