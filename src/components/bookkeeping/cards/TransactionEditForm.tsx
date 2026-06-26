import { Check, Trash2 } from "lucide-react";
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

export function TransactionEditForm({
  tx,
  disabled,
  approveLabel,
  onApprove,
  onDelete,
  onSave,
  onCancel,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  approveLabel?: string;
  onApprove?: () => void;
  onDelete: () => void;
  onSave: (draft: TransactionEditDraft) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(() => editDraftFromTransaction(tx));
  const fieldPrefix = `bk-edit-${tx.id}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(draft);
  };

  return (
    <article className="bk-row bk-transaction bk-transaction-edit" data-status={tx.reviewStatus}>
      <form className="bk-edit-form" onSubmit={submit}>
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

        <div className="bk-edit-grid">
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
          <div className="bk-form-grid">
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
                onChange={(e) =>
                  setDraft((current) => ({ ...current, spentAtTime: e.target.value }))
                }
                placeholder="HH:MM:SS"
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
          <Field label="메모" htmlFor={`${fieldPrefix}-note`}>
            <Textarea
              id={`${fieldPrefix}-note`}
              value={draft.note}
              onChange={(e) => setDraft((current) => ({ ...current, note: e.target.value }))}
              rows={2}
            />
          </Field>
          <Field label="내용/설명" htmlFor={`${fieldPrefix}-description`}>
            <Textarea
              id={`${fieldPrefix}-description`}
              value={draft.description}
              onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))}
              rows={2}
            />
          </Field>
          <Field label="자산" htmlFor={`${fieldPrefix}-account`}>
            <Input
              id={`${fieldPrefix}-account`}
              value={draft.account}
              onChange={(e) => setDraft((current) => ({ ...current, account: e.target.value }))}
            />
          </Field>
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
                onChange={(e) => setDraft((current) => ({ ...current, orderNo: e.target.value }))}
              />
            </Field>
            <Field label="결제번호" htmlFor={`${fieldPrefix}-payment-no`}>
              <Input
                id={`${fieldPrefix}-payment-no`}
                value={draft.paymentNo}
                onChange={(e) => setDraft((current) => ({ ...current, paymentNo: e.target.value }))}
              />
            </Field>
          </div>
        </div>

        <LineItemEditor transactionId={tx.id} amountMinor={tx.amountMinor} disabled={disabled} />

        <TransactionMetadata tx={tx} />

        <DuplicateCandidates tx={tx} disabled={disabled} />

        <div className="bk-row-actions">
          <Button type="submit" size="sm" disabled={disabled}>
            저장
          </Button>
          {onApprove && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onApprove}
            >
              <Check className="size-3.5" />
              {approveLabel ?? "확정"}
            </Button>
          )}
          {onCancel && (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
              접기
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
            <Trash2 className="size-3.5" />
            삭제
          </Button>
        </div>
      </form>
    </article>
  );
}
