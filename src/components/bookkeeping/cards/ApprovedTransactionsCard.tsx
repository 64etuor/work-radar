import { ReceiptText } from "lucide-react";
import { useState } from "react";

import type { BookkeepingTransaction } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { EmptyState } from "./_shared";
import { APPROVED_PAGE_SIZE, BACKEND_LIST_CAP, paginate } from "./pagination";
import { TransactionEditForm } from "./TransactionEditForm";
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
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => void;
  /** 인라인 분류 quick action — audit이 남는 override 경로로 처리한다. */
  onCategoryChange: (tx: BookkeepingTransaction, categoryCode: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-head">
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          확정 거래
        </CardTitle>
        <CardDescription className="bk-card-desc">
          선택한 월의 원장 거래입니다. 행을 클릭하면 전체 필드를 수정하고, 분류는 바로 바꿀 수
          있습니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="bk-card-body">
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
          {/* 원장 칼럼 헤더 — 행과 같은 그리드 템플릿을 공유하는 장부 라벨 줄.
              장식(스캔 보조)이라 aria-hidden — 행 자체가 접근 가능한 콘텐츠다. */}
          {rows.length > 0 && (
            <div className="bk-ledger-head typo-caption-sm" aria-hidden="true">
              <span>날짜</span>
              <span>내용</span>
              <span>분류</span>
              <span>결제</span>
              <span className="bk-ledger-head-amount">금액</span>
              <span />
            </div>
          )}
          {visible.map((tx) =>
            expandedId === tx.id ? (
              <TransactionEditForm
                key={tx.id}
                tx={tx}
                disabled={disabled}
                onDelete={() => onDelete(tx)}
                onSave={(draft) => onSave(tx, draft)}
                onCancel={() => setExpandedId(null)}
              />
            ) : (
              <TransactionReadRow
                key={tx.id}
                tx={tx}
                disabled={disabled}
                onEdit={() => setExpandedId(tx.id)}
                onDelete={() => onDelete(tx)}
                onCategoryChange={(categoryCode) => onCategoryChange(tx, categoryCode)}
              />
            ),
          )}
        </div>
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
      </CardContent>
    </Card>
  );
}
