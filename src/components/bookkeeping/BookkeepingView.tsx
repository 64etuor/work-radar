import "./BookkeepingView.css";

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { type FormEvent, useReducer, useState } from "react";

import type {
  BookkeepingExportFormat,
  BookkeepingRecurringOccurrence,
  BookkeepingReviewStatus,
  BookkeepingTransaction,
} from "@/bindings";
import {
  useBookkeepingAudit,
  useBookkeepingBudgetStatus,
  useBookkeepingCashflow,
  useBookkeepingCategoryTrend,
  useBookkeepingGmailLabels,
  useBookkeepingMonthlySummary,
  useBookkeepingReconcileAccount,
  useBookkeepingRecurringExpenses,
  useBookkeepingRecurringOccurrences,
  useBookkeepingSyncCursors,
  useBookkeepingSyncJobs,
  useBookkeepingTransactions,
  useBookkeepingTrash,
  useBulkDeleteBookkeepingTransactions,
  useBulkSetBookkeepingCategory,
  useBulkUpdateBookkeepingReviewStatus,
  useCreateBookkeepingRecurringExpense,
  useCreateBookkeepingTransaction,
  useDeleteBookkeepingTransaction,
  useEnsureBookkeepingRecurringOccurrences,
  usePostBookkeepingRecurringOccurrence,
  useProjects,
  useRestoreBookkeepingTransaction,
  useSetBookkeepingBudget,
  useSetBookkeepingRecurringOccurrenceStatus,
  useSyncBookkeepingGmailReceipts,
  useUpdateBookkeepingReviewStatus,
  useUpdateBookkeepingTransaction,
  useWriteBookkeepingExport,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";

import { SectionLabel } from "../settings/SettingsKit";
import { ALL_PROJECTS } from "./bookkeepingConstants";
import {
  type BudgetDraft,
  emptyBudgetDraft,
  emptyGmailSyncDraft,
  emptyManualDraft,
  emptyReconciliationDraft,
  emptyRecurringDraft,
  type GmailSyncDraft,
  type ManualDraft,
  type ReconciliationDraft,
  type RecurringDraft,
  type TransactionEditDraft,
} from "./bookkeepingDrafts";
import { nullableText, pushMutationError, splitCsv } from "./bookkeepingFieldUtils";
import { monthRange, stepMonthBy } from "./bookkeepingMonth";
import {
  BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  BOOKKEEPING_INPUT_PANEL_ORDER,
} from "./bookkeepingPanels";
import {
  bookkeepingScopeReducer,
  initialBookkeepingScope,
  inputPanelsReducer,
} from "./bookkeepingState";
import { ApprovedTransactionsCard } from "./cards/ApprovedTransactionsCard";
import { BookkeepingExportControls } from "./cards/BookkeepingExportControls";
import { BookkeepingMetrics } from "./cards/BookkeepingMetrics";
import { BookkeepingScopeControls } from "./cards/BookkeepingScopeControls";
import { BudgetCard } from "./cards/BudgetCard";
import { CategorySummaryCard } from "./cards/CategorySummaryCard";
import { CurrencySummaryRows } from "./cards/CurrencySummaryRows";
import { GmailSyncCard } from "./cards/GmailSyncCard";
import { ManualEntryCard } from "./cards/ManualEntryCard";
import { OperationsLogCard } from "./cards/OperationsLogCard";
import { ReconciliationCard } from "./cards/ReconciliationCard";
import { RecurringExpenseFormCard } from "./cards/RecurringExpenseFormCard";
import { RecurringMonthCard } from "./cards/RecurringMonthCard";
import { ReportsSection } from "./cards/ReportsSection";
import { ReviewQueueCard } from "./cards/ReviewQueueCard";
import { TrashTransactionsCard } from "./cards/TrashTransactionsCard";
import { normalizeGmailQuery } from "./gmailSync";
import { signedMinorLabel } from "./reconciliation";
import { reviewOrderToQueryParam, type ReviewQueueOrder } from "./reviewSort";

export function BookkeepingView() {
  const [scope, dispatchScope] = useReducer(
    bookkeepingScopeReducer,
    undefined,
    initialBookkeepingScope,
  );
  const [manualDraft, setManualDraft] = useState<ManualDraft>(() => emptyManualDraft());
  const [recurringDraft, setRecurringDraft] = useState<RecurringDraft>(() => emptyRecurringDraft());
  const [budgetDraft, setBudgetDraft] = useState<BudgetDraft>(() => emptyBudgetDraft());
  const [reconciliationDraft, setReconciliationDraft] = useState<ReconciliationDraft>(() =>
    emptyReconciliationDraft(),
  );
  const [reviewOrder, setReviewOrder] = useState<ReviewQueueOrder>("default");
  const [inputPanelsOpen, setInputPanelOpen] = useReducer(inputPanelsReducer, {
    ...BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  });
  const [gmailDraft, setGmailDraft] = useState<GmailSyncDraft>(() => emptyGmailSyncDraft());

  const projects = useProjects();
  const { month, projectId: projectScopeId } = scope;
  const reportFromMonth = stepMonthBy(month, -5);
  const projectOptions = projects.data ?? [];
  const selectedProjectId =
    projectScopeId === ALL_PROJECTS ||
    projectOptions.some((project) => project.id === projectScopeId)
      ? projectScopeId
      : ALL_PROJECTS;
  const activeProjectId = selectedProjectId === ALL_PROJECTS ? null : selectedProjectId;
  const gmailLabels = useBookkeepingGmailLabels(activeProjectId);
  const reviewTransactions = useBookkeepingTransactions(
    "needs_review",
    activeProjectId,
    reviewOrderToQueryParam(reviewOrder),
  );
  const approvedTransactions = useBookkeepingTransactions("approved", activeProjectId);
  const trashTransactions = useBookkeepingTrash(activeProjectId);
  const summary = useBookkeepingMonthlySummary(month, activeProjectId);
  const budgetStatus = useBookkeepingBudgetStatus(month, activeProjectId);
  const cashflow = useBookkeepingCashflow({
    projectId: activeProjectId,
    fromMonth: reportFromMonth,
    toMonth: month,
  });
  const categoryTrend = useBookkeepingCategoryTrend({
    projectId: activeProjectId,
    fromMonth: reportFromMonth,
    toMonth: month,
    categoryCode: null,
  });
  const audit = useBookkeepingAudit(null);
  const syncJobs = useBookkeepingSyncJobs();
  const syncCursors = useBookkeepingSyncCursors();
  const recurringExpenses = useBookkeepingRecurringExpenses(activeProjectId);
  const recurringOccurrences = useBookkeepingRecurringOccurrences(month, activeProjectId);
  const createTx = useCreateBookkeepingTransaction();
  const createRecurring = useCreateBookkeepingRecurringExpense();
  const ensureRecurring = useEnsureBookkeepingRecurringOccurrences();
  const postRecurring = usePostBookkeepingRecurringOccurrence();
  const setRecurringStatus = useSetBookkeepingRecurringOccurrenceStatus();
  const syncGmail = useSyncBookkeepingGmailReceipts();
  const review = useUpdateBookkeepingReviewStatus();
  const bulkReview = useBulkUpdateBookkeepingReviewStatus();
  const bulkCategory = useBulkSetBookkeepingCategory();
  const bulkDelete = useBulkDeleteBookkeepingTransactions();
  const setBudget = useSetBookkeepingBudget();
  const reconcileAccount = useBookkeepingReconcileAccount();
  const writeExport = useWriteBookkeepingExport();
  const updateTx = useUpdateBookkeepingTransaction();
  const deleteTx = useDeleteBookkeepingTransaction();
  const restoreTx = useRestoreBookkeepingTransaction();
  const pushSuccess = useToastStore((s) => s.pushSuccess);
  const pushError = useToastStore((s) => s.pushError);
  const exportPending = writeExport.isPending;

  const plannedTotal = (recurringOccurrences.data ?? [])
    .filter((row) => row.status !== "skipped")
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const submitManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(manualDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      pushError("bookkeeping.form", "금액을 확인하세요");
      return;
    }
    createTx.mutate(
      {
        projectId: activeProjectId,
        source: "manual",
        sourceRef: null,
        merchant: manualDraft.merchant,
        description: null,
        amountMinor: Math.round(amount),
        currency: "KRW",
        spentAt: manualDraft.spentAt,
        category: manualDraft.category,
        note: nullableText(manualDraft.note),
        paymentMethodKind: manualDraft.paymentMethodKind,
        paymentMethodLabel: nullableText(manualDraft.paymentMethodLabel),
        paymentMethodLast4: nullableText(manualDraft.paymentMethodLast4),
        expenseKind: manualDraft.expenseKind,
        recurringExpenseId: null,
        recurringOccurrenceId: null,
        // Judgment-pipeline fields (manual entry defaults; income toggle + judgment UI = Phase G).
        direction: "expense",
        account: null,
        subcategory: null,
        categoryCode: null,
        subcategoryCode: null,
        rawCategory: null,
        spentAtTime: null,
        confidence: null,
        fieldConfidenceJson: null,
        reviewReasonsJson: null,
        orderNo: null,
        paymentNo: null,
      },
      {
        onSuccess: () => {
          setManualDraft(emptyManualDraft());
          pushSuccess("거래가 추가됐습니다");
        },
        onError: (error) => pushMutationError("bookkeeping.create", error),
      },
    );
  };

  const submitRecurring = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(recurringDraft.amount);
    const scheduleDay = Number(recurringDraft.scheduleDay);
    if (!Number.isFinite(amount) || amount <= 0) {
      pushError("bookkeeping.recurring", "고정비 금액을 확인하세요");
      return;
    }
    if (!Number.isInteger(scheduleDay) || scheduleDay < 1 || scheduleDay > 31) {
      pushError("bookkeeping.recurring", "결제일은 1~31 범위여야 합니다");
      return;
    }
    createRecurring.mutate(
      {
        projectId: activeProjectId,
        name: recurringDraft.name,
        merchant: nullableText(recurringDraft.merchant),
        amountMinor: Math.round(amount),
        currency: "KRW",
        category: recurringDraft.category,
        paymentMethodKind: recurringDraft.paymentMethodKind,
        paymentMethodLabel: nullableText(recurringDraft.paymentMethodLabel),
        paymentMethodLast4: nullableText(recurringDraft.paymentMethodLast4),
        expenseKind: recurringDraft.expenseKind,
        scheduleDay,
        startMonth: recurringDraft.startMonth,
        endMonth: null,
        note: nullableText(recurringDraft.note),
      },
      {
        onSuccess: () => {
          setRecurringDraft(emptyRecurringDraft());
          ensureRecurring.mutate({ month, projectId: activeProjectId });
          pushSuccess("고정비가 등록됐습니다");
        },
        onError: (error) => pushMutationError("bookkeeping.recurring", error),
      },
    );
  };

  const submitGmailSync = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeProjectId) {
      pushError("bookkeeping.gmail", "프로젝트를 선택하세요");
      return;
    }
    const labelNames = splitCsv(gmailDraft.labels);
    const query = gmailDraft.query.trim();
    if (labelNames.length === 0 && !query) {
      pushError("bookkeeping.gmail", "라벨 또는 검색어를 입력하세요");
      return;
    }
    syncGmail.mutate(
      {
        projectId: activeProjectId,
        labelIds: [],
        labelNames,
        query: normalizeGmailQuery(gmailDraft.query),
        maxResults: 50,
      },
      {
        onSuccess: (result) => {
          pushSuccess(
            `Gmail ${result.scannedCount}건 확인, ${result.importedCount}건 추가, ${result.failedCount}건 실패`,
          );
        },
        onError: (error) => pushMutationError("bookkeeping.gmail", error),
      },
    );
  };

  const submitBudget = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amount = Number(budgetDraft.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      pushError("bookkeeping.budget", "예산 금액을 확인하세요");
      return;
    }
    setBudget.mutate(
      {
        projectId: activeProjectId,
        month,
        categoryCode: budgetDraft.category,
        limitMinor: Math.round(amount),
        currency: "KRW",
        rollover: budgetDraft.rollover,
        note: nullableText(budgetDraft.note),
      },
      {
        onSuccess: () => pushSuccess("예산을 저장했습니다"),
        onError: (error) => pushMutationError("bookkeeping.budget", error),
      },
    );
  };

  const submitReconciliation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const statementBalance = Number(reconciliationDraft.statementBalance);
    if (!Number.isFinite(statementBalance)) {
      pushError("bookkeeping.reconcile", "명세서 잔액을 확인하세요");
      return;
    }
    reconcileAccount.mutate(
      {
        projectId: activeProjectId,
        account: reconciliationDraft.account,
        statementDate: reconciliationDraft.statementDate,
        statementBalanceMinor: Math.round(statementBalance),
        currency: reconciliationDraft.currency,
        note: nullableText(reconciliationDraft.note),
      },
      {
        onSuccess: (result) => {
          if (result.matched) {
            pushSuccess("정산이 일치합니다");
          } else {
            pushError(
              "bookkeeping.reconcile",
              `차이 ${signedMinorLabel(result.differenceMinor)} ${reconciliationDraft.currency}`,
            );
          }
        },
        onError: (error) => pushMutationError("bookkeeping.reconcile", error),
      },
    );
  };

  const exportBookkeeping = async (format: BookkeepingExportFormat) => {
    const { fromDate, toDate } = monthRange(month);
    const input = { projectId: activeProjectId, fromDate, toDate };
    const extension = format;

    try {
      const path = await saveDialog({
        defaultPath: `work-radar-bookkeeping-${month}.${extension}`,
        filters: [{ name: format.toUpperCase(), extensions: [extension] }],
      });
      if (!path) return;

      await writeExport.mutateAsync({ path, format, export: input });
      pushSuccess(`${format.toUpperCase()} export 저장 완료`);
    } catch (error) {
      pushMutationError("bookkeeping.export", error);
    }
  };

  const setReviewStatus = (tx: BookkeepingTransaction, status: BookkeepingReviewStatus) => {
    review.mutate(
      { id: tx.id, status },
      {
        onSuccess: () =>
          pushSuccess(status === "approved" ? "확정했습니다" : "리뷰 대기로 복원했습니다"),
        onError: (error) => pushMutationError("bookkeeping.review", error),
      },
    );
  };

  const bulkSetReviewStatus = (
    ids: string[],
    status: BookkeepingReviewStatus,
    onDone: () => void,
  ) => {
    if (ids.length === 0) return;
    bulkReview.mutate(
      { ids, status },
      {
        onSuccess: (results) => {
          const failed = results.filter((r) => !r.ok).length;
          if (failed > 0) {
            pushError("bookkeeping.bulk", `${results.length - failed}건 처리, ${failed}건 실패`);
          } else {
            pushSuccess(
              status === "approved"
                ? `${ids.length}건 확정했습니다`
                : `${ids.length}건 무시했습니다`,
            );
          }
          onDone();
        },
        onError: (error) => pushMutationError("bookkeeping.bulk", error),
      },
    );
  };

  const bulkSetCategory = (
    ids: string[],
    categoryCode: string,
    subcategoryCode: string,
    onDone: () => void,
  ) => {
    if (ids.length === 0) return;
    bulkCategory.mutate(
      {
        ids,
        categoryCode,
        subcategoryCode: nullableText(subcategoryCode),
        reason: "bulk_triage",
      },
      {
        onSuccess: (results) => {
          const failed = results.filter((r) => !r.ok).length;
          if (failed > 0) {
            pushError(
              "bookkeeping.bulk.category",
              `${results.length - failed}건 처리, ${failed}건 실패`,
            );
          } else {
            pushSuccess(`${ids.length}건 분류를 지정했습니다`);
          }
          onDone();
        },
        onError: (error) => pushMutationError("bookkeeping.bulk.category", error),
      },
    );
  };

  const bulkDeleteTransactions = (ids: string[], onDone: () => void) => {
    if (ids.length === 0) return;
    bulkDelete.mutate(ids, {
      onSuccess: (results) => {
        const failed = results.filter((r) => !r.ok).length;
        if (failed > 0) {
          pushError(
            "bookkeeping.bulk.delete",
            `${results.length - failed}건 처리, ${failed}건 실패`,
          );
        } else {
          pushSuccess(`${ids.length}건 휴지통으로 이동했습니다`);
        }
        onDone();
      },
      onError: (error) => pushMutationError("bookkeeping.bulk.delete", error),
    });
  };

  const saveTransaction = (tx: BookkeepingTransaction, draft: TransactionEditDraft) => {
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      pushError("bookkeeping.edit", "금액을 확인하세요");
      return;
    }
    updateTx.mutate(
      {
        id: tx.id,
        merchant: draft.merchant,
        description: nullableText(draft.description),
        amountMinor: Math.round(amount),
        currency: draft.currency,
        spentAt: draft.spentAt,
        spentAtTime: nullableText(draft.spentAtTime),
        direction: draft.direction,
        note: nullableText(draft.note),
        account: nullableText(draft.account),
        categoryCode: nullableText(draft.categoryCode),
        subcategoryCode: nullableText(draft.subcategoryCode),
        paymentMethodKind: draft.paymentMethodKind,
        paymentMethodLabel: nullableText(draft.paymentMethodLabel),
        paymentMethodLast4: nullableText(draft.paymentMethodLast4),
        expenseKind: draft.expenseKind,
        orderNo: nullableText(draft.orderNo),
        paymentNo: nullableText(draft.paymentNo),
      },
      {
        onSuccess: () => pushSuccess("거래를 저장했습니다"),
        onError: (error) => pushMutationError("bookkeeping.edit", error),
      },
    );
  };

  const deleteTransaction = (tx: BookkeepingTransaction) => {
    deleteTx.mutate(tx.id, {
      onSuccess: () => pushSuccess("휴지통으로 이동했습니다"),
      onError: (error) => pushMutationError("bookkeeping.delete", error),
    });
  };

  const restoreTransaction = (tx: BookkeepingTransaction) => {
    if (tx.deletedAt) {
      restoreTx.mutate(tx.id, {
        onSuccess: () => pushSuccess("거래를 복원했습니다"),
        onError: (error) => pushMutationError("bookkeeping.restore", error),
      });
      return;
    }
    setReviewStatus(tx, "needs_review");
  };

  const confirmOccurrence = (occurrence: BookkeepingRecurringOccurrence) => {
    postRecurring.mutate(occurrence.id, {
      onSuccess: () => pushSuccess("고정비를 거래로 확정했습니다"),
      onError: (error) => pushMutationError("bookkeeping.recurring.post", error),
    });
  };

  const skipOccurrence = (occurrence: BookkeepingRecurringOccurrence) => {
    setRecurringStatus.mutate(
      { id: occurrence.id, status: "skipped" },
      {
        onSuccess: () => pushSuccess("이번 달 고정비를 건너뛰었습니다"),
        onError: (error) => pushMutationError("bookkeeping.recurring.skip", error),
      },
    );
  };

  return (
    <main className="bk-view">
      <div className="bk-shell">
        <header className="bk-page-head" aria-labelledby="bk-title">
          <div className="bk-heading">
            <SectionLabel>Bookkeeping</SectionLabel>
            <h1 id="bk-title" className="bk-title">
              가계부
            </h1>
          </div>
          <div className="bk-head-controls">
            <BookkeepingScopeControls
              month={month}
              projects={projectOptions}
              selectedProjectId={selectedProjectId}
              onProjectChange={(projectId) => dispatchScope({ type: "setProject", projectId })}
              onPreviousMonth={() => dispatchScope({ type: "stepMonth", months: -1 })}
              onNextMonth={() => dispatchScope({ type: "stepMonth", months: 1 })}
              onResetMonth={() => dispatchScope({ type: "resetMonth" })}
            />
            <BookkeepingExportControls
              disabled={exportPending}
              onExport={(format) => void exportBookkeeping(format)}
            />
          </div>
        </header>

        <BookkeepingMetrics
          totalExpenseMinor={summary.data?.totalExpenseMinor ?? 0}
          totalIncomeMinor={summary.data?.totalIncomeMinor ?? 0}
          netMinor={summary.data?.netMinor ?? 0}
          plannedTotal={plannedTotal}
          needsReviewCount={summary.data?.needsReviewCount ?? 0}
          approvedCount={summary.data?.approvedCount ?? 0}
        />

        <CurrencySummaryRows rows={summary.data?.byCurrency ?? []} />

        <ReportsSection cashflow={cashflow.data ?? []} categoryTrend={categoryTrend.data ?? []} />

        <div className="bk-layout">
          <section className="bk-main">
            <ReviewQueueCard
              key={`${month}:${activeProjectId ?? "all"}`}
              rows={reviewTransactions.data ?? []}
              order={reviewOrder}
              disabled={review.isPending || updateTx.isPending || deleteTx.isPending}
              bulkPending={bulkReview.isPending || bulkCategory.isPending || bulkDelete.isPending}
              onApprove={(tx) => setReviewStatus(tx, "approved")}
              onBulkReview={bulkSetReviewStatus}
              onBulkCategory={bulkSetCategory}
              onBulkDelete={bulkDeleteTransactions}
              onDelete={deleteTransaction}
              onSave={saveTransaction}
              onOrderChange={setReviewOrder}
            />

            <RecurringMonthCard
              rows={recurringOccurrences.data ?? []}
              ensurePending={ensureRecurring.isPending}
              actionPending={postRecurring.isPending || setRecurringStatus.isPending}
              onEnsure={() => ensureRecurring.mutate({ month, projectId: activeProjectId })}
              onConfirm={confirmOccurrence}
              onSkip={skipOccurrence}
            />

            <ApprovedTransactionsCard
              rows={approvedTransactions.data ?? []}
              disabled={updateTx.isPending || deleteTx.isPending}
              onDelete={deleteTransaction}
              onSave={saveTransaction}
            />

            <TrashTransactionsCard
              rows={trashTransactions.data ?? []}
              disabled={restoreTx.isPending || review.isPending}
              onRestore={restoreTransaction}
            />
          </section>

          <aside className="bk-side">
            {BOOKKEEPING_INPUT_PANEL_ORDER.map((panel) =>
              panel === "manual" ? (
                <ManualEntryCard
                  key={panel}
                  draft={manualDraft}
                  open={inputPanelsOpen.manual}
                  pending={createTx.isPending}
                  onDraftChange={setManualDraft}
                  onOpenChange={(open) => setInputPanelOpen({ panel: "manual", open })}
                  onSubmit={submitManual}
                />
              ) : (
                <RecurringExpenseFormCard
                  key={panel}
                  draft={recurringDraft}
                  open={inputPanelsOpen.recurring}
                  pending={createRecurring.isPending}
                  onDraftChange={setRecurringDraft}
                  onOpenChange={(open) => setInputPanelOpen({ panel: "recurring", open })}
                  onSubmit={submitRecurring}
                />
              ),
            )}

            <GmailSyncCard
              draft={gmailDraft}
              lastSyncHint={
                syncCursors.data?.find(
                  (cursor) => cursor.source === "gmail" && cursor.scopeKey === activeProjectId,
                )?.updatedAt ?? null
              }
              labels={gmailLabels.data ?? []}
              projectSelected={Boolean(activeProjectId)}
              pending={syncGmail.isPending}
              onDraftChange={setGmailDraft}
              onSubmit={submitGmailSync}
            />

            <BudgetCard
              draft={budgetDraft}
              statuses={budgetStatus.data ?? []}
              pending={setBudget.isPending}
              onDraftChange={setBudgetDraft}
              onSubmit={submitBudget}
            />

            <ReconciliationCard
              draft={reconciliationDraft}
              pending={reconcileAccount.isPending}
              result={reconcileAccount.data ?? null}
              onDraftChange={setReconciliationDraft}
              onSubmit={submitReconciliation}
            />

            <OperationsLogCard syncJobs={syncJobs.data ?? []} audit={audit.data ?? []} />

            <CategorySummaryCard
              rows={summary.data?.categories ?? []}
              recurringCount={recurringExpenses.data?.length ?? 0}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}
