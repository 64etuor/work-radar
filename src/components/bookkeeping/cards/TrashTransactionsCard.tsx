import { ChevronDown, Trash2 } from "lucide-react";
import { useState } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { EmptyState } from "./_shared";
import { TrashTransactionRow } from "./TrashTransactionRow";

export function TrashTransactionsCard({
  rows,
  disabled,
  onRestore,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onRestore: (tx: BookkeepingTransaction) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="bk-card bk-collapsible-card" data-state={open ? "open" : "closed"}>
      <CardHeader className="bk-card-header-row bk-collapsible-header">
        <div className="bk-collapsible-heading">
          <CardTitle className="bk-card-title">
            <Trash2 className="size-4" />
            휴지통
          </CardTitle>
          <CardDescription className="bk-card-desc">
            삭제된 거래와 중복·무시 항목을 복원합니다.
          </CardDescription>
        </div>
        <div className="bk-header-actions">
          <Badge variant="secondary">{rows.length}</Badge>
          <Button
            variant="ghost"
            size="sm"
            className="bk-collapse-trigger"
            aria-controls="bk-trash-panel"
            aria-expanded={open}
            aria-label={`휴지통 ${open ? "접기" : "펼치기"}`}
            onClick={() => setOpen(!open)}
          >
            <ChevronDown className="bk-collapse-chevron size-4" aria-hidden="true" />
          </Button>
        </div>
      </CardHeader>
      <div
        id="bk-trash-panel"
        className="bk-collapsible-region"
        data-state={open ? "open" : "closed"}
        aria-hidden={!open}
      >
        <div className="bk-collapsible-inner">
          <CardContent className="bk-card-body">
            <div className="bk-transaction-list">
              {rows.length === 0 && <EmptyState>휴지통 비어 있음</EmptyState>}
              {rows.map((tx) => (
                <TrashTransactionRow
                  key={tx.id}
                  tx={tx}
                  disabled={disabled}
                  onRestore={() => onRestore(tx)}
                />
              ))}
            </div>
          </CardContent>
        </div>
      </div>
    </Card>
  );
}
