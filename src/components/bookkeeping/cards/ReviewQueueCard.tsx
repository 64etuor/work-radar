import { Ban, Check, ClipboardList, Search, Tags, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BookkeepingReviewStatus, BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { KEYDOWN_PRIORITY, registerKeydown } from "@/lib/keydownBus";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { isEditableTarget } from "../bookkeepingFieldUtils";
import { type BookkeepingReviewFilter, matchesBookkeepingReviewFilter } from "../reviewFilter";
import { type ReviewQueueOrder } from "../reviewSort";
import { clearSelection, selectedIds, toggleSelection } from "../selection";
import { reduceBookkeepingTriageState, triageCommandForKey } from "../triageKeys";
import { EmptyState } from "./_shared";
import { BulkCategorySelect } from "./BulkCategorySelect";
import { TransactionEditForm } from "./TransactionEditForm";

export function ReviewQueueCard({
  rows,
  order,
  disabled,
  bulkPending,
  onApprove,
  onBulkReview,
  onBulkCategory,
  onBulkDelete,
  onDelete,
  onSave,
  onOrderChange,
}: {
  rows: BookkeepingTransaction[];
  order: ReviewQueueOrder;
  disabled: boolean;
  bulkPending: boolean;
  onApprove: (tx: BookkeepingTransaction) => void;
  onBulkReview: (ids: string[], status: BookkeepingReviewStatus, onDone: () => void) => void;
  onBulkCategory: (
    ids: string[],
    categoryCode: string,
    subcategoryCode: string,
    onDone: () => void,
  ) => void;
  onBulkDelete: (ids: string[], onDone: () => void) => void;
  onDelete: (tx: BookkeepingTransaction) => void;
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => void;
  onOrderChange: (order: ReviewQueueOrder) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useState<BookkeepingReviewFilter>({
    query: "",
    fromDate: "",
    toDate: "",
  });
  const [bulkCategoryCode, setBulkCategoryCode] = useState("uncategorized");
  const [bulkSubcategoryCode, setBulkSubcategoryCode] = useState("");
  const [triage, setTriage] = useState(() => ({
    activeIndex: rows.length > 0 ? 0 : -1,
    helpOpen: false,
  }));
  const searchRef = useRef<HTMLInputElement | null>(null);
  const filteredRows = rows.filter((tx) => matchesBookkeepingReviewFilter(tx, filter));
  // 더 이상 큐에 없는 id(확정/삭제로 사라진 행)는 선택에서 떨군다.
  const present = new Set(filteredRows.map((tx) => tx.id));
  const ids = selectedIds(selected).filter((id) => present.has(id));
  const clear = () => setSelected(clearSelection());
  const runBulk = (status: BookkeepingReviewStatus) => onBulkReview(ids, status, clear);
  const activeIndex =
    filteredRows.length === 0
      ? -1
      : Math.max(0, Math.min(triage.activeIndex, filteredRows.length - 1));
  const activeTx = filteredRows[activeIndex] ?? null;

  useEffect(() => {
    return registerKeydown(KEYDOWN_PRIORITY.keymap, (event) => {
      if (disabled || bulkPending) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (isEditableTarget(event.target)) return false;
      const command = triageCommandForKey(event.key);
      if (!command) return false;

      event.preventDefault();
      if (command === "move_next" || command === "move_previous" || command === "toggle_help") {
        setTriage((current) => reduceBookkeepingTriageState(current, command, filteredRows.length));
        return true;
      }
      if (command === "focus_search") {
        searchRef.current?.focus();
        return true;
      }
      if (command === "focus_category") {
        if (activeTx) document.getElementById(`bk-edit-${activeTx.id}-category`)?.focus();
        return true;
      }
      if (command === "approve" && activeTx) {
        onApprove(activeTx);
        return true;
      }
      if (command === "delete" && activeTx) {
        onDelete(activeTx);
        return true;
      }
      return true;
    });
  }, [activeTx, bulkPending, disabled, filteredRows.length, onApprove, onDelete]);

  return (
    <Card className="bk-card bk-review-card">
      <CardHeader className="bk-card-header-row">
        <div>
          <CardTitle className="bk-card-title">
            <ClipboardList className="size-4" />
            검토
          </CardTitle>
          <CardDescription>Hermes 인박스 거래를 수정한 뒤 확정하거나 삭제합니다.</CardDescription>
        </div>
        <Badge variant="secondary">{filteredRows.length}</Badge>
      </CardHeader>
      <CardContent>
        <div className="bk-review-tools">
          <div className="bk-review-search">
            <Search className="size-4" />
            <Input
              ref={searchRef}
              value={filter.query}
              onChange={(event) =>
                setFilter((current) => ({ ...current, query: event.target.value }))
              }
              placeholder="상호, 분류, 금액, 날짜, 사유 검색"
              aria-label="검토 큐 검색"
            />
          </div>
          <div className="bk-review-date-filters">
            <DatePicker
              value={filter.fromDate || null}
              onChange={(d) => setFilter((current) => ({ ...current, fromDate: d ?? "" }))}
              max={filter.toDate || undefined}
              placeholder="시작일"
              ariaLabel="검토 큐 시작일"
              className="w-full"
            />
            <DatePicker
              value={filter.toDate || null}
              onChange={(d) => setFilter((current) => ({ ...current, toDate: d ?? "" }))}
              min={filter.fromDate || undefined}
              placeholder="종료일"
              ariaLabel="검토 큐 종료일"
              className="w-full"
            />
          </div>
          <Select value={order} onValueChange={(value) => onOrderChange(value as ReviewQueueOrder)}>
            <SelectTrigger aria-label="검토 큐 정렬">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">최신순</SelectItem>
              <SelectItem value="confidence_asc">낮은 신뢰도</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={triage.helpOpen}
            onClick={() =>
              setTriage((current) =>
                reduceBookkeepingTriageState(current, "toggle_help", filteredRows.length),
              )
            }
          >
            ?
          </Button>
        </div>
        {triage.helpOpen && (
          <div className="bk-triage-help typo-caption-sm">
            <span>j/k 이동</span>
            <span>e 확정</span>
            <span>x 삭제</span>
            <span>/ 검색</span>
            <span>c 분류</span>
          </div>
        )}
        {ids.length > 0 && (
          <div className="bk-bulk-bar" role="group" aria-label="선택한 거래 일괄 처리">
            <span className="bk-bulk-count typo-caption-sm">{ids.length}건 선택</span>
            <div className="bk-bulk-actions">
              <BulkCategorySelect
                categoryCode={bulkCategoryCode}
                subcategoryCode={bulkSubcategoryCode}
                onCategoryChange={(categoryCode) => {
                  setBulkCategoryCode(categoryCode);
                  setBulkSubcategoryCode("");
                }}
                onSubcategoryChange={setBulkSubcategoryCode}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={bulkPending || !bulkCategoryCode}
                onClick={() => onBulkCategory(ids, bulkCategoryCode, bulkSubcategoryCode, clear)}
              >
                <Tags className="size-3.5" />
                분류 지정
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkPending}
                onClick={() => runBulk("approved")}
              >
                <Check className="size-3.5" />
                확정
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={bulkPending}
                onClick={() => runBulk("ignored")}
              >
                <Ban className="size-3.5" />
                무시
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={bulkPending}
                onClick={() => onBulkDelete(ids, clear)}
              >
                <Trash2 className="size-3.5" />
                삭제
              </Button>
            </div>
          </div>
        )}
        <div className="bk-transaction-list">
          {filteredRows.length === 0 && <EmptyState>대기 중인 거래 없음</EmptyState>}
          {filteredRows.map((tx, index) => (
            <div
              key={tx.id}
              className="bk-review-row"
              data-active={index === activeIndex ? "true" : "false"}
            >
              <Checkbox
                className="bk-select-check"
                checked={selected.has(tx.id)}
                onCheckedChange={() => setSelected((prev) => toggleSelection(prev, tx.id))}
                disabled={disabled || bulkPending}
                aria-label={`${tx.merchant} 선택`}
              />
              <TransactionEditForm
                tx={tx}
                disabled={disabled}
                approveLabel="확정"
                onApprove={() => onApprove(tx)}
                onDelete={() => onDelete(tx)}
                onSave={(draft) => onSave(tx, draft)}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
