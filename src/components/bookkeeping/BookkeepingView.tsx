import "./BookkeepingView.css";

import {
  AlertTriangle,
  Ban,
  Check,
  ClipboardList,
  Plus,
  ReceiptText,
  ShieldAlert,
  WalletCards,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import type { BookkeepingReviewStatus, BookkeepingTransaction } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  IpcError,
  localToday,
  useBookkeepingAudit,
  useBookkeepingMonthlySummary,
  useBookkeepingSyncJobs,
  useBookkeepingTransactions,
  useCreateBookkeepingTransaction,
  useUpdateBookkeepingReviewStatus,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";

const CATEGORY_OPTIONS = ["food", "transport", "shopping", "housing", "health", "work", "misc"];

type Draft = {
  merchant: string;
  amount: string;
  spentAt: string;
  category: string;
  note: string;
};

const currency = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

function currentMonth() {
  return localToday().slice(0, 7);
}

function emptyDraft(): Draft {
  return {
    merchant: "",
    amount: "",
    spentAt: localToday(),
    category: "food",
    note: "",
  };
}

function statusLabel(status: BookkeepingReviewStatus) {
  if (status === "approved") return "승인";
  if (status === "ignored") return "무시";
  return "리뷰";
}

function sourceLabel(source: string) {
  if (source === "gmail") return "Gmail";
  if (source === "ocr") return "OCR";
  if (source === "csv") return "CSV";
  return "수동";
}

function pushMutationError(scope: string, error: unknown) {
  const store = useToastStore.getState();
  if (error instanceof IpcError) {
    store.pushError(scope, error.app);
  } else {
    store.pushError(scope, error instanceof Error ? error.message : String(error));
  }
}

export function BookkeepingView() {
  const [month, setMonth] = useState(currentMonth);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const transactions = useBookkeepingTransactions(null);
  const summary = useBookkeepingMonthlySummary(month);
  const audit = useBookkeepingAudit(null);
  const syncJobs = useBookkeepingSyncJobs();
  const createTx = useCreateBookkeepingTransaction();
  const review = useUpdateBookkeepingReviewStatus();
  const pushSuccess = useToastStore((s) => s.pushSuccess);
  const pushError = useToastStore((s) => s.pushError);

  const reviewQueue = useMemo(
    () => (transactions.data ?? []).filter((tx) => tx.reviewStatus === "needs_review"),
    [transactions.data],
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      pushError("bookkeeping.form", "금액을 확인하세요");
      return;
    }
    createTx.mutate(
      {
        projectId: null,
        source: "manual",
        sourceRef: null,
        merchant: draft.merchant,
        description: null,
        amountMinor: Math.round(amount),
        currency: "KRW",
        spentAt: draft.spentAt,
        category: draft.category,
        note: draft.note.trim() || null,
      },
      {
        onSuccess: () => {
          setDraft(emptyDraft());
          pushSuccess("거래가 추가됐습니다");
        },
        onError: (error) => pushMutationError("bookkeeping.create", error),
      },
    );
  };

  const setReviewStatus = (tx: BookkeepingTransaction, status: BookkeepingReviewStatus) => {
    review.mutate(
      { id: tx.id, status },
      {
        onSuccess: () => pushSuccess(status === "approved" ? "승인했습니다" : "무시했습니다"),
        onError: (error) => pushMutationError("bookkeeping.review", error),
      },
    );
  };

  return (
    <main className="bk-view">
      <div className="bk-shell">
        <aside className="bk-side">
          <section className="bk-panel" aria-labelledby="bk-manual-title">
            <div className="bk-panel-header">
              <div className="bk-panel-title">
                <WalletCards className="text-wr-muted size-4" />
                <h1 id="bk-manual-title" className="typo-title-sm">
                  가계부
                </h1>
              </div>
              <Badge variant="outline">local</Badge>
            </div>
            <div className="bk-panel-body">
              <form className="bk-form" onSubmit={submit}>
                <label className="bk-field">
                  <span className="bk-label typo-label-sm">상점</span>
                  <Input
                    value={draft.merchant}
                    onChange={(e) => setDraft((d) => ({ ...d, merchant: e.target.value }))}
                    required
                  />
                </label>
                <div className="bk-field-row">
                  <label className="bk-field">
                    <span className="bk-label typo-label-sm">금액</span>
                    <Input
                      type="number"
                      min="1"
                      inputMode="numeric"
                      value={draft.amount}
                      onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
                      required
                    />
                  </label>
                  <label className="bk-field">
                    <span className="bk-label typo-label-sm">날짜</span>
                    <Input
                      type="date"
                      value={draft.spentAt}
                      onChange={(e) => setDraft((d) => ({ ...d, spentAt: e.target.value }))}
                      required
                    />
                  </label>
                </div>
                <label className="bk-field">
                  <span className="bk-label typo-label-sm">카테고리</span>
                  <select
                    className="bk-select"
                    value={draft.category}
                    onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                  >
                    {CATEGORY_OPTIONS.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="bk-field">
                  <span className="bk-label typo-label-sm">메모</span>
                  <textarea
                    className="bk-textarea"
                    value={draft.note}
                    onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                  />
                </label>
                <Button type="submit" disabled={createTx.isPending}>
                  <Plus className="size-4" />
                  추가
                </Button>
              </form>
            </div>
          </section>

          <section className="bk-panel" aria-labelledby="bk-sync-title">
            <div className="bk-panel-header">
              <div className="bk-panel-title">
                <ShieldAlert className="text-wr-muted size-4" />
                <h2 id="bk-sync-title" className="typo-title-sm">
                  Sync
                </h2>
              </div>
            </div>
            <div className="bk-panel-body">
              <div className="bk-sync-list">
                {(syncJobs.data ?? []).length === 0 && <div className="bk-empty">기록 없음</div>}
                {(syncJobs.data ?? []).map((job) => (
                  <div key={job.id} className="bk-row bk-sync-row">
                    <div className="bk-row-top">
                      <div className="bk-row-title">
                        <strong className="typo-body-strong">{sourceLabel(job.source)}</strong>
                        <p className="bk-sync-failed typo-caption-sm">
                          {job.sanitizedErrorMessage ?? "동기화 실패"}
                        </p>
                      </div>
                      <AlertTriangle className="text-wr-danger size-4" />
                    </div>
                    <div className="bk-row-meta typo-caption-sm">
                      <span>{job.sanitizedErrorCode ?? "sync.failed"}</span>
                      <span>{job.updatedAt}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </aside>

        <section className="bk-main">
          <section className="bk-panel" aria-labelledby="bk-summary-title">
            <div className="bk-panel-header">
              <div className="bk-panel-title">
                <ReceiptText className="text-wr-muted size-4" />
                <h2 id="bk-summary-title" className="typo-title-sm">
                  월별 요약
                </h2>
              </div>
              <Input
                className="max-w-36"
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value || currentMonth())}
              />
            </div>
            <div className="bk-panel-body">
              <div className="bk-summary-grid">
                <Metric label="합계" value={currency.format(summary.data?.totalAmountMinor ?? 0)} />
                <Metric label="리뷰" value={String(summary.data?.needsReviewCount ?? 0)} />
                <Metric label="승인" value={String(summary.data?.approvedCount ?? 0)} />
              </div>
              <div className="mt-4">
                {(summary.data?.categories ?? []).length === 0 && (
                  <div className="bk-empty">거래 없음</div>
                )}
                {(summary.data?.categories ?? []).map((row) => (
                  <div key={row.category} className="bk-category-row typo-body-md">
                    <span>{row.category}</span>
                    <span>{currency.format(row.amountMinor)}</span>
                    <Badge variant="outline">{row.count}</Badge>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="bk-panel" aria-labelledby="bk-review-title">
            <div className="bk-panel-header">
              <div className="bk-panel-title">
                <ClipboardList className="text-wr-muted size-4" />
                <h2 id="bk-review-title" className="typo-title-sm">
                  리뷰큐
                </h2>
              </div>
              <Badge variant="secondary">{reviewQueue.length}</Badge>
            </div>
            <div className="bk-panel-body">
              <div className="bk-transaction-list">
                {reviewQueue.length === 0 && <div className="bk-empty">대기 없음</div>}
                {reviewQueue.map((tx) => (
                  <TransactionRow
                    key={tx.id}
                    tx={tx}
                    disabled={review.isPending}
                    onApprove={() => setReviewStatus(tx, "approved")}
                    onIgnore={() => setReviewStatus(tx, "ignored")}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="bk-panel" aria-labelledby="bk-latest-title">
            <div className="bk-panel-header">
              <div className="bk-panel-title">
                <ReceiptText className="text-wr-muted size-4" />
                <h2 id="bk-latest-title" className="typo-title-sm">
                  최근 거래
                </h2>
              </div>
            </div>
            <div className="bk-panel-body">
              <div className="bk-transaction-list">
                {(transactions.data ?? []).length === 0 && (
                  <div className="bk-empty">거래 없음</div>
                )}
                {(transactions.data ?? []).slice(0, 8).map((tx) => (
                  <TransactionRow
                    key={tx.id}
                    tx={tx}
                    disabled={review.isPending}
                    onApprove={() => setReviewStatus(tx, "approved")}
                    onIgnore={() => setReviewStatus(tx, "ignored")}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="bk-panel" aria-labelledby="bk-audit-title">
            <div className="bk-panel-header">
              <div className="bk-panel-title">
                <ShieldAlert className="text-wr-muted size-4" />
                <h2 id="bk-audit-title" className="typo-title-sm">
                  Audit
                </h2>
              </div>
            </div>
            <div className="bk-panel-body">
              <div className="bk-audit-list">
                {(audit.data ?? []).length === 0 && <div className="bk-empty">기록 없음</div>}
                {(audit.data ?? []).slice(0, 12).map((entry) => (
                  <div key={entry.id} className="bk-row">
                    <div className="bk-row-top">
                      <span className="typo-body-strong">{entry.action}</span>
                      <span className="text-wr-subtle typo-caption-sm">{entry.createdAt}</span>
                    </div>
                    <span className="text-wr-muted typo-body-md">{entry.summary}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bk-metric">
      <div className="text-wr-subtle typo-caption-sm">{label}</div>
      <div className="typo-title-md">{value}</div>
    </div>
  );
}

function TransactionRow({
  tx,
  disabled,
  onApprove,
  onIgnore,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  onApprove: () => void;
  onIgnore: () => void;
}) {
  return (
    <div className="bk-row">
      <div className="bk-row-top">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{tx.merchant}</strong>
          <div className="text-wr-muted typo-body-md">{currency.format(tx.amountMinor)}</div>
        </div>
        <div className="bk-row-actions">
          {tx.reviewStatus !== "approved" && (
            <Button size="sm" variant="outline" disabled={disabled} onClick={onApprove}>
              <Check className="size-3.5" />
              승인
            </Button>
          )}
          {tx.reviewStatus !== "ignored" && (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={onIgnore}>
              <Ban className="size-3.5" />
              무시
            </Button>
          )}
        </div>
      </div>
      <div className="bk-row-meta typo-caption-sm">
        <span>{tx.spentAt}</span>
        <span>{tx.category}</span>
        <span>{sourceLabel(tx.source)}</span>
        <span className={`bk-status-${tx.reviewStatus}`}>{statusLabel(tx.reviewStatus)}</span>
      </div>
      {tx.note && <p className="text-wr-muted typo-caption-sm">{tx.note}</p>}
    </div>
  );
}
