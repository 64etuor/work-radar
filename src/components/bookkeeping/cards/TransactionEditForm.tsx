import { Check, ChevronRight, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";

import type { BookkeepingExpenseKind, BookkeepingTransaction } from "@/bindings";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import { Field } from "../../settings/SettingsKit";
import { EXPENSE_KIND_OPTIONS } from "../bookkeepingConstants";
import { editDraftFromTransaction, type TransactionEditDraft } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { sourceLabel } from "../bookkeepingLabels";
import { DuplicateCandidates } from "./DuplicateCandidates";
import { LineItemEditor } from "./LineItemEditor";
import { PaymentFields } from "./PaymentFields";
import { TaxonomyEditFields } from "./TaxonomyEditFields";
import { TransactionMetadata } from "./TransactionMetadata";

/**
 * 거래 편집 폼 — 필드를 목적별 섹션(기본/분류/결제/상세/분할·중복)으로 묶는다.
 * 상세 섹션은 기본 접힘(로컬 상태, 기억 없음) — draft는 부모 state에 있으므로
 * 접었다 펴도 입력값이 보존된다. 저장 계약(onSave(draft))은 바꾸지 않는다.
 */
export function TransactionEditForm({
  tx,
  disabled,
  approveLabel,
  embedded = false,
  onApprove,
  onDelete,
  onSave,
  onCancel,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  approveLabel?: string;
  /** true면 Sheet 안에 심긴 폼 — 행 chrome(article 래퍼·상호/금액 헤드)은 Sheet 헤더가 담당. */
  embedded?: boolean;
  onApprove?: () => void;
  onDelete: () => void;
  onSave: (draft: TransactionEditDraft) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(() => editDraftFromTransaction(tx));
  const [detailsOpen, setDetailsOpen] = useState(false);
  const fieldPrefix = `bk-edit-${tx.id}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(draft);
  };

  const form = (
    <form className="bk-edit-form" onSubmit={submit}>
      {!embedded && (
        <div className="bk-edit-head">
          <div className="bk-row-title">
            <strong className="typo-body-strong">{tx.merchant}</strong>
            <span className="text-muted-foreground typo-caption-sm">
              {tx.source !== "manual" && tx.sourceRef
                ? `${sourceLabel(tx.source)} · ${tx.sourceRef}`
                : sourceLabel(tx.source)}
            </span>
          </div>
          <div className="bk-row-amount typo-title-sm">{currency.format(tx.amountMinor)}</div>
        </div>
      )}

      <section className="bk-edit-section">
        <h4 className="bk-edit-section-label typo-label-sm">기본</h4>
        <div className="bk-edit-grid">
          <Field label="날짜" htmlFor={`${fieldPrefix}-spent-at`}>
            <DatePicker
              id={`${fieldPrefix}-spent-at`}
              value={draft.spentAt || null}
              onChange={(d) => setDraft((current) => ({ ...current, spentAt: d ?? "" }))}
              clearable={false}
              ariaLabel="날짜"
              className="w-full"
            />
          </Field>
          <Field label="시각" htmlFor={`${fieldPrefix}-spent-time`}>
            <Input
              id={`${fieldPrefix}-spent-time`}
              value={draft.spentAtTime}
              onChange={(e) => setDraft((current) => ({ ...current, spentAtTime: e.target.value }))}
              placeholder="HH:MM:SS"
            />
          </Field>
          <Field label="가맹점" htmlFor={`${fieldPrefix}-merchant`}>
            <Input
              id={`${fieldPrefix}-merchant`}
              value={draft.merchant}
              onChange={(e) => setDraft((current) => ({ ...current, merchant: e.target.value }))}
              required
            />
          </Field>
          <div className="bk-form-grid">
            <Field label="금액" htmlFor={`${fieldPrefix}-amount`}>
              <Input
                id={`${fieldPrefix}-amount`}
                value={draft.amount}
                onChange={(e) => setDraft((current) => ({ ...current, amount: e.target.value }))}
                inputMode="numeric"
                required
              />
            </Field>
            <Field label="통화" htmlFor={`${fieldPrefix}-currency`}>
              <Input
                id={`${fieldPrefix}-currency`}
                value={draft.currency}
                onChange={(e) =>
                  setDraft((current) => ({ ...current, currency: e.target.value.toUpperCase() }))
                }
                maxLength={3}
                required
              />
            </Field>
          </div>
          <Field label="수입/지출" htmlFor={`${fieldPrefix}-direction`}>
            <div id={`${fieldPrefix}-direction`} className="bk-segmented" role="group">
              <Button
                type="button"
                size="sm"
                variant={draft.direction === "expense" ? "default" : "outline"}
                aria-pressed={draft.direction === "expense"}
                onClick={() => setDraft((current) => ({ ...current, direction: "expense" }))}
              >
                지출
              </Button>
              <Button
                type="button"
                size="sm"
                variant={draft.direction === "income" ? "default" : "outline"}
                aria-pressed={draft.direction === "income"}
                onClick={() => setDraft((current) => ({ ...current, direction: "income" }))}
              >
                수입
              </Button>
            </div>
          </Field>
        </div>
      </section>

      <section className="bk-edit-section">
        <h4 className="bk-edit-section-label typo-label-sm">분류</h4>
        <TaxonomyEditFields
          prefix={fieldPrefix}
          categoryCode={draft.categoryCode}
          subcategoryCode={draft.subcategoryCode}
          onCategoryChange={(categoryCode) =>
            setDraft((current) => ({ ...current, categoryCode, subcategoryCode: "" }))
          }
          onSubcategoryChange={(subcategoryCode) =>
            setDraft((current) => ({ ...current, subcategoryCode }))
          }
        />
        {/* DB `note` — 원장/검토 테이블의 "내용" 칼럼과 같은 필드(라벨 통일). */}
        <Field label="내용" htmlFor={`${fieldPrefix}-note`}>
          <Textarea
            id={`${fieldPrefix}-note`}
            value={draft.note}
            onChange={(e) => setDraft((current) => ({ ...current, note: e.target.value }))}
            rows={2}
          />
        </Field>
      </section>

      <section className="bk-edit-section">
        <h4 className="bk-edit-section-label typo-label-sm">결제</h4>
        <PaymentFields
          kindId={`${fieldPrefix}-payment-kind`}
          labelId={`${fieldPrefix}-payment-label`}
          last4Id={`${fieldPrefix}-payment-last4`}
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
        <Field label="자산" htmlFor={`${fieldPrefix}-account`}>
          <Input
            id={`${fieldPrefix}-account`}
            value={draft.account}
            onChange={(e) => setDraft((current) => ({ ...current, account: e.target.value }))}
          />
        </Field>
      </section>

      <section className="bk-edit-section">
        <button
          type="button"
          className="bk-edit-section-toggle typo-label-sm"
          aria-expanded={detailsOpen}
          aria-controls={`${fieldPrefix}-details`}
          onClick={() => setDetailsOpen((value) => !value)}
        >
          <ChevronRight className="bk-edit-toggle-chevron size-3.5" />
          상세
        </button>
        {detailsOpen && (
          <div id={`${fieldPrefix}-details`} className="bk-edit-details">
            <div className="bk-edit-grid">
              <Field label="비용유형" htmlFor={`${fieldPrefix}-expense-kind`}>
                <Select
                  value={draft.expenseKind}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      expenseKind: value as BookkeepingExpenseKind,
                    }))
                  }
                >
                  <SelectTrigger id={`${fieldPrefix}-expense-kind`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPENSE_KIND_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="bk-form-grid">
                <Field label="주문번호" htmlFor={`${fieldPrefix}-order-no`}>
                  <Input
                    id={`${fieldPrefix}-order-no`}
                    value={draft.orderNo}
                    onChange={(e) =>
                      setDraft((current) => ({ ...current, orderNo: e.target.value }))
                    }
                  />
                </Field>
                <Field label="결제번호" htmlFor={`${fieldPrefix}-payment-no`}>
                  <Input
                    id={`${fieldPrefix}-payment-no`}
                    value={draft.paymentNo}
                    onChange={(e) =>
                      setDraft((current) => ({ ...current, paymentNo: e.target.value }))
                    }
                  />
                </Field>
              </div>
              <div className="bk-edit-span-2">
                {/* DB `description` — 소스(메일/임포트) 원본 설명. 사용자 "내용"(note)과 별개. */}
                <Field label="원본 설명" htmlFor={`${fieldPrefix}-description`}>
                  <Textarea
                    id={`${fieldPrefix}-description`}
                    value={draft.description}
                    onChange={(e) =>
                      setDraft((current) => ({ ...current, description: e.target.value }))
                    }
                    rows={2}
                  />
                </Field>
              </div>
            </div>
            <TransactionMetadata tx={tx} compact />
          </div>
        )}
      </section>

      <section className="bk-edit-section">
        <h4 className="bk-edit-section-label typo-label-sm">분할 · 중복</h4>
        <LineItemEditor transactionId={tx.id} amountMinor={tx.amountMinor} disabled={disabled} />
        <DuplicateCandidates tx={tx} disabled={disabled} />
      </section>

      <div className="bk-edit-footer">
        <Button type="submit" size="sm" disabled={disabled}>
          저장
        </Button>
        {onApprove && (
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onApprove}>
            <Check className="size-3.5" />
            {approveLabel ?? "확정"}
          </Button>
        )}
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
            {embedded ? "닫기" : "접기"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="bk-edit-footer-danger text-destructive"
          disabled={disabled}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
          삭제
        </Button>
      </div>
    </form>
  );

  if (embedded) return form;
  return (
    <article className="bk-row bk-transaction bk-transaction-edit" data-status={tx.reviewStatus}>
      {form}
    </article>
  );
}
