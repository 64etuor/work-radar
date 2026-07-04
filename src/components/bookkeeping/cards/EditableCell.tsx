import { StickyNote } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";

import type { BookkeepingPaymentMethodKind } from "@/bindings";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { shouldCommitNoteDraft } from "../reviewRow";
import { paymentSummary } from "./cardHelpers";
import { PaymentFields } from "./PaymentFields";

/**
 * 원장/검토 큐 테이블의 인라인 셀 편집 프리미티브.
 *
 * 공통 계약(검토 큐 메모 인라인 편집에서 일반화):
 * - 클릭 → 그 자리에서 입력으로 스왑, Enter/blur 저장, Esc 취소(전역 Esc 계약으로 새지 않게 소비).
 * - 변경 없음(trim 비교)은 no-op으로 닫는다.
 * - onCommit은 성공 여부를 돌려준다 — 실패 시 입력을 유지해 draft를 잃지 않는다(토스트는 상위).
 * - Enter 커밋 직후 이어지는 blur의 이중 저장은 committingRef가 막는다.
 */
export function EditableTextCell({
  value,
  display,
  placeholder,
  ariaLabel,
  disabled,
  inputMode,
  align,
  onCommit,
}: {
  /** 편집 시작 시 입력 초기값(표시값과 다를 수 있다 — 금액은 원 단위 숫자). */
  value: string;
  /** 읽기 상태 표시(포맷된 금액 등). 없으면 value. */
  display?: ReactNode;
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  inputMode?: "numeric" | "text";
  align?: "right";
  onCommit: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const committingRef = useRef(false);

  const commit = async () => {
    if (draft == null || committingRef.current) return;
    if (!shouldCommitNoteDraft(value, draft)) {
      setDraft(null);
      return;
    }
    committingRef.current = true;
    try {
      const ok = await onCommit(draft);
      if (ok) setDraft(null);
    } finally {
      committingRef.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
    }
  };

  if (draft != null) {
    return (
      <Input
        className="bk-cell-input"
        data-align={align}
        value={draft}
        autoFocus
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
    );
  }
  return (
    <button
      type="button"
      className="bk-cell-trigger"
      data-align={align}
      data-empty={value.trim() ? undefined : "true"}
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={() => setDraft(value)}
    >
      {display ?? (value.trim() ? value : (placeholder ?? "—"))}
    </button>
  );
}

/**
 * 상호 아래 메모 서브라인 — 검토 큐의 기존 노트 트리거/인라인 입력 패턴을 공용화.
 * 비어 있으면 아이콘만(행 hover 시 노출은 CSS), 클릭으로 인라인 편집.
 */
export function NoteInlineEditor({
  merchant,
  note,
  disabled,
  onCommit,
}: {
  merchant: string;
  note: string | null;
  disabled?: boolean;
  onCommit: (next: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const committingRef = useRef(false);

  const commit = async () => {
    if (draft == null || committingRef.current) return;
    if (!shouldCommitNoteDraft(note, draft)) {
      setDraft(null);
      return;
    }
    committingRef.current = true;
    try {
      const ok = await onCommit(draft);
      if (ok) setDraft(null);
    } finally {
      committingRef.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(null);
    }
  };

  if (draft != null) {
    return (
      <Input
        className="bk-review-note-input"
        value={draft}
        autoFocus
        aria-label={`${merchant} 메모 편집`}
        placeholder="메모"
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
    );
  }
  return (
    <button
      type="button"
      className="bk-review-note-trigger typo-caption-sm"
      data-empty={note ? "false" : "true"}
      disabled={disabled}
      aria-label={note ? `${merchant} 메모 수정` : `${merchant} 메모 추가`}
      title={note ?? "메모 추가"}
      onClick={() => setDraft(note ?? "")}
    >
      <StickyNote className="size-3" />
      {note && <span className="bk-review-note-text">{note}</span>}
    </button>
  );
}

/**
 * 날짜(DatePicker 즉시 커밋) + 시각(스왑 입력) 스택 셀 — 원장/검토 큐 공용.
 */
export function DateTimeCell({
  merchant,
  spentAt,
  spentAtTime,
  disabled,
  onPatch,
}: {
  merchant: string;
  spentAt: string;
  spentAtTime: string | null;
  disabled?: boolean;
  onPatch: (patch: Partial<TransactionEditDraft>) => Promise<boolean>;
}) {
  return (
    <>
      <DatePicker
        value={spentAt}
        onChange={(d) => {
          if (d && d !== spentAt) void onPatch({ spentAt: d });
        }}
        clearable={false}
        ariaLabel={`${merchant} 날짜 변경`}
        className="bk-cell-picker"
      />
      <EditableTextCell
        value={spentAtTime ?? ""}
        placeholder="시각"
        ariaLabel={`${merchant} 시각 변경`}
        disabled={disabled}
        onCommit={(next) => onPatch({ spentAtTime: next })}
      />
    </>
  );
}

export type PaymentCellDraft = {
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
};

/**
 * 결제수단 셀 — 3필드(종류/표시명/끝자리)라 스왑 대신 Popover 미니 폼.
 * "적용"으로만 커밋(팝오버 닫힘=취소, Esc는 radix가 처리). 실패 시 팝오버 유지.
 */
export function PaymentCellEditor({
  id,
  kind,
  label,
  last4,
  disabled,
  ariaLabel,
  onCommit,
}: {
  id: string;
  kind: BookkeepingPaymentMethodKind;
  label: string | null;
  last4: string | null;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (next: PaymentCellDraft) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PaymentCellDraft>({
    paymentMethodKind: kind,
    paymentMethodLabel: label ?? "",
    paymentMethodLast4: last4 ?? "",
  });
  const [saving, setSaving] = useState(false);

  const openWithFresh = (next: boolean) => {
    if (next) {
      // 열 때마다 현재 tx 값으로 초기화 — 닫힘=취소 계약.
      setDraft({
        paymentMethodKind: kind,
        paymentMethodLabel: label ?? "",
        paymentMethodLast4: last4 ?? "",
      });
    }
    setOpen(next);
  };

  const apply = async () => {
    setSaving(true);
    try {
      const ok = await onCommit(draft);
      if (ok) setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={openWithFresh}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="bk-cell-trigger"
          disabled={disabled}
          aria-label={ariaLabel}
        >
          {paymentSummary(kind, label, last4)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="bk-payment-popover" align="start">
        <PaymentFields
          kindId={`${id}-kind`}
          labelId={`${id}-label`}
          last4Id={`${id}-last4`}
          kind={draft.paymentMethodKind}
          label={draft.paymentMethodLabel}
          last4={draft.paymentMethodLast4}
          onKindChange={(paymentMethodKind) =>
            setDraft((current) => ({ ...current, paymentMethodKind }))
          }
          onLabelChange={(paymentMethodLabel) =>
            setDraft((current) => ({ ...current, paymentMethodLabel }))
          }
          onLast4Change={(paymentMethodLast4) =>
            setDraft((current) => ({ ...current, paymentMethodLast4 }))
          }
        />
        <div className="bk-payment-popover-actions">
          <Button
            type="button"
            size="sm"
            disabled={disabled || saving}
            onClick={() => void apply()}
          >
            적용
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
            취소
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
