import { PanelRight, Trash2 } from "lucide-react";

import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";

import { effectiveCategoryCode, type TransactionEditDraft } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { directionLabel } from "../bookkeepingLabels";
import { CategorySelect } from "./CategorySelect";
import { DateTimeCell, EditableTextCell, PaymentCellEditor } from "./EditableCell";

/**
 * 원장(확정 거래) 테이블 한 행 — 핵심 필드는 셀에서 바로 편집한다
 * (날짜=DatePicker 즉시 커밋, 시각/가맹점/금액=스왑 입력, 분류=quick select,
 * 결제=팝오버 미니폼, 메모=상호 아래 서브라인). 상세(비용유형·번호·분할·중복)는
 * 우측 Sheet(onOpenDetail)로 연다. 행 클릭 편집은 폐지 — 셀 자체가 인터랙티브다.
 */
export function TransactionReadRow({
  tx,
  disabled,
  onOpenDetail,
  onDelete,
  onCategoryChange,
  onPatch,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  /** 우측 Sheet 전체 편집 열기. */
  onOpenDetail: () => void;
  onDelete: () => void;
  /** 인라인 분류 변경 quick action — audit이 남는 override 경로로 라우팅된다. */
  onCategoryChange?: (categoryCode: string) => void;
  /** 필드 일부만 바꾼 저장(현재 tx + patch 합성은 상위 소유) — 성공 여부 반환. */
  onPatch: (patch: Partial<TransactionEditDraft>) => Promise<boolean>;
}) {
  const currentCategory = effectiveCategoryCode(tx);
  return (
    <TableRow className="bk-tr" data-status={tx.reviewStatus}>
      <TableCell className="bk-td-date">
        <DateTimeCell
          merchant={tx.merchant}
          spentAt={tx.spentAt}
          spentAtTime={tx.spentAtTime}
          disabled={disabled}
          onPatch={onPatch}
        />
      </TableCell>
      <TableCell className="bk-td-main">
        <EditableTextCell
          value={tx.merchant}
          ariaLabel={`${tx.merchant} 가맹점 변경`}
          disabled={disabled}
          onCommit={(merchant) => onPatch({ merchant })}
        />
      </TableCell>
      <TableCell className="bk-td-note">
        {/* 내용 = note 칼럼(DB `note` — .mmbak '내용'이 유입되는 필드). 원본 설명(description)은 Sheet. */}
        <EditableTextCell
          value={tx.note ?? ""}
          ariaLabel={`${tx.merchant} 내용 변경`}
          disabled={disabled}
          onCommit={(note) => onPatch({ note })}
        />
      </TableCell>
      <TableCell className="bk-td-category">
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
      </TableCell>
      <TableCell className="bk-td-payment">
        <PaymentCellEditor
          id={`bk-pay-${tx.id}`}
          kind={tx.paymentMethodKind}
          label={tx.paymentMethodLabel}
          last4={tx.paymentMethodLast4}
          account={tx.account}
          disabled={disabled}
          ariaLabel={`${tx.merchant} 결제·자산 변경`}
          onCommit={(payment) => onPatch(payment)}
        />
      </TableCell>
      <TableCell className="bk-td-direction">
        <Badge variant={tx.direction === "income" ? "secondary" : "outline"}>
          {directionLabel(tx.direction)}
        </Badge>
      </TableCell>
      <TableCell className="bk-td-amount">
        <EditableTextCell
          value={String(tx.amountMinor)}
          display={
            <span
              className="bk-cell-amount typo-title-sm"
              data-direction={tx.direction}
              title={tx.currency !== "KRW" ? tx.currency : undefined}
            >
              {currency.format(tx.amountMinor)}
            </span>
          }
          inputMode="numeric"
          align="right"
          ariaLabel={`${tx.merchant} 금액 변경`}
          disabled={disabled}
          onCommit={(amount) => onPatch({ amount })}
        />
      </TableCell>
      <TableCell className="bk-td-actions">
        <div className="bk-row-actions bk-ledger-actions">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={onOpenDetail}
            aria-label={`${tx.merchant} 상세 편집`}
            title="상세 편집"
          >
            <PanelRight className="size-3.5" />
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
      </TableCell>
    </TableRow>
  );
}
