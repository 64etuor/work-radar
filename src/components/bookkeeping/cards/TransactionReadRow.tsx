import { Pencil, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Button } from "@/components/ui/button";

import { effectiveCategoryCode } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { isInteractiveTarget } from "../rowActivation";
import { CategorySelect } from "./CategorySelect";
import { TransactionMetadata } from "./TransactionMetadata";

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
  // 행 클릭 = 편집 열기 (마우스 편의). 키보드/AT 경로는 눈에 보이는 "편집" 버튼이
  // 담당한다 — article에 tabIndex/role을 얹으면 중첩 인터랙티브가 되므로 두지 않는다.
  // 안쪽 버튼·셀렉트에서 시작한 클릭은 건너뛰어 이중 동작을 막는다.
  const activateFromClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled || isInteractiveTarget(event.target)) return;
    onEdit();
  };
  return (
    <article
      className="bk-row bk-transaction bk-row-editable"
      data-status={tx.reviewStatus}
      onClick={activateFromClick}
    >
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
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onEdit}>
          <Pencil className="size-3.5" />
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
