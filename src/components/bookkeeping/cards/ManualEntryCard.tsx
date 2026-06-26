import { Plus, WalletCards } from "lucide-react";
import { type Dispatch, type FormEvent, type SetStateAction } from "react";

import type { BookkeepingExpenseKind } from "@/bindings";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
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
import { EXPENSE_KIND_OPTIONS, FIELD_IDS } from "../bookkeepingConstants";
import type { ManualDraft } from "../bookkeepingDrafts";
import { CategorySelect } from "./CategorySelect";
import { CollapsibleInputCard } from "./CollapsibleInputCard";
import { PaymentFields } from "./PaymentFields";

export function ManualEntryCard({
  draft,
  open,
  pending,
  onDraftChange,
  onOpenChange,
  onSubmit,
}: {
  draft: ManualDraft;
  open: boolean;
  pending: boolean;
  onDraftChange: Dispatch<SetStateAction<ManualDraft>>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <CollapsibleInputCard
      title="수동 입력"
      icon={<WalletCards className="size-4" />}
      open={open}
      contentId={FIELD_IDS.manualPanel}
      onOpenChange={onOpenChange}
    >
      <CardContent>
        <form className="bk-form" onSubmit={onSubmit}>
          <Field label="상점" htmlFor={FIELD_IDS.merchant}>
            <Input
              id={FIELD_IDS.merchant}
              value={draft.merchant}
              onChange={(e) =>
                onDraftChange((current) => ({ ...current, merchant: e.target.value }))
              }
              required
            />
          </Field>
          <div className="bk-form-grid">
            <Field label="금액" htmlFor={FIELD_IDS.amount}>
              <Input
                id={FIELD_IDS.amount}
                type="number"
                min="1"
                inputMode="numeric"
                value={draft.amount}
                onChange={(e) =>
                  onDraftChange((current) => ({ ...current, amount: e.target.value }))
                }
                required
              />
            </Field>
            <Field label="날짜" htmlFor={FIELD_IDS.spentAt}>
              <DatePicker
                id={FIELD_IDS.spentAt}
                value={draft.spentAt || null}
                onChange={(d) => onDraftChange((current) => ({ ...current, spentAt: d ?? "" }))}
                clearable={false}
                ariaLabel="날짜"
                className="w-full"
              />
            </Field>
          </div>
          <div className="bk-form-grid">
            <Field label="카테고리" htmlFor={FIELD_IDS.category}>
              <CategorySelect
                id={FIELD_IDS.category}
                value={draft.category}
                onValueChange={(category) => onDraftChange((current) => ({ ...current, category }))}
              />
            </Field>
            <Field label="종류" htmlFor={FIELD_IDS.expenseKind}>
              <Select
                value={draft.expenseKind}
                onValueChange={(value) =>
                  onDraftChange((current) => ({
                    ...current,
                    expenseKind: value as BookkeepingExpenseKind,
                  }))
                }
              >
                <SelectTrigger id={FIELD_IDS.expenseKind}>
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
          </div>
          <PaymentFields
            kindId={FIELD_IDS.paymentKind}
            labelId={FIELD_IDS.paymentLabel}
            last4Id={FIELD_IDS.paymentLast4}
            kind={draft.paymentMethodKind}
            label={draft.paymentMethodLabel}
            last4={draft.paymentMethodLast4}
            onKindChange={(paymentMethodKind) =>
              onDraftChange((current) => ({ ...current, paymentMethodKind }))
            }
            onLabelChange={(paymentMethodLabel) =>
              onDraftChange((current) => ({ ...current, paymentMethodLabel }))
            }
            onLast4Change={(paymentMethodLast4) =>
              onDraftChange((current) => ({ ...current, paymentMethodLast4 }))
            }
          />
          <Field label="메모" htmlFor={FIELD_IDS.note}>
            <Textarea
              id={FIELD_IDS.note}
              value={draft.note}
              onChange={(e) => onDraftChange((current) => ({ ...current, note: e.target.value }))}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" />
            거래 추가
          </Button>
        </form>
      </CardContent>
    </CollapsibleInputCard>
  );
}
