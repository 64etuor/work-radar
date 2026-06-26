import { Landmark, Plus } from "lucide-react";
import { type Dispatch, type FormEvent, type SetStateAction } from "react";

import type { BookkeepingExpenseKind } from "@/bindings";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
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
import { FIELD_IDS, RECURRING_EXPENSE_KIND_OPTIONS } from "../bookkeepingConstants";
import type { RecurringDraft } from "../bookkeepingDrafts";
import { currentMonth } from "../bookkeepingMonth";
import { CategorySelect } from "./CategorySelect";
import { CollapsibleInputCard } from "./CollapsibleInputCard";
import { PaymentFields } from "./PaymentFields";

export function RecurringExpenseFormCard({
  draft,
  open,
  pending,
  onDraftChange,
  onOpenChange,
  onSubmit,
}: {
  draft: RecurringDraft;
  open: boolean;
  pending: boolean;
  onDraftChange: Dispatch<SetStateAction<RecurringDraft>>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <CollapsibleInputCard
      title="고정비 입력"
      description="월세, 보험료, 구독처럼 메일에서 안 잡히는 지출입니다."
      icon={<Landmark className="size-4" />}
      open={open}
      contentId={FIELD_IDS.recurringPanel}
      onOpenChange={onOpenChange}
    >
      <CardContent>
        <form className="bk-form" onSubmit={onSubmit}>
          <Field label="이름" htmlFor={FIELD_IDS.recurringName}>
            <Input
              id={FIELD_IDS.recurringName}
              value={draft.name}
              onChange={(e) => onDraftChange((current) => ({ ...current, name: e.target.value }))}
              required
            />
          </Field>
          <Field label="가맹점/상대" htmlFor={FIELD_IDS.recurringMerchant}>
            <Input
              id={FIELD_IDS.recurringMerchant}
              value={draft.merchant}
              onChange={(e) =>
                onDraftChange((current) => ({ ...current, merchant: e.target.value }))
              }
            />
          </Field>
          <div className="bk-form-grid">
            <Field label="금액" htmlFor={FIELD_IDS.recurringAmount}>
              <Input
                id={FIELD_IDS.recurringAmount}
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
            <Field label="결제일" htmlFor={FIELD_IDS.recurringDay}>
              <Input
                id={FIELD_IDS.recurringDay}
                type="number"
                min="1"
                max="31"
                inputMode="numeric"
                value={draft.scheduleDay}
                onChange={(e) =>
                  onDraftChange((current) => ({ ...current, scheduleDay: e.target.value }))
                }
                required
              />
            </Field>
          </div>
          <div className="bk-form-grid">
            <Field label="시작 월" htmlFor={FIELD_IDS.recurringStart}>
              <Input
                id={FIELD_IDS.recurringStart}
                type="month"
                value={draft.startMonth}
                onChange={(e) =>
                  onDraftChange((current) => ({
                    ...current,
                    startMonth: e.target.value || currentMonth(),
                  }))
                }
              />
            </Field>
            <Field label="종류" htmlFor={FIELD_IDS.recurringExpenseKind}>
              <Select
                value={draft.expenseKind}
                onValueChange={(value) =>
                  onDraftChange((current) => ({
                    ...current,
                    expenseKind: value as BookkeepingExpenseKind,
                  }))
                }
              >
                <SelectTrigger id={FIELD_IDS.recurringExpenseKind}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRING_EXPENSE_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="카테고리" htmlFor={FIELD_IDS.recurringCategory}>
            <CategorySelect
              id={FIELD_IDS.recurringCategory}
              value={draft.category}
              onValueChange={(category) => onDraftChange((current) => ({ ...current, category }))}
            />
          </Field>
          <PaymentFields
            kindId={FIELD_IDS.recurringPaymentKind}
            labelId={FIELD_IDS.recurringPaymentLabel}
            last4Id={FIELD_IDS.recurringPaymentLast4}
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
          <Field label="메모" htmlFor={FIELD_IDS.recurringNote}>
            <Textarea
              id={FIELD_IDS.recurringNote}
              value={draft.note}
              onChange={(e) => onDraftChange((current) => ({ ...current, note: e.target.value }))}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" />
            고정비 추가
          </Button>
        </form>
      </CardContent>
    </CollapsibleInputCard>
  );
}
