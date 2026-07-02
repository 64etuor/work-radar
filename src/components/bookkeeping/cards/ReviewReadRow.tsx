import { Check, Pencil, StickyNote, Trash2 } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useRef, useState } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { currency } from "../bookkeepingFormat";
import { reviewReasonCodes } from "../bookkeepingLabels";
import { categoryPathLabel, shouldCommitNoteDraft, truncateReviewChips } from "../reviewRow";
import { isInteractiveTarget } from "../rowActivation";

/**
 * 검토 큐의 한 줄 read-row — TransactionReadRow(승인 목록)와 같은 시각 문법이되,
 * 96행이 칼럼-대-칼럼으로 정렬되도록 공유 grid 템플릿(--bk-review-read-grid,
 * 리스트 컨테이너에 선언)을 쓴다. 편집은 행 클릭/편집 버튼으로 열고(상위가 관리),
 * 삭제(및 의심 행의 확정)는 펼치지 않고 바로 실행한다. 메모는 행 안에서
 * 인라인 편집한다(Enter/blur 저장, Esc 취소) — 전체 폼을 열 필요가 없다.
 */
export function ReviewReadRow({
  tx,
  disabled,
  showApprove,
  onApprove,
  onEdit,
  onDelete,
  onSaveNote,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  /** 의심 그룹만 개별 확정 버튼을 노출한다 — 정상 그룹은 그룹 헤더 일괄 확정. */
  showApprove: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** 메모만 바꾼 저장 — 성공 시 true. 실패 시 인라인 입력을 유지한다. */
  onSaveNote: (note: string) => Promise<boolean>;
}) {
  const { visible, hiddenCount } = truncateReviewChips(reviewReasonCodes(tx.reviewReasonsJson));
  // null = 메모 편집 중 아님. 문자열 = 편집 중 draft.
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  // Enter 커밋 후 이어지는 blur가 이중 저장하지 않도록 하는 가드.
  const committingRef = useRef(false);
  // 행 클릭 = 편집 열기 (TransactionReadRow와 동일 규약). 키보드/AT 경로는 눈에
  // 보이는 "편집" 버튼이 담당 — 행 자체에 tabIndex/role을 얹지 않는다.
  // 메모 트리거(button)/인라인 Input은 isInteractiveTarget이 걸러 행 확장을 막는다.
  const activateFromClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled || isInteractiveTarget(event.target)) return;
    onEdit();
  };

  const commitNote = async () => {
    if (noteDraft == null || committingRef.current) return;
    if (!shouldCommitNoteDraft(tx.note, noteDraft)) {
      setNoteDraft(null);
      return;
    }
    committingRef.current = true;
    try {
      const ok = await onSaveNote(noteDraft);
      // 실패 시 입력을 유지해 draft를 잃지 않는다(토스트는 상위 핸들러가 띄운다).
      if (ok) setNoteDraft(null);
    } finally {
      committingRef.current = false;
    }
  };

  const onNoteKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitNote();
    } else if (event.key === "Escape") {
      // 창 hide 등 전역 Esc 계약으로 새지 않게 여기서 소비한다.
      event.preventDefault();
      event.stopPropagation();
      setNoteDraft(null);
    }
  };

  return (
    <article
      className="bk-review-read bk-row-editable"
      data-status={tx.reviewStatus}
      onClick={activateFromClick}
    >
      <span className="bk-review-read-date typo-caption-sm">
        {tx.spentAt}
        {tx.spentAtTime && <span className="bk-review-read-time">{tx.spentAtTime}</span>}
      </span>
      <span className="bk-review-read-main">
        <strong className="bk-review-read-merchant typo-body-strong" title={tx.merchant}>
          {tx.merchant}
        </strong>
        {noteDraft != null ? (
          <Input
            className="bk-review-note-input"
            value={noteDraft}
            autoFocus
            aria-label={`${tx.merchant} 메모 편집`}
            placeholder="메모"
            disabled={disabled}
            onChange={(event) => setNoteDraft(event.target.value)}
            onKeyDown={onNoteKeyDown}
            onBlur={() => void commitNote()}
          />
        ) : (
          <button
            type="button"
            className="bk-review-note-trigger typo-caption-sm"
            data-empty={tx.note ? "false" : "true"}
            disabled={disabled}
            aria-label={tx.note ? `${tx.merchant} 메모 수정` : `${tx.merchant} 메모 추가`}
            title={tx.note ?? "메모 추가"}
            onClick={() => setNoteDraft(tx.note ?? "")}
          >
            <StickyNote className="size-3" />
            {tx.note && <span className="bk-review-note-text">{tx.note}</span>}
          </button>
        )}
      </span>
      <span className="bk-review-read-category">
        <Badge variant="outline" title={categoryPathLabel(tx.category, tx.subcategory)}>
          {categoryPathLabel(tx.category, tx.subcategory)}
        </Badge>
      </span>
      <span className="bk-review-read-reasons">
        {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
        {visible.map((code) => (
          <Badge key={code} variant="secondary">
            {code}
          </Badge>
        ))}
        {hiddenCount > 0 && <Badge variant="secondary">+{hiddenCount}</Badge>}
      </span>
      <span
        className="bk-review-read-amount typo-title-sm"
        data-direction={tx.direction}
        title={tx.currency !== "KRW" ? tx.currency : undefined}
      >
        {currency.format(tx.amountMinor)}
      </span>
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
