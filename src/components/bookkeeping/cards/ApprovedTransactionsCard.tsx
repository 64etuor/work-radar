import { ReceiptText } from "lucide-react";
import { useState } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { editDraftFromTransaction, type TransactionEditDraft } from "../bookkeepingDrafts";
import { EmptyState } from "./_shared";
import { APPROVED_PAGE_SIZE, BACKEND_LIST_CAP, paginate } from "./pagination";
import { TransactionEditSheet } from "./TransactionEditSheet";
import { TransactionReadRow } from "./TransactionReadRow";

export function ApprovedTransactionsCard({
  rows,
  disabled,
  onDelete,
  onSave,
  onCategoryChange,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onDelete: (tx: BookkeepingTransaction) => void;
  /** 저장 성공 여부를 돌려준다 — 인라인 셀이 실패 시 입력을 유지한다. */
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => Promise<boolean>;
  /** 인라인 분류 quick action — audit이 남는 override 경로로 처리한다. */
  onCategoryChange: (tx: BookkeepingTransaction, categoryCode: string) => void;
}) {
  // 상세 편집 Sheet 대상 id — 행 인라인 확장 폐지(테이블 유지 + 우측 패널).
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailTx = rows.find((tx) => tx.id === detailId) ?? null;
  // 쿼리 데이터 identity가 바뀌면(월/프로젝트 스코프 전환, refetch) 1페이지로 리셋 —
  // React 공식 "adjust state during render" 패턴(effect 없이 이전 rows와 비교).
  const [pager, setPager] = useState<{ rows: BookkeepingTransaction[]; page: number }>({
    rows,
    page: 0,
  });
  if (pager.rows !== rows) {
    setPager({ rows, page: 0 });
  }
  const requestedPage = pager.rows === rows ? pager.page : 0;
  const setRequestedPage = (page: number) => setPager({ rows, page });
  const { page, pageCount, start, end } = paginate(rows.length, APPROVED_PAGE_SIZE, requestedPage);
  const visible = rows.slice(start, end);

  // 인라인 셀의 부분 patch — 현재 tx로 draft를 합성해 기존 전체-업데이트 저장 경로에 태운다.
  const patchTransaction = (tx: BookkeepingTransaction, patch: Partial<TransactionEditDraft>) =>
    onSave(tx, { ...editDraftFromTransaction(tx), ...patch });

  const saveFromSheet = async (tx: BookkeepingTransaction, draft: TransactionEditDraft) => {
    const ok = await onSave(tx, draft);
    if (ok) setDetailId(null);
  };

  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          확정 거래
        </CardTitle>
        <CardDescription className="bk-card-desc">
          선택한 월의 원장 거래입니다. 셀을 클릭하면 그 자리에서 수정되고, 상세는 우측 패널에서
          편집합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
        {rows.length > 0 && (
          <Table className="bk-table">
            <TableHeader>
              <TableRow>
                <TableHead className="bk-th-date typo-caption-sm">날짜</TableHead>
                <TableHead className="bk-th-merchant typo-caption-sm">가맹점</TableHead>
                <TableHead className="typo-caption-sm">내용</TableHead>
                <TableHead className="bk-th-category typo-caption-sm">분류</TableHead>
                <TableHead className="bk-th-payment typo-caption-sm">결제·자산</TableHead>
                <TableHead className="bk-th-direction typo-caption-sm">구분</TableHead>
                <TableHead className="bk-th-amount typo-caption-sm">금액</TableHead>
                <TableHead className="bk-th-actions" aria-label="행 동작" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((tx) => (
                <TransactionReadRow
                  key={tx.id}
                  tx={tx}
                  disabled={disabled}
                  onOpenDetail={() => setDetailId(tx.id)}
                  onDelete={() => onDelete(tx)}
                  onCategoryChange={(categoryCode) => onCategoryChange(tx, categoryCode)}
                  onPatch={(patch) => patchTransaction(tx, patch)}
                />
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length > 0 && (
          <div className="bk-pager">
            <span className="bk-pager-range typo-caption-sm">
              {start + 1}–{end} / 총 {rows.length}건
              {/* 백엔드 list는 LIMIT 200 안전 상한 — 딱 200건이면 잘렸을 수 있음을 정직하게 표기. */}
              {rows.length === BACKEND_LIST_CAP && (
                <span className="bk-pager-cap"> · 최대 {BACKEND_LIST_CAP}건 표시</span>
              )}
            </span>
            {/* 페이저는 단일 페이지에서도 항상 노출한다(경계 버튼만 비활성) —
                숨기면 페이지네이션 존재 자체가 발견 불가능해 사용자가 혼란스러워한다. */}
            <div className="bk-pager-controls" role="group" aria-label="확정 거래 페이지 이동">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setRequestedPage(page - 1)}
              >
                이전
              </Button>
              <span className="bk-pager-page typo-caption-sm" aria-live="polite">
                {page + 1} / {pageCount}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= pageCount - 1}
                onClick={() => setRequestedPage(page + 1)}
              >
                다음
              </Button>
            </div>
          </div>
        )}
        <TransactionEditSheet
          tx={detailTx}
          disabled={disabled}
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
