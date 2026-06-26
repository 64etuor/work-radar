import { Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import type { BookkeepingLineItem } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSetBookkeepingLineItems } from "@/lib/query";

import { Field, SectionLabel } from "../../settings/SettingsKit";
import { pushMutationError } from "../bookkeepingFieldUtils";
import { currency } from "../bookkeepingFormat";
import {
  blankLineItemDraft,
  type LineItemDraft,
  lineItemDraftsFromServer,
  lineItemSumState,
  toLineItemInputs,
} from "../lineItems";

export function LineItemEditorForm({
  transactionId,
  amountMinor,
  initialItems,
  disabled,
}: {
  transactionId: string;
  amountMinor: number;
  initialItems: BookkeepingLineItem[];
  disabled: boolean;
}) {
  const [drafts, setDrafts] = useState<LineItemDraft[]>(() =>
    lineItemDraftsFromServer(initialItems),
  );
  const seqRef = useRef(0);
  const setItems = useSetBookkeepingLineItems();
  const sum = lineItemSumState(drafts, amountMinor);
  const prefix = `bk-line-${transactionId}`;
  const busy = disabled || setItems.isPending;

  const patch = (key: string, next: Partial<LineItemDraft>) =>
    setDrafts((current) => current.map((row) => (row.key === key ? { ...row, ...next } : row)));
  const addRow = () => {
    seqRef.current += 1;
    setDrafts((current) => [...current, blankLineItemDraft(seqRef.current)]);
  };
  const removeRow = (key: string) =>
    setDrafts((current) => current.filter((row) => row.key !== key));
  const save = () =>
    setItems.mutate(
      { transactionId, items: toLineItemInputs(drafts) },
      { onError: (error) => pushMutationError("bookkeeping.lineItems", error) },
    );

  return (
    <section className="bk-line-items" aria-label="거래 분할">
      <div className="bk-line-items-head">
        <SectionLabel>분할 항목</SectionLabel>
        {sum.hasItems && (
          <span
            className={`typo-caption-sm ${sum.matches ? "text-muted-foreground" : "text-destructive"}`}
          >
            합계 {currency.format(sum.sum)} / 거래 {currency.format(amountMinor)}
            {!sum.matches && ` · 차이 ${currency.format(sum.diff)}`}
          </span>
        )}
      </div>
      {drafts.length === 0 ? (
        <p className="text-muted-foreground typo-caption-sm">분할 항목 없음</p>
      ) : (
        <ul className="bk-line-items-list">
          {drafts.map((row, index) => (
            <li key={row.key} className="bk-line-item-row">
              <Field label="이름" htmlFor={`${prefix}-${row.key}-name`}>
                <Input
                  id={`${prefix}-${row.key}-name`}
                  value={row.name}
                  onChange={(e) => patch(row.key, { name: e.target.value })}
                />
              </Field>
              <Field label="단가" htmlFor={`${prefix}-${row.key}-amount`}>
                <Input
                  id={`${prefix}-${row.key}-amount`}
                  value={row.amount}
                  inputMode="numeric"
                  onChange={(e) => patch(row.key, { amount: e.target.value })}
                />
              </Field>
              <Field label="수량" htmlFor={`${prefix}-${row.key}-qty`}>
                <Input
                  id={`${prefix}-${row.key}-qty`}
                  value={row.quantity}
                  inputMode="numeric"
                  onChange={(e) => patch(row.key, { quantity: e.target.value })}
                />
              </Field>
              <Field label="분류 코드" htmlFor={`${prefix}-${row.key}-cat`}>
                <Input
                  id={`${prefix}-${row.key}-cat`}
                  value={row.categoryCode}
                  onChange={(e) => patch(row.key, { categoryCode: e.target.value })}
                />
              </Field>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`분할 ${index + 1} 삭제`}
                onClick={() => removeRow(row.key)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="bk-line-items-actions">
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={addRow}>
          <Plus className="size-3.5" />
          항목 추가
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={save}>
          분할 저장
        </Button>
      </div>
    </section>
  );
}
