import { Ban, Check, ClipboardList, Search, Tags, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BookkeepingReviewStatus, BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { KEYDOWN_PRIORITY, registerKeydown } from "@/lib/keydownBus";

import { editDraftFromTransaction, type TransactionEditDraft } from "../bookkeepingDrafts";
import { isEditableTarget } from "../bookkeepingFieldUtils";
import { type BookkeepingReviewFilter, matchesBookkeepingReviewFilter } from "../reviewFilter";
import { isSuspicious } from "../reviewRow";
import { type ReviewQueueOrder } from "../reviewSort";
import { clearSelection, selectedIds, toggleSelection } from "../selection";
import { reduceBookkeepingTriageState, triageCommandForKey } from "../triageKeys";
import { EmptyState } from "./_shared";
import { BulkCategorySelect } from "./BulkCategorySelect";
import { ReviewReadRow } from "./ReviewReadRow";
import { TransactionEditSheet } from "./TransactionEditSheet";

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
  /** 저장 성공 여부를 돌려준다 — 실패하면 폼을 접지 않아 draft를 잃지 않는다. */
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => Promise<boolean>;
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
  // 상세 편집 Sheet 대상 — 행 인라인 확장 폐지(테이블 유지 + 우측 패널).
  const [detailId, setDetailId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const filteredRows = rows.filter((tx) => matchesBookkeepingReviewFilter(tx, filter));
  // 의심(주의 사유 보유) 그룹 먼저, 정상 그룹 나중 — 렌더 순서가 곧 j/k 순서다.
  const suspiciousRows = filteredRows.filter((tx) => isSuspicious(tx));
  const normalRows = filteredRows.filter((tx) => !isSuspicious(tx));
  const orderedRows = [...suspiciousRows, ...normalRows];
  // 더 이상 큐에 없는 id(확정/삭제로 사라진 행)는 선택에서 떨군다.
  const present = new Set(filteredRows.map((tx) => tx.id));
  const ids = selectedIds(selected).filter((id) => present.has(id));
  const clear = () => setSelected(clearSelection());
  const runBulk = (status: BookkeepingReviewStatus) => onBulkReview(ids, status, clear);
  const activeIndex =
    orderedRows.length === 0
      ? -1
      : Math.max(0, Math.min(triage.activeIndex, orderedRows.length - 1));
  const activeTx = orderedRows[activeIndex] ?? null;

  useEffect(() => {
    return registerKeydown(KEYDOWN_PRIORITY.keymap, (event) => {
      if (disabled || bulkPending) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (isEditableTarget(event.target)) return false;
      const command = triageCommandForKey(event.key);
      if (!command) return false;

      event.preventDefault();
      if (command === "move_next" || command === "move_previous" || command === "toggle_help") {
        setTriage((current) => reduceBookkeepingTriageState(current, command, orderedRows.length));
        return true;
      }
      if (command === "focus_search") {
        searchRef.current?.focus();
        return true;
      }
      if (command === "focus_category") {
        // 분류는 이제 행 인라인 quick select — 폼을 펼칠 필요 없이 바로 포커스.
        if (activeTx) {
          document.getElementById(`bk-review-${activeTx.id}-category`)?.focus();
        }
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
  }, [activeTx, bulkPending, disabled, orderedRows.length, onApprove, onDelete]);

  // Sheet 저장 — 성공했을 때만 닫는다(실패 시 draft 유지).
  const saveFromSheet = async (tx: BookkeepingTransaction, draft: TransactionEditDraft) => {
    const ok = await onSave(tx, draft);
    if (ok) setDetailId(null);
  };

  // 인라인 셀의 부분 patch — 현재 tx로 draft를 합성해 기존 전체-업데이트 저장 경로에 태운다.
  const patchTransaction = (tx: BookkeepingTransaction, patch: Partial<TransactionEditDraft>) =>
    onSave(tx, { ...editDraftFromTransaction(tx), ...patch });

  const detailTx = orderedRows.find((tx) => tx.id === detailId) ?? null;

  /** 그룹 공용 행 렌더 — index는 orderedRows(의심→정상) 기준의 전역 triage 인덱스. */
  const renderReviewRow = (tx: BookkeepingTransaction, index: number, suspicious: boolean) => (
    <ReviewReadRow
      key={tx.id}
      tx={tx}
      disabled={disabled}
      active={index === activeIndex}
      selected={selected.has(tx.id)}
      selectionDisabled={disabled || bulkPending}
      showApprove={suspicious}
      onToggleSelect={() => setSelected((prev) => toggleSelection(prev, tx.id))}
      onApprove={() => onApprove(tx)}
      onOpenDetail={() => setDetailId(tx.id)}
      onDelete={() => onDelete(tx)}
      onPatch={(patch) => patchTransaction(tx, patch)}
    />
  );

  /** 그룹 헤더 행 — 테이블 전체 폭(colSpan) 캡션 줄. */
  const REVIEW_COLS = 8;

  return (
    <Card className="bk-card bk-review-card">
      <CardHeader className="bk-card-header-row">
        <div>
          <CardTitle className="bk-card-title">
            <ClipboardList className="size-4" />
            검토
          </CardTitle>
          <CardDescription className="bk-card-desc">
            Hermes 인박스 거래를 수정한 뒤 확정하거나 삭제합니다.
          </CardDescription>
        </div>
        <Badge variant="secondary">{filteredRows.length}</Badge>
      </CardHeader>
      <CardContent className="bk-card-body">
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
        {orderedRows.length === 0 && <EmptyState>대기 중인 거래 없음</EmptyState>}
        {orderedRows.length > 0 && (
          <Table className="bk-table bk-review-table">
            <TableHeader>
              <TableRow>
                <TableHead className="bk-th-check" aria-label="선택" />
                <TableHead className="bk-th-date typo-caption-sm">날짜</TableHead>
                <TableHead className="bk-th-merchant typo-caption-sm">가맹점</TableHead>
                <TableHead className="typo-caption-sm">내용</TableHead>
                <TableHead className="bk-th-category typo-caption-sm">분류</TableHead>
                <TableHead className="bk-th-reasons typo-caption-sm">사유</TableHead>
                <TableHead className="bk-th-amount typo-caption-sm">금액</TableHead>
                <TableHead className="bk-th-actions" aria-label="행 동작" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {suspiciousRows.length > 0 && (
                <TableRow className="bk-group-tr">
                  <TableCell colSpan={REVIEW_COLS} className="bk-group-td">
                    <div className="bk-review-group-head typo-caption-sm">
                      <span className="bk-review-group-title">의심 {suspiciousRows.length}건</span>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {suspiciousRows.map((tx, index) => renderReviewRow(tx, index, true))}
              {normalRows.length > 0 && (
                <TableRow className="bk-group-tr">
                  <TableCell colSpan={REVIEW_COLS} className="bk-group-td">
                    <div className="bk-review-group-head typo-caption-sm">
                      <span className="bk-review-group-title">정상 {normalRows.length}건</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={disabled || bulkPending}
                        onClick={() =>
                          onBulkReview(
                            normalRows.map((tx) => tx.id),
                            "approved",
                            () => {},
                          )
                        }
                      >
                        <Check className="size-3.5" />
                        {bulkPending ? "확정 중…" : `정상 ${normalRows.length}건 일괄 확정`}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {normalRows.map((tx, index) =>
                renderReviewRow(tx, suspiciousRows.length + index, false),
              )}
            </TableBody>
          </Table>
        )}
        <TransactionEditSheet
          tx={detailTx}
          disabled={disabled}
          approveLabel="확정"
          onApprove={(tx) => onApprove(tx)}
          onDelete={(tx) => {
            onDelete(tx);
            setDetailId(null);
          }}
          onSave={(tx, draft) => void saveFromSheet(tx, draft)}
          onClose={() => setDetailId(null)}
        />
      </CardContent>
    </Card>
  );
}
