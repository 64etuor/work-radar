import { Check, Target } from "lucide-react";
import { type Dispatch, type FormEvent, type SetStateAction } from "react";

import type { BookkeepingBudgetStatus } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";

import { Field } from "../../settings/SettingsKit";
import { FIELD_IDS } from "../bookkeepingConstants";
import type { BudgetDraft } from "../bookkeepingDrafts";
import { currency } from "../bookkeepingFormat";
import { budgetBarPercent, isBudgetOverrun } from "../budgets";
import { EmptyState } from "./_shared";
import { CategorySelect } from "./CategorySelect";

export function BudgetCard({
  draft,
  statuses,
  pending,
  onDraftChange,
  onSubmit,
}: {
  draft: BudgetDraft;
  statuses: BookkeepingBudgetStatus[];
  pending: boolean;
  onDraftChange: Dispatch<SetStateAction<BudgetDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <Target className="size-4" />
          예산
        </CardTitle>
        <CardDescription className="bk-card-desc">월별 카테고리 한도</CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        <form className="bk-form bk-budget-form" onSubmit={onSubmit}>
          <Field htmlFor={FIELD_IDS.budgetCategory} label="카테고리">
            <CategorySelect
              id={FIELD_IDS.budgetCategory}
              value={draft.category}
              onValueChange={(category) => onDraftChange((d) => ({ ...d, category }))}
            />
          </Field>
          <Field htmlFor={FIELD_IDS.budgetAmount} label="한도">
            <Input
              id={FIELD_IDS.budgetAmount}
              inputMode="numeric"
              value={draft.amount}
              onChange={(event) => onDraftChange((d) => ({ ...d, amount: event.target.value }))}
              placeholder="500000"
            />
          </Field>
          <label className="bk-checkbox-row" htmlFor={FIELD_IDS.budgetRollover}>
            <Checkbox
              id={FIELD_IDS.budgetRollover}
              checked={draft.rollover}
              onCheckedChange={(checked) =>
                onDraftChange((d) => ({ ...d, rollover: checked === true }))
              }
            />
            <span className="typo-body-md">전월 잔액 이월</span>
          </label>
          <Field htmlFor={FIELD_IDS.budgetNote} label="메모">
            <Input
              id={FIELD_IDS.budgetNote}
              value={draft.note}
              onChange={(event) => onDraftChange((d) => ({ ...d, note: event.target.value }))}
              placeholder="선택"
            />
          </Field>
          <Button type="submit" disabled={pending}>
            <Check className="size-4" />
            저장
          </Button>
        </form>

        <div className="bk-budget-list">
          {statuses.length === 0 && <EmptyState>예산 없음</EmptyState>}
          {statuses.map((status) => {
            const overrun = isBudgetOverrun(status.remainingMinor);
            const percent = budgetBarPercent(status.pct ?? 0);
            return (
              <button
                key={status.categoryCode}
                type="button"
                className="bk-budget-row"
                data-overrun={overrun ? "true" : "false"}
                onClick={() =>
                  onDraftChange({
                    category: status.categoryCode,
                    amount: String(status.limitMinor),
                    rollover: status.rollover,
                    note: "",
                  })
                }
              >
                <span className="bk-budget-row-head">
                  <strong className="typo-body-strong">{status.label}</strong>
                  <span className="typo-caption-sm text-muted-foreground">
                    {currency.format(status.spentMinor)} / {currency.format(status.limitMinor)}
                  </span>
                </span>
                <span className="bk-budget-track" aria-hidden="true">
                  <span className="bk-budget-fill" style={{ width: `${percent}%` }} />
                </span>
                <span className="bk-budget-row-foot typo-caption-sm">
                  <span>
                    {overrun ? "초과" : "잔여"} {currency.format(status.remainingMinor)}
                  </span>
                  {status.rolloverInMinor > 0 && (
                    <span>이월 {currency.format(status.rolloverInMinor)}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
