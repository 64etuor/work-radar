import { useBookkeepingLineItems } from "@/lib/query";

import { LineItemEditorForm } from "./LineItemEditorForm";

export function LineItemEditor({
  transactionId,
  amountMinor,
  disabled,
}: {
  transactionId: string;
  amountMinor: number;
  disabled: boolean;
}) {
  const itemsQuery = useBookkeepingLineItems(transactionId);
  if (itemsQuery.isPending) {
    return <p className="text-muted-foreground typo-caption-sm">분할 항목 불러오는 중…</p>;
  }
  return (
    <LineItemEditorForm
      key={transactionId}
      transactionId={transactionId}
      amountMinor={amountMinor}
      initialItems={itemsQuery.data ?? []}
      disabled={disabled}
    />
  );
}
