import { Check, Landmark } from "lucide-react";
import { type Dispatch, type FormEvent, type SetStateAction } from "react";

import type { BookkeepingReconcileAccountResult } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";

import { Field } from "../../settings/SettingsKit";
import { FIELD_IDS } from "../bookkeepingConstants";
import type { ReconciliationDraft } from "../bookkeepingDrafts";
import { formatCurrencyMinor } from "../bookkeepingFormat";
import { reconciliationTone, signedMinorLabel } from "../reconciliation";

export function ReconciliationCard({
  draft,
  defaultCurrency,
  pending,
  result,
  onDraftChange,
  onSubmit,
}: {
  draft: ReconciliationDraft;
  /** 통화 미입력 시 적용되는 앱 기본 통화(표시/포맷 폴백). */
  defaultCurrency: string;
  pending: boolean;
  result: BookkeepingReconcileAccountResult | null;
  onDraftChange: Dispatch<SetStateAction<ReconciliationDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const tone = result ? reconciliationTone(result.differenceMinor) : null;
  const effectiveCurrency = draft.currency || defaultCurrency;
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <Landmark className="size-4" />
          정산
        </CardTitle>
        <CardDescription className="bk-card-desc">명세서 잔액 대조</CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        <form className="bk-form bk-reconcile-form" onSubmit={onSubmit}>
          <Field htmlFor={FIELD_IDS.reconcileAccount} label="자산">
            <Input
              id={FIELD_IDS.reconcileAccount}
              value={draft.account}
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, account: event.target.value }))
              }
              placeholder="Checking"
            />
          </Field>
          <div className="bk-form-grid">
            <Field htmlFor={FIELD_IDS.reconcileDate} label="명세서일">
              <DatePicker
                id={FIELD_IDS.reconcileDate}
                value={draft.statementDate || null}
                onChange={(d) =>
                  onDraftChange((current) => ({
                    ...current,
                    statementDate: d ?? "",
                  }))
                }
                ariaLabel="명세서일"
                className="w-full"
              />
            </Field>
            <Field htmlFor={FIELD_IDS.reconcileCurrency} label="통화">
              <Input
                id={FIELD_IDS.reconcileCurrency}
                value={draft.currency}
                maxLength={3}
                placeholder={defaultCurrency}
                onChange={(event) =>
                  onDraftChange((current) => ({
                    ...current,
                    currency: event.target.value.toUpperCase(),
                  }))
                }
              />
            </Field>
          </div>
          <Field htmlFor={FIELD_IDS.reconcileBalance} label="명세서 잔액">
            <Input
              id={FIELD_IDS.reconcileBalance}
              inputMode="numeric"
              value={draft.statementBalance}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  statementBalance: event.target.value,
                }))
              }
              placeholder="75000"
            />
          </Field>
          <Field htmlFor={FIELD_IDS.reconcileNote} label="메모">
            <Input
              id={FIELD_IDS.reconcileNote}
              value={draft.note}
              onChange={(event) =>
                onDraftChange((current) => ({ ...current, note: event.target.value }))
              }
              placeholder="선택"
            />
          </Field>
          <Button type="submit" disabled={pending}>
            <Check className="size-4" />
            대조
          </Button>
        </form>

        {result && (
          <div className="bk-reconcile-result" data-tone={tone ?? "matched"}>
            <span className="typo-body-strong">
              {result.matched ? "일치" : "불일치"} · {signedMinorLabel(result.differenceMinor)}
            </span>
            <span className="typo-caption-sm">
              장부 {formatCurrencyMinor(result.computedBalanceMinor, effectiveCurrency)} / 명세서{" "}
              {formatCurrencyMinor(result.statementBalanceMinor, effectiveCurrency)}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
