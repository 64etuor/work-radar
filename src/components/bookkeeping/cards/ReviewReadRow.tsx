import { Check, PanelRight, Trash2 } from "lucide-react";

import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";

import { effectiveCategoryCode, type TransactionEditDraft } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { reviewReasonCodes } from "../bookkeepingLabels";
import { truncateReviewChips } from "../reviewRow";
import { CategorySelect } from "./CategorySelect";
import { DateTimeCell, EditableTextCell, NoteInlineEditor } from "./EditableCell";

/**
 * 검토 큐의 테이블 한 행 — 원장(TransactionReadRow)과 같은 셀 문법으로 인라인 편집한다
 * (날짜/시각·가맹점·메모·금액=인라인, 분류=quick select[검토 전이라 draft 저장 경로],
 * 사유 칩은 표시 전용). 상세는 우측 Sheet(onOpenDetail), 확정/삭제는 행에서 즉시.
 * data-active는 j/k 트리아지 하이라이트(상위 소유).
 */
export function ReviewReadRow({
  tx,
  disabled,
  active,
  selected,
  selectionDisabled,
  showApprove,
  onToggleSelect,
  onApprove,
  onOpenDetail,
  onDelete,
  onPatch,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  /** j/k 트리아지 활성 행 하이라이트. */
  active: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  /** 의심 그룹만 개별 확정 버튼을 노출한다 — 정상 그룹은 그룹 헤더 일괄 확정. */
  showApprove: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onOpenDetail: () => void;
  onDelete: () => void;
  /** 필드 일부만 바꾼 저장(현재 tx + patch 합성은 상위 소유) — 성공 여부 반환. */
  onPatch: (patch: Partial<TransactionEditDraft>) => Promise<boolean>;
}) {
  const { visible, hiddenCount } = truncateReviewChips(reviewReasonCodes(tx.reviewReasonsJson));
  return (
    <TableRow
      className="bk-tr bk-review-tr"
      data-status={tx.reviewStatus}
      data-active={active ? "true" : "false"}
    >
      <TableCell className="bk-td-check">
        <Checkbox
          className="bk-select-check"
          checked={selected}
          onCheckedChange={onToggleSelect}
          disabled={selectionDisabled}
          aria-label={`${tx.merchant} 선택`}
        />
      </TableCell>
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
        <NoteInlineEditor
          merchant={tx.merchant}
          note={tx.note}
          disabled={disabled}
          onCommit={(note) => onPatch({ note })}
        />
      </TableCell>
      <TableCell className="bk-td-category">
        <div className="bk-row-quick-category" data-category={effectiveCategoryCode(tx)}>
          <CategorySelect
            id={`bk-review-${tx.id}-category`}
            value={effectiveCategoryCode(tx)}
            disabled={disabled}
            ariaLabel={`${tx.merchant} 분류 변경`}
            onValueChange={(categoryCode) => void onPatch({ categoryCode, subcategoryCode: "" })}
          />
        </div>
      </TableCell>
      <TableCell className="bk-td-reasons">
        {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
        {visible.map((code) => (
          <Badge key={code} variant="secondary">
            {code}
          </Badge>
        ))}
        {hiddenCount > 0 && <Badge variant="secondary">+{hiddenCount}</Badge>}
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
        <div className="bk-row-actions">
          {showApprove && (
            <Button type="button" size="sm" disabled={disabled} onClick={onApprove}>
              <Check className="size-3.5" />
              확정
            </Button>
          )}
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
