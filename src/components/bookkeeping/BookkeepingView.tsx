import "./BookkeepingView.css";

import {
  AlertTriangle,
  Ban,
  CalendarCheck,
  Check,
  ChevronDown,
  ClipboardList,
  Landmark,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Tags,
  Trash2,
  WalletCards,
} from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
  useReducer,
  useRef,
  useState,
} from "react";

import type {
  BookkeepingAuditEntry,
  BookkeepingCategorySummary,
  BookkeepingDirection,
  BookkeepingExpenseKind,
  BookkeepingGmailLabel,
  BookkeepingLineItem,
  BookkeepingPaymentMethodKind,
  BookkeepingRecurringOccurrence,
  BookkeepingReviewStatus,
  BookkeepingSyncJob,
  BookkeepingTransaction,
  Project,
} from "@/bindings";
import { PeriodNavigator } from "@/components/PeriodNavigator";
import { formatMonthValue, stepMonthValue } from "@/components/periodNavigatorUtils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  IpcError,
  localToday,
  useBookkeepingAudit,
  useBookkeepingGmailLabels,
  useBookkeepingLineItems,
  useBookkeepingMonthlySummary,
  useBookkeepingRecurringExpenses,
  useBookkeepingRecurringOccurrences,
  useBookkeepingSyncJobs,
  useBookkeepingTaxonomy,
  useBookkeepingTransactions,
  useBookkeepingTrash,
  useCreateBookkeepingRecurringExpense,
  useCreateBookkeepingTransaction,
  useDeleteBookkeepingTransaction,
  useEnsureBookkeepingRecurringOccurrences,
  usePostBookkeepingRecurringOccurrence,
  useProjects,
  useRestoreBookkeepingTransaction,
  useSetBookkeepingLineItems,
  useSetBookkeepingRecurringOccurrenceStatus,
  useSyncBookkeepingGmailReceipts,
  useUpdateBookkeepingReviewStatus,
  useUpdateBookkeepingTransaction,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";

import { Field, SectionLabel } from "../settings/SettingsKit";
import { BOOKKEEPING_GMAIL_PERMISSION_COPY } from "./bookkeepingCopy";
import {
  BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  BOOKKEEPING_INPUT_PANEL_ORDER,
  type BookkeepingInputPanel,
} from "./bookkeepingPanels";
import {
  blankLineItemDraft,
  type LineItemDraft,
  lineItemDraftsFromServer,
  lineItemSumState,
  toLineItemInputs,
} from "./lineItems";

const CATEGORY_OPTIONS = ["food", "transport", "shopping", "housing", "health", "work", "misc"];
const ALL_PROJECTS = "__all__";

const PAYMENT_METHOD_OPTIONS: { value: BookkeepingPaymentMethodKind; label: string }[] = [
  { value: "unknown", label: "미정" },
  { value: "card", label: "카드" },
  { value: "bank_transfer", label: "계좌이체" },
  { value: "simple_pay", label: "간편결제" },
  { value: "cash", label: "현금" },
];

const EXPENSE_KIND_OPTIONS: { value: BookkeepingExpenseKind; label: string }[] = [
  { value: "variable", label: "변동비" },
  { value: "fixed", label: "고정비" },
  { value: "subscription", label: "구독" },
  { value: "installment", label: "할부" },
];

const RECURRING_EXPENSE_KIND_OPTIONS = EXPENSE_KIND_OPTIONS.filter(
  (option) => option.value !== "variable",
);

const FIELD_IDS = {
  projectScope: "bk-project-scope",
  gmailLabels: "bk-gmail-labels",
  gmailQuery: "bk-gmail-query",
  recurringName: "bk-recurring-name",
  recurringMerchant: "bk-recurring-merchant",
  recurringAmount: "bk-recurring-amount",
  recurringDay: "bk-recurring-day",
  recurringStart: "bk-recurring-start",
  recurringCategory: "bk-recurring-category",
  recurringPaymentKind: "bk-recurring-payment-kind",
  recurringPaymentLabel: "bk-recurring-payment-label",
  recurringPaymentLast4: "bk-recurring-payment-last4",
  recurringExpenseKind: "bk-recurring-expense-kind",
  recurringNote: "bk-recurring-note",
  recurringPanel: "bk-recurring-panel",
  merchant: "bk-manual-merchant",
  amount: "bk-manual-amount",
  spentAt: "bk-manual-spent-at",
  category: "bk-manual-category",
  paymentKind: "bk-manual-payment-kind",
  paymentLabel: "bk-manual-payment-label",
  paymentLast4: "bk-manual-payment-last4",
  expenseKind: "bk-manual-expense-kind",
  note: "bk-manual-note",
  manualPanel: "bk-manual-panel",
};

type ManualDraft = {
  merchant: string;
  amount: string;
  spentAt: string;
  category: string;
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
  expenseKind: BookkeepingExpenseKind;
  note: string;
};

type TransactionEditDraft = {
  merchant: string;
  amount: string;
  currency: string;
  spentAt: string;
  spentAtTime: string;
  direction: BookkeepingDirection;
  categoryCode: string;
  subcategoryCode: string;
  note: string;
  description: string;
  account: string;
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
  expenseKind: BookkeepingExpenseKind;
  orderNo: string;
  paymentNo: string;
};

type RecurringDraft = {
  name: string;
  merchant: string;
  amount: string;
  scheduleDay: string;
  startMonth: string;
  category: string;
  paymentMethodKind: BookkeepingPaymentMethodKind;
  paymentMethodLabel: string;
  paymentMethodLast4: string;
  expenseKind: BookkeepingExpenseKind;
  note: string;
};

type InputPanelAction = {
  panel: BookkeepingInputPanel;
  open: boolean;
};

type BookkeepingScopeState = {
  month: string;
  projectId: string;
};

type BookkeepingScopeAction =
  | { type: "setProject"; projectId: string }
  | { type: "stepMonth"; months: -1 | 1 }
  | { type: "resetMonth" };

function initialBookkeepingScope(): BookkeepingScopeState {
  return {
    month: currentMonth(),
    projectId: ALL_PROJECTS,
  };
}

function bookkeepingScopeReducer(
  current: BookkeepingScopeState,
  action: BookkeepingScopeAction,
): BookkeepingScopeState {
  if (action.type === "setProject") {
    if (current.projectId === action.projectId) {
      return current;
    }
    return { ...current, projectId: action.projectId };
  }
  if (action.type === "stepMonth") {
    return { ...current, month: stepMonthValue(current.month, action.months) };
  }
  return { ...current, month: currentMonth() };
}

function inputPanelsReducer(
  current: Record<BookkeepingInputPanel, boolean>,
  action: InputPanelAction,
): Record<BookkeepingInputPanel, boolean> {
  if (current[action.panel] === action.open) {
    return current;
  }
  return { ...current, [action.panel]: action.open };
}

type GmailSyncDraft = {
  labels: string;
  query: string;
};

const currency = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

function currentMonth() {
  return localToday().slice(0, 7);
}

function emptyManualDraft(): ManualDraft {
  return {
    merchant: "",
    amount: "",
    spentAt: localToday(),
    category: "food",
    paymentMethodKind: "unknown",
    paymentMethodLabel: "",
    paymentMethodLast4: "",
    expenseKind: "variable",
    note: "",
  };
}

function emptyRecurringDraft(): RecurringDraft {
  return {
    name: "",
    merchant: "",
    amount: "",
    scheduleDay: "1",
    startMonth: currentMonth(),
    category: "housing",
    paymentMethodKind: "bank_transfer",
    paymentMethodLabel: "",
    paymentMethodLast4: "",
    expenseKind: "fixed",
    note: "",
  };
}

function emptyGmailSyncDraft(): GmailSyncDraft {
  return {
    labels: "가계부",
    query: "newer_than:90d",
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

function syncStatusLabel(status: string) {
  return status === "succeeded" ? "완료" : "실패";
}

function directionLabel(direction: string) {
  return direction === "income" ? "수입" : "지출";
}

/// review_reasons_json(raw JSON 배열)에서 코드만 안전하게 추출. 파싱 실패 시 빈 배열.
function reviewReasonCodes(reviewReasonsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(reviewReasonsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) =>
        r && typeof r === "object" && "code" in r ? String((r as { code: unknown }).code) : null,
      )
      .filter((c): c is string => Boolean(c));
  } catch {
    return [];
  }
}

function expenseKindLabel(kind: BookkeepingExpenseKind) {
  return EXPENSE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function paymentMethodLabel(kind: BookkeepingPaymentMethodKind) {
  return PAYMENT_METHOD_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function occurrenceStatusLabel(status: string) {
  if (status === "posted") return "확정";
  if (status === "skipped") return "건너뜀";
  return "예정";
}

function splitCsv(value: string) {
  return value.split(",").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}

function appendCsvToken(value: string, token: string) {
  const items = splitCsv(value);
  if (!items.includes(token)) items.push(token);
  return items.join(", ");
}

function nullableText(value: string) {
  return value.trim() || null;
}

function editDraftFromTransaction(tx: BookkeepingTransaction): TransactionEditDraft {
  return {
    merchant: tx.merchant,
    amount: String(tx.amountMinor),
    currency: tx.currency,
    spentAt: tx.spentAt,
    spentAtTime: tx.spentAtTime ?? "",
    direction: tx.direction,
    categoryCode: tx.categoryCode ?? tx.category,
    subcategoryCode: tx.subcategoryCode ?? "",
    note: tx.note ?? "",
    description: tx.description ?? "",
    account: tx.account ?? "",
    paymentMethodKind: tx.paymentMethodKind,
    paymentMethodLabel: tx.paymentMethodLabel ?? "",
    paymentMethodLast4: tx.paymentMethodLast4 ?? "",
    expenseKind: tx.expenseKind,
    orderNo: tx.orderNo ?? "",
    paymentNo: tx.paymentNo ?? "",
  };
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
  const [scope, dispatchScope] = useReducer(
    bookkeepingScopeReducer,
    undefined,
    initialBookkeepingScope,
  );
  const [manualDraft, setManualDraft] = useState<ManualDraft>(() => emptyManualDraft());
  const [recurringDraft, setRecurringDraft] = useState<RecurringDraft>(() => emptyRecurringDraft());
  const [inputPanelsOpen, setInputPanelOpen] = useReducer(inputPanelsReducer, {
    ...BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  });
  const [gmailDraft, setGmailDraft] = useState<GmailSyncDraft>(() => emptyGmailSyncDraft());

  const projects = useProjects();
  const { month, projectId: projectScopeId } = scope;
  const projectOptions = projects.data ?? [];
  const selectedProjectId =
    projectScopeId === ALL_PROJECTS ||
    projectOptions.some((project) => project.id === projectScopeId)
      ? projectScopeId
      : ALL_PROJECTS;
  const activeProjectId = selectedProjectId === ALL_PROJECTS ? null : selectedProjectId;
  const gmailLabels = useBookkeepingGmailLabels(activeProjectId);
  const reviewTransactions = useBookkeepingTransactions("needs_review", activeProjectId);
  const approvedTransactions = useBookkeepingTransactions("approved", activeProjectId);
  const trashTransactions = useBookkeepingTrash(activeProjectId);
  const summary = useBookkeepingMonthlySummary(month, activeProjectId);
  const audit = useBookkeepingAudit(null);
  const syncJobs = useBookkeepingSyncJobs();
  const recurringExpenses = useBookkeepingRecurringExpenses(activeProjectId);
  const recurringOccurrences = useBookkeepingRecurringOccurrences(month, activeProjectId);
  const createTx = useCreateBookkeepingTransaction();
  const createRecurring = useCreateBookkeepingRecurringExpense();
  const ensureRecurring = useEnsureBookkeepingRecurringOccurrences();
  const postRecurring = usePostBookkeepingRecurringOccurrence();
  const setRecurringStatus = useSetBookkeepingRecurringOccurrenceStatus();
  const syncGmail = useSyncBookkeepingGmailReceipts();
  const review = useUpdateBookkeepingReviewStatus();
  const updateTx = useUpdateBookkeepingTransaction();
  const deleteTx = useDeleteBookkeepingTransaction();
  const restoreTx = useRestoreBookkeepingTransaction();
  const pushSuccess = useToastStore((s) => s.pushSuccess);
  const pushError = useToastStore((s) => s.pushError);

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
        query: query || null,
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
          <BookkeepingScopeControls
            month={month}
            projects={projectOptions}
            selectedProjectId={selectedProjectId}
            onProjectChange={(projectId) => dispatchScope({ type: "setProject", projectId })}
            onPreviousMonth={() => dispatchScope({ type: "stepMonth", months: -1 })}
            onNextMonth={() => dispatchScope({ type: "stepMonth", months: 1 })}
            onResetMonth={() => dispatchScope({ type: "resetMonth" })}
          />
        </header>

        <BookkeepingMetrics
          totalExpenseMinor={summary.data?.totalExpenseMinor ?? 0}
          totalIncomeMinor={summary.data?.totalIncomeMinor ?? 0}
          netMinor={summary.data?.netMinor ?? 0}
          plannedTotal={plannedTotal}
          needsReviewCount={summary.data?.needsReviewCount ?? 0}
          approvedCount={summary.data?.approvedCount ?? 0}
        />

        <div className="bk-layout">
          <section className="bk-main">
            <ReviewQueueCard
              rows={reviewTransactions.data ?? []}
              disabled={review.isPending || updateTx.isPending || deleteTx.isPending}
              onApprove={(tx) => setReviewStatus(tx, "approved")}
              onDelete={deleteTransaction}
              onSave={saveTransaction}
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
              labels={gmailLabels.data ?? []}
              projectSelected={Boolean(activeProjectId)}
              pending={syncGmail.isPending}
              onDraftChange={setGmailDraft}
              onSubmit={submitGmailSync}
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

function CollapsibleInputCard({
  title,
  description,
  icon,
  open,
  contentId,
  children,
  onOpenChange,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  open: boolean;
  contentId: string;
  children: ReactNode;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Card className="bk-card bk-collapsible-card" data-state={open ? "open" : "closed"}>
      <CardHeader className="bk-card-header-row bk-collapsible-header">
        <div className="bk-collapsible-heading">
          <CardTitle className="bk-card-title">
            {icon}
            {title}
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="bk-collapse-trigger"
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`${title} ${open ? "접기" : "펼치기"}`}
          onClick={() => onOpenChange(!open)}
        >
          <ChevronDown className="bk-collapse-chevron size-4" aria-hidden="true" />
        </Button>
      </CardHeader>
      <div
        id={contentId}
        className="bk-collapsible-region"
        data-state={open ? "open" : "closed"}
        aria-hidden={!open}
      >
        <div className="bk-collapsible-inner">{children}</div>
      </div>
    </Card>
  );
}

function BookkeepingMetrics({
  totalExpenseMinor,
  totalIncomeMinor,
  netMinor,
  plannedTotal,
  needsReviewCount,
  approvedCount,
}: {
  totalExpenseMinor: number;
  totalIncomeMinor: number;
  netMinor: number;
  plannedTotal: number;
  needsReviewCount: number;
  approvedCount: number;
}) {
  return (
    <section className="bk-metrics" aria-label="월별 요약">
      <Metric label="지출 합계" value={currency.format(totalExpenseMinor)} />
      <Metric label="수입 합계" value={currency.format(totalIncomeMinor)} />
      <Metric label="순액" value={currency.format(netMinor)} />
      <Metric label="예정 고정비" value={currency.format(plannedTotal)} />
      <Metric label="리뷰 대기" value={String(needsReviewCount)} />
      <Metric label="승인" value={String(approvedCount)} />
    </section>
  );
}

function BookkeepingScopeControls({
  month,
  projects,
  selectedProjectId,
  onProjectChange,
  onPreviousMonth,
  onNextMonth,
  onResetMonth,
}: {
  month: string;
  projects: Project[];
  selectedProjectId: string;
  onProjectChange: (projectId: string) => void;
  onPreviousMonth: () => void;
  onNextMonth: () => void;
  onResetMonth: () => void;
}) {
  return (
    <div className="bk-scope-controls">
      <PeriodNavigator
        label="기준 연월"
        valueLabel={formatMonthValue(month)}
        previousLabel="이전 달"
        nextLabel="다음 달"
        resetLabel="이번 달로 이동"
        resetDisabled={month === currentMonth()}
        onPrevious={onPreviousMonth}
        onNext={onNextMonth}
        onReset={onResetMonth}
      />
      <Field label="프로젝트" htmlFor={FIELD_IDS.projectScope}>
        <Select value={selectedProjectId} onValueChange={onProjectChange}>
          <SelectTrigger id={FIELD_IDS.projectScope}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>전체 프로젝트</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

function ReviewQueueCard({
  rows,
  disabled,
  onApprove,
  onDelete,
  onSave,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onApprove: (tx: BookkeepingTransaction) => void;
  onDelete: (tx: BookkeepingTransaction) => void;
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => void;
}) {
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
        <Badge variant="secondary">{rows.length}</Badge>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>대기 중인 거래 없음</EmptyState>}
          {rows.map((tx) => (
            <TransactionEditForm
              key={tx.id}
              tx={tx}
              disabled={disabled}
              approveLabel="확정"
              onApprove={() => onApprove(tx)}
              onDelete={() => onDelete(tx)}
              onSave={(draft) => onSave(tx, draft)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RecurringMonthCard({
  rows,
  ensurePending,
  actionPending,
  onEnsure,
  onConfirm,
  onSkip,
}: {
  rows: BookkeepingRecurringOccurrence[];
  ensurePending: boolean;
  actionPending: boolean;
  onEnsure: () => void;
  onConfirm: (occurrence: BookkeepingRecurringOccurrence) => void;
  onSkip: (occurrence: BookkeepingRecurringOccurrence) => void;
}) {
  return (
    <Card className="bk-card">
      <CardHeader className="bk-card-header-row">
        <div>
          <CardTitle className="bk-card-title">
            <CalendarCheck className="size-4" />
            이번 달 고정비
          </CardTitle>
          <CardDescription>
            메일로 관측되지 않는 지출은 예정 건으로 만든 뒤 거래로 확정합니다.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onEnsure} disabled={ensurePending}>
          <RefreshCw className="size-3.5" />월 예정 반영
        </Button>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>예정 고정비 없음</EmptyState>}
          {rows.map((occurrence) => (
            <RecurringOccurrenceRow
              key={occurrence.id}
              occurrence={occurrence}
              disabled={actionPending}
              onConfirm={() => onConfirm(occurrence)}
              onSkip={() => onSkip(occurrence)}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ApprovedTransactionsCard({
  rows,
  disabled,
  onDelete,
  onSave,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onDelete: (tx: BookkeepingTransaction) => void;
  onSave: (tx: BookkeepingTransaction, draft: TransactionEditDraft) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          확정 거래
        </CardTitle>
        <CardDescription>
          최근 원장 거래입니다. 펼치면 전체 필드를 수정할 수 있습니다.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
          {rows
            .slice(0, 12)
            .map((tx) =>
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
                />
              ),
            )}
        </div>
      </CardContent>
    </Card>
  );
}

function TrashTransactionsCard({
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
          <CardDescription>삭제된 거래와 중복·무시 항목을 복원합니다.</CardDescription>
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
          <CardContent>
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

function RecurringExpenseFormCard({
  draft,
  open,
  pending,
  onDraftChange,
  onOpenChange,
  onSubmit,
}: {
  draft: RecurringDraft;
  open: boolean;
  pending: boolean;
  onDraftChange: Dispatch<SetStateAction<RecurringDraft>>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <CollapsibleInputCard
      title="고정비 입력"
      description="월세, 보험료, 구독처럼 메일에서 안 잡히는 지출입니다."
      icon={<Landmark className="size-4" />}
      open={open}
      contentId={FIELD_IDS.recurringPanel}
      onOpenChange={onOpenChange}
    >
      <CardContent>
        <form className="bk-form" onSubmit={onSubmit}>
          <Field label="이름" htmlFor={FIELD_IDS.recurringName}>
            <Input
              id={FIELD_IDS.recurringName}
              value={draft.name}
              onChange={(e) => onDraftChange((current) => ({ ...current, name: e.target.value }))}
              required
            />
          </Field>
          <Field label="가맹점/상대" htmlFor={FIELD_IDS.recurringMerchant}>
            <Input
              id={FIELD_IDS.recurringMerchant}
              value={draft.merchant}
              onChange={(e) =>
                onDraftChange((current) => ({ ...current, merchant: e.target.value }))
              }
            />
          </Field>
          <div className="bk-form-grid">
            <Field label="금액" htmlFor={FIELD_IDS.recurringAmount}>
              <Input
                id={FIELD_IDS.recurringAmount}
                type="number"
                min="1"
                inputMode="numeric"
                value={draft.amount}
                onChange={(e) =>
                  onDraftChange((current) => ({ ...current, amount: e.target.value }))
                }
                required
              />
            </Field>
            <Field label="결제일" htmlFor={FIELD_IDS.recurringDay}>
              <Input
                id={FIELD_IDS.recurringDay}
                type="number"
                min="1"
                max="31"
                inputMode="numeric"
                value={draft.scheduleDay}
                onChange={(e) =>
                  onDraftChange((current) => ({ ...current, scheduleDay: e.target.value }))
                }
                required
              />
            </Field>
          </div>
          <div className="bk-form-grid">
            <Field label="시작 월" htmlFor={FIELD_IDS.recurringStart}>
              <Input
                id={FIELD_IDS.recurringStart}
                type="month"
                value={draft.startMonth}
                onChange={(e) =>
                  onDraftChange((current) => ({
                    ...current,
                    startMonth: e.target.value || currentMonth(),
                  }))
                }
              />
            </Field>
            <Field label="종류" htmlFor={FIELD_IDS.recurringExpenseKind}>
              <Select
                value={draft.expenseKind}
                onValueChange={(value) =>
                  onDraftChange((current) => ({
                    ...current,
                    expenseKind: value as BookkeepingExpenseKind,
                  }))
                }
              >
                <SelectTrigger id={FIELD_IDS.recurringExpenseKind}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRING_EXPENSE_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="카테고리" htmlFor={FIELD_IDS.recurringCategory}>
            <CategorySelect
              id={FIELD_IDS.recurringCategory}
              value={draft.category}
              onValueChange={(category) => onDraftChange((current) => ({ ...current, category }))}
            />
          </Field>
          <PaymentFields
            kindId={FIELD_IDS.recurringPaymentKind}
            labelId={FIELD_IDS.recurringPaymentLabel}
            last4Id={FIELD_IDS.recurringPaymentLast4}
            kind={draft.paymentMethodKind}
            label={draft.paymentMethodLabel}
            last4={draft.paymentMethodLast4}
            onKindChange={(paymentMethodKind) =>
              onDraftChange((current) => ({ ...current, paymentMethodKind }))
            }
            onLabelChange={(paymentMethodLabel) =>
              onDraftChange((current) => ({ ...current, paymentMethodLabel }))
            }
            onLast4Change={(paymentMethodLast4) =>
              onDraftChange((current) => ({ ...current, paymentMethodLast4 }))
            }
          />
          <Field label="메모" htmlFor={FIELD_IDS.recurringNote}>
            <Textarea
              id={FIELD_IDS.recurringNote}
              value={draft.note}
              onChange={(e) => onDraftChange((current) => ({ ...current, note: e.target.value }))}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" />
            고정비 추가
          </Button>
        </form>
      </CardContent>
    </CollapsibleInputCard>
  );
}

function ManualEntryCard({
  draft,
  open,
  pending,
  onDraftChange,
  onOpenChange,
  onSubmit,
}: {
  draft: ManualDraft;
  open: boolean;
  pending: boolean;
  onDraftChange: Dispatch<SetStateAction<ManualDraft>>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <CollapsibleInputCard
      title="수동 입력"
      icon={<WalletCards className="size-4" />}
      open={open}
      contentId={FIELD_IDS.manualPanel}
      onOpenChange={onOpenChange}
    >
      <CardContent>
        <form className="bk-form" onSubmit={onSubmit}>
          <Field label="상점" htmlFor={FIELD_IDS.merchant}>
            <Input
              id={FIELD_IDS.merchant}
              value={draft.merchant}
              onChange={(e) =>
                onDraftChange((current) => ({ ...current, merchant: e.target.value }))
              }
              required
            />
          </Field>
          <div className="bk-form-grid">
            <Field label="금액" htmlFor={FIELD_IDS.amount}>
              <Input
                id={FIELD_IDS.amount}
                type="number"
                min="1"
                inputMode="numeric"
                value={draft.amount}
                onChange={(e) =>
                  onDraftChange((current) => ({ ...current, amount: e.target.value }))
                }
                required
              />
            </Field>
            <Field label="날짜" htmlFor={FIELD_IDS.spentAt}>
              <Input
                id={FIELD_IDS.spentAt}
                type="date"
                value={draft.spentAt}
                onChange={(e) =>
                  onDraftChange((current) => ({ ...current, spentAt: e.target.value }))
                }
                required
              />
            </Field>
          </div>
          <div className="bk-form-grid">
            <Field label="카테고리" htmlFor={FIELD_IDS.category}>
              <CategorySelect
                id={FIELD_IDS.category}
                value={draft.category}
                onValueChange={(category) => onDraftChange((current) => ({ ...current, category }))}
              />
            </Field>
            <Field label="종류" htmlFor={FIELD_IDS.expenseKind}>
              <Select
                value={draft.expenseKind}
                onValueChange={(value) =>
                  onDraftChange((current) => ({
                    ...current,
                    expenseKind: value as BookkeepingExpenseKind,
                  }))
                }
              >
                <SelectTrigger id={FIELD_IDS.expenseKind}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPENSE_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <PaymentFields
            kindId={FIELD_IDS.paymentKind}
            labelId={FIELD_IDS.paymentLabel}
            last4Id={FIELD_IDS.paymentLast4}
            kind={draft.paymentMethodKind}
            label={draft.paymentMethodLabel}
            last4={draft.paymentMethodLast4}
            onKindChange={(paymentMethodKind) =>
              onDraftChange((current) => ({ ...current, paymentMethodKind }))
            }
            onLabelChange={(paymentMethodLabel) =>
              onDraftChange((current) => ({ ...current, paymentMethodLabel }))
            }
            onLast4Change={(paymentMethodLast4) =>
              onDraftChange((current) => ({ ...current, paymentMethodLast4 }))
            }
          />
          <Field label="메모" htmlFor={FIELD_IDS.note}>
            <Textarea
              id={FIELD_IDS.note}
              value={draft.note}
              onChange={(e) => onDraftChange((current) => ({ ...current, note: e.target.value }))}
            />
          </Field>
          <Button type="submit" disabled={pending}>
            <Plus className="size-4" />
            거래 추가
          </Button>
        </form>
      </CardContent>
    </CollapsibleInputCard>
  );
}

function GmailSyncCard({
  draft,
  labels,
  projectSelected,
  pending,
  onDraftChange,
  onSubmit,
}: {
  draft: GmailSyncDraft;
  labels: BookkeepingGmailLabel[];
  projectSelected: boolean;
  pending: boolean;
  onDraftChange: Dispatch<SetStateAction<GmailSyncDraft>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <RefreshCw className="size-4" />
          Gmail
        </CardTitle>
        <CardDescription>{BOOKKEEPING_GMAIL_PERMISSION_COPY}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="bk-form" onSubmit={onSubmit}>
          <Field label="Gmail 라벨" htmlFor={FIELD_IDS.gmailLabels}>
            <Input
              id={FIELD_IDS.gmailLabels}
              value={draft.labels}
              onChange={(e) => onDraftChange((current) => ({ ...current, labels: e.target.value }))}
              placeholder="가계부, 영수증"
            />
          </Field>
          <Field label="검색어" htmlFor={FIELD_IDS.gmailQuery}>
            <Input
              id={FIELD_IDS.gmailQuery}
              value={draft.query}
              onChange={(e) => onDraftChange((current) => ({ ...current, query: e.target.value }))}
              placeholder="newer_than:90d"
            />
          </Field>
          {labels.length > 0 && (
            <div className="bk-label-chips" aria-label="Gmail labels">
              {labels.slice(0, 8).map((label) => (
                <button
                  key={label.id}
                  type="button"
                  className="bk-label-chip typo-caption-sm"
                  onClick={() =>
                    onDraftChange((current) => ({
                      ...current,
                      labels: appendCsvToken(current.labels, label.name),
                    }))
                  }
                >
                  <Tags className="size-3" />
                  {label.name}
                </button>
              ))}
            </div>
          )}
          <Button type="submit" disabled={pending || !projectSelected}>
            <RefreshCw className="size-4" />
            Gmail 동기화
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function OperationsLogCard({
  syncJobs,
  audit,
}: {
  syncJobs: BookkeepingSyncJob[];
  audit: BookkeepingAuditEntry[];
}) {
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <ShieldAlert className="size-4" />
          운영 기록
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bk-side-list">
          {syncJobs.slice(0, 4).map((job) => (
            <div key={job.id} className="bk-log-row">
              <span className="typo-body-strong">
                {sourceLabel(job.source)} {syncStatusLabel(job.status)}
              </span>
              <span className="text-muted-foreground typo-caption-sm">
                {job.sanitizedErrorMessage ??
                  (job.status === "succeeded" ? "동기화 완료" : "동기화 실패")}
              </span>
            </div>
          ))}
          {audit.slice(0, 4).map((entry) => (
            <div key={entry.id} className="bk-log-row">
              <span className="typo-body-strong">{entry.action}</span>
              <span className="text-muted-foreground typo-caption-sm">{entry.summary}</span>
            </div>
          ))}
          {syncJobs.length === 0 && audit.length === 0 && <EmptyState>기록 없음</EmptyState>}
        </div>
      </CardContent>
    </Card>
  );
}

function CategorySummaryCard({
  rows,
  recurringCount,
}: {
  rows: BookkeepingCategorySummary[];
  recurringCount: number;
}) {
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          카테고리
        </CardTitle>
        <CardDescription>등록된 고정비 {recurringCount}개</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="bk-category-list">
          {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
          {rows.map((row) => (
            <div key={row.category} className="bk-category-row typo-body-md">
              <span>{row.category}</span>
              <span>{currency.format(row.amountMinor)}</span>
              <Badge variant="outline">{row.count}</Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bk-metric">
      <span className="text-muted-foreground typo-caption-sm">{label}</span>
      <strong className="typo-title-md">{value}</strong>
    </div>
  );
}

function CategorySelect({
  id,
  value,
  onValueChange,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  const taxonomy = useBookkeepingTaxonomy();
  // Top-level taxonomy categories (code → Korean label). Falls back to the legacy codes until the
  // seeded taxonomy loads; the selected `value` always stays a stable code.
  const options =
    taxonomy.data
      ?.filter((node) => node.parentCode === null)
      .map((node) => ({ value: node.code, label: node.label })) ?? [];
  const fallback = CATEGORY_OPTIONS.map((code) => ({ value: code, label: code }));
  const merged = options.length > 0 ? options : fallback;
  // Ensure the current value is always selectable even if it isn't a current top-level code.
  const items = merged.some((o) => o.value === value)
    ? merged
    : [...merged, { value, label: value }];
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PaymentFields({
  kindId,
  labelId,
  last4Id,
  kind,
  label,
  last4,
  onKindChange,
  onLabelChange,
  onLast4Change,
}: {
  kindId: string;
  labelId: string;
  last4Id: string;
  kind: BookkeepingPaymentMethodKind;
  label: string;
  last4: string;
  onKindChange: (value: BookkeepingPaymentMethodKind) => void;
  onLabelChange: (value: string) => void;
  onLast4Change: (value: string) => void;
}) {
  return (
    <div className="bk-payment-fields">
      <Field label="결제수단" htmlFor={kindId}>
        <Select
          value={kind}
          onValueChange={(value) => onKindChange(value as BookkeepingPaymentMethodKind)}
        >
          <SelectTrigger id={kindId}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHOD_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="표시명" htmlFor={labelId}>
        <Input id={labelId} value={label} onChange={(e) => onLabelChange(e.target.value)} />
      </Field>
      <Field label="끝자리" htmlFor={last4Id}>
        <Input
          id={last4Id}
          value={last4}
          onChange={(e) => onLast4Change(e.target.value)}
          inputMode="numeric"
        />
      </Field>
    </div>
  );
}

function EmptyState({ children }: { children: string }) {
  return <div className="bk-empty typo-body-md">{children}</div>;
}

function TransactionEditForm({
  tx,
  disabled,
  approveLabel,
  onApprove,
  onDelete,
  onSave,
  onCancel,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  approveLabel?: string;
  onApprove?: () => void;
  onDelete: () => void;
  onSave: (draft: TransactionEditDraft) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(() => editDraftFromTransaction(tx));
  const fieldPrefix = `bk-edit-${tx.id}`;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(draft);
  };

  return (
    <article className="bk-row bk-transaction bk-transaction-edit" data-status={tx.reviewStatus}>
      <form className="bk-edit-form" onSubmit={submit}>
        <div className="bk-edit-head">
          <div className="bk-row-title">
            <strong className="typo-body-strong">{tx.merchant}</strong>
            <span className="text-muted-foreground typo-caption-sm">
              {tx.source !== "manual" && tx.sourceRef
                ? `${sourceLabel(tx.source)} · ${tx.sourceRef}`
                : sourceLabel(tx.source)}
            </span>
          </div>
          <div className="bk-row-amount typo-title-sm">{currency.format(tx.amountMinor)}</div>
        </div>

        <div className="bk-edit-grid">
          <Field label="가맹점" htmlFor={`${fieldPrefix}-merchant`}>
            <Input
              id={`${fieldPrefix}-merchant`}
              value={draft.merchant}
              onChange={(e) => setDraft((current) => ({ ...current, merchant: e.target.value }))}
              required
            />
          </Field>
          <div className="bk-form-grid">
            <Field label="금액" htmlFor={`${fieldPrefix}-amount`}>
              <Input
                id={`${fieldPrefix}-amount`}
                value={draft.amount}
                onChange={(e) => setDraft((current) => ({ ...current, amount: e.target.value }))}
                inputMode="numeric"
                required
              />
            </Field>
            <Field label="통화" htmlFor={`${fieldPrefix}-currency`}>
              <Input
                id={`${fieldPrefix}-currency`}
                value={draft.currency}
                onChange={(e) =>
                  setDraft((current) => ({ ...current, currency: e.target.value.toUpperCase() }))
                }
                maxLength={3}
                required
              />
            </Field>
          </div>
          <div className="bk-form-grid">
            <Field label="날짜" htmlFor={`${fieldPrefix}-spent-at`}>
              <Input
                id={`${fieldPrefix}-spent-at`}
                type="date"
                value={draft.spentAt}
                onChange={(e) => setDraft((current) => ({ ...current, spentAt: e.target.value }))}
                required
              />
            </Field>
            <Field label="시각" htmlFor={`${fieldPrefix}-spent-time`}>
              <Input
                id={`${fieldPrefix}-spent-time`}
                value={draft.spentAtTime}
                onChange={(e) =>
                  setDraft((current) => ({ ...current, spentAtTime: e.target.value }))
                }
                placeholder="HH:MM:SS"
              />
            </Field>
          </div>
          <Field label="수입/지출" htmlFor={`${fieldPrefix}-direction`}>
            <div id={`${fieldPrefix}-direction`} className="bk-segmented" role="group">
              <Button
                type="button"
                size="sm"
                variant={draft.direction === "expense" ? "default" : "outline"}
                aria-pressed={draft.direction === "expense"}
                onClick={() => setDraft((current) => ({ ...current, direction: "expense" }))}
              >
                지출
              </Button>
              <Button
                type="button"
                size="sm"
                variant={draft.direction === "income" ? "default" : "outline"}
                aria-pressed={draft.direction === "income"}
                onClick={() => setDraft((current) => ({ ...current, direction: "income" }))}
              >
                수입
              </Button>
            </div>
          </Field>
          <TaxonomyEditFields
            prefix={fieldPrefix}
            categoryCode={draft.categoryCode}
            subcategoryCode={draft.subcategoryCode}
            onCategoryChange={(categoryCode) =>
              setDraft((current) => ({ ...current, categoryCode, subcategoryCode: "" }))
            }
            onSubcategoryChange={(subcategoryCode) =>
              setDraft((current) => ({ ...current, subcategoryCode }))
            }
          />
          <Field label="메모" htmlFor={`${fieldPrefix}-note`}>
            <Textarea
              id={`${fieldPrefix}-note`}
              value={draft.note}
              onChange={(e) => setDraft((current) => ({ ...current, note: e.target.value }))}
              rows={2}
            />
          </Field>
          <Field label="내용/설명" htmlFor={`${fieldPrefix}-description`}>
            <Textarea
              id={`${fieldPrefix}-description`}
              value={draft.description}
              onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))}
              rows={2}
            />
          </Field>
          <Field label="자산" htmlFor={`${fieldPrefix}-account`}>
            <Input
              id={`${fieldPrefix}-account`}
              value={draft.account}
              onChange={(e) => setDraft((current) => ({ ...current, account: e.target.value }))}
            />
          </Field>
          <PaymentFields
            kindId={`${fieldPrefix}-payment-kind`}
            labelId={`${fieldPrefix}-payment-label`}
            last4Id={`${fieldPrefix}-payment-last4`}
            kind={draft.paymentMethodKind}
            label={draft.paymentMethodLabel}
            last4={draft.paymentMethodLast4}
            onKindChange={(paymentMethodKind) =>
              setDraft((current) => ({ ...current, paymentMethodKind }))
            }
            onLabelChange={(paymentMethodLabel) =>
              setDraft((current) => ({ ...current, paymentMethodLabel }))
            }
            onLast4Change={(paymentMethodLast4) =>
              setDraft((current) => ({ ...current, paymentMethodLast4 }))
            }
          />
          <Field label="비용유형" htmlFor={`${fieldPrefix}-expense-kind`}>
            <Select
              value={draft.expenseKind}
              onValueChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  expenseKind: value as BookkeepingExpenseKind,
                }))
              }
            >
              <SelectTrigger id={`${fieldPrefix}-expense-kind`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_KIND_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="bk-form-grid">
            <Field label="주문번호" htmlFor={`${fieldPrefix}-order-no`}>
              <Input
                id={`${fieldPrefix}-order-no`}
                value={draft.orderNo}
                onChange={(e) => setDraft((current) => ({ ...current, orderNo: e.target.value }))}
              />
            </Field>
            <Field label="결제번호" htmlFor={`${fieldPrefix}-payment-no`}>
              <Input
                id={`${fieldPrefix}-payment-no`}
                value={draft.paymentNo}
                onChange={(e) => setDraft((current) => ({ ...current, paymentNo: e.target.value }))}
              />
            </Field>
          </div>
        </div>

        <LineItemEditor transactionId={tx.id} amountMinor={tx.amountMinor} disabled={disabled} />

        <TransactionMetadata tx={tx} />

        <div className="bk-row-actions">
          <Button type="submit" size="sm" disabled={disabled}>
            저장
          </Button>
          {onApprove && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onApprove}
            >
              <Check className="size-3.5" />
              {approveLabel ?? "확정"}
            </Button>
          )}
          {onCancel && (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
              접기
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
            <Trash2 className="size-3.5" />
            삭제
          </Button>
        </div>
      </form>
    </article>
  );
}

function LineItemEditor({
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

function LineItemEditorForm({
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
              <Field label="금액" htmlFor={`${prefix}-${row.key}-amount`}>
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

function TransactionReadRow({
  tx,
  disabled,
  onEdit,
  onDelete,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="bk-row bk-transaction" data-status={tx.reviewStatus}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{tx.merchant}</strong>
          {tx.description && (
            <span className="text-muted-foreground typo-caption-sm">{tx.description}</span>
          )}
        </div>
        <TransactionMetadata tx={tx} compact />
      </div>
      <div className="bk-row-amount typo-title-sm">{currency.format(tx.amountMinor)}</div>
      <div className="bk-row-actions">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onEdit}>
          편집
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onDelete}>
          <Trash2 className="size-3.5" />
          삭제
        </Button>
      </div>
    </article>
  );
}

function TrashTransactionRow({
  tx,
  disabled,
  onRestore,
}: {
  tx: BookkeepingTransaction;
  disabled: boolean;
  onRestore: () => void;
}) {
  const reason = tx.deletedAt ? "삭제됨" : "중복·무시";
  return (
    <article className="bk-row bk-transaction" data-status={tx.reviewStatus}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{tx.merchant}</strong>
          {tx.description && (
            <span className="text-muted-foreground typo-caption-sm">{tx.description}</span>
          )}
        </div>
        <div className="bk-row-meta typo-caption-sm">
          <Badge variant={tx.deletedAt ? "destructive" : "secondary"}>{reason}</Badge>
          <span>{tx.spentAt}</span>
          <span>{currency.format(tx.amountMinor)}</span>
          <Badge variant="outline">{sourceLabel(tx.source)}</Badge>
          {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
        </div>
      </div>
      <div className="bk-row-actions">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRestore}>
          <RotateCcw className="size-3.5" />
          복원
        </Button>
      </div>
    </article>
  );
}

function TransactionMetadata({
  tx,
  compact = false,
}: {
  tx: BookkeepingTransaction;
  compact?: boolean;
}) {
  const reasons = reviewReasonCodes(tx.reviewReasonsJson);
  return (
    <>
      <div className="bk-row-meta typo-caption-sm">
        <span>
          {tx.spentAt}
          {tx.spentAtTime ? ` ${tx.spentAtTime}` : ""}
        </span>
        <Badge variant={tx.direction === "income" ? "secondary" : "outline"}>
          {directionLabel(tx.direction)}
        </Badge>
        <Badge variant="outline">{tx.category}</Badge>
        {tx.subcategory && <Badge variant="outline">{tx.subcategory}</Badge>}
        {tx.account && <span>· {tx.account}</span>}
        <Badge variant="outline">{sourceLabel(tx.source)}</Badge>
        <Badge variant={tx.expenseKind === "variable" ? "outline" : "secondary"}>
          {expenseKindLabel(tx.expenseKind)}
        </Badge>
        {!compact && (
          <span>
            {paymentSummary(tx.paymentMethodKind, tx.paymentMethodLabel, tx.paymentMethodLast4)}
          </span>
        )}
        {tx.confidence != null && <span>신뢰도 {Math.round(tx.confidence * 100)}%</span>}
        {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
        <span>{statusLabel(tx.reviewStatus)}</span>
        <span>생성 {tx.createdAt}</span>
      </div>
      {reasons.length > 0 && (
        <div className="bk-row-reasons typo-caption-sm">
          {reasons.map((code) => (
            <Badge key={code} variant="secondary">
              {code}
            </Badge>
          ))}
        </div>
      )}
      {!compact && tx.note && <p className="text-muted-foreground typo-caption-sm">{tx.note}</p>}
    </>
  );
}

function TaxonomyEditFields({
  prefix,
  categoryCode,
  subcategoryCode,
  onCategoryChange,
  onSubcategoryChange,
}: {
  prefix: string;
  categoryCode: string;
  subcategoryCode: string;
  onCategoryChange: (value: string) => void;
  onSubcategoryChange: (value: string) => void;
}) {
  const taxonomy = useBookkeepingTaxonomy();
  const topLevel =
    taxonomy.data
      ?.filter((node) => node.parentCode === null)
      .map((node) => ({ value: node.code, label: node.label })) ?? [];
  const subcategories =
    taxonomy.data
      ?.filter((node) => node.parentCode === categoryCode)
      .map((node) => ({ value: node.code, label: node.label })) ?? [];
  const topItems = ensureSelectOption(
    topLevel.length > 0 ? topLevel : CATEGORY_OPTIONS.map((code) => ({ value: code, label: code })),
    categoryCode,
  );
  const subItems = ensureSelectOption(subcategories, subcategoryCode);

  return (
    <div className="bk-form-grid">
      <Field label="카테고리" htmlFor={`${prefix}-category`}>
        <Select value={categoryCode} onValueChange={onCategoryChange}>
          <SelectTrigger id={`${prefix}-category`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {topItems.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="소분류" htmlFor={`${prefix}-subcategory`}>
        <Select
          value={subcategoryCode || "__none__"}
          onValueChange={(value) => onSubcategoryChange(value === "__none__" ? "" : value)}
        >
          <SelectTrigger id={`${prefix}-subcategory`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">없음</SelectItem>
            {subItems
              .filter((option) => option.value)
              .map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

function ensureSelectOption<T extends { value: string; label: string }>(items: T[], value: string) {
  if (!value || items.some((item) => item.value === value)) {
    return items;
  }
  return [...items, { value, label: value }];
}

function RecurringOccurrenceRow({
  occurrence,
  disabled,
  onConfirm,
  onSkip,
}: {
  occurrence: BookkeepingRecurringOccurrence;
  disabled: boolean;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  return (
    <article className="bk-row bk-transaction" data-status={occurrence.status}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{occurrence.recurringName}</strong>
          {occurrence.merchant && (
            <span className="text-muted-foreground typo-caption-sm">{occurrence.merchant}</span>
          )}
        </div>
        <div className="bk-row-meta typo-caption-sm">
          <span>{occurrence.dueDate}</span>
          <Badge variant="outline">{occurrence.category}</Badge>
          <Badge variant="secondary">{expenseKindLabel(occurrence.expenseKind)}</Badge>
          <span>
            {paymentSummary(
              occurrence.paymentMethodKind,
              occurrence.paymentMethodLabel,
              occurrence.paymentMethodLast4,
            )}
          </span>
          <span>{occurrenceStatusLabel(occurrence.status)}</span>
        </div>
        {occurrence.note && (
          <p className="text-muted-foreground typo-caption-sm">{occurrence.note}</p>
        )}
      </div>
      <div className="bk-row-amount typo-title-sm">{currency.format(occurrence.amountMinor)}</div>
      <div className="bk-row-actions">
        {occurrence.status === "planned" && (
          <>
            <Button size="sm" variant="outline" disabled={disabled} onClick={onConfirm}>
              <Check className="size-3.5" />
              확정
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={onSkip}>
              <Ban className="size-3.5" />
              건너뜀
            </Button>
          </>
        )}
        {occurrence.status === "posted" && <Check className="size-4 text-[color:var(--success)]" />}
        {occurrence.status === "skipped" && (
          <AlertTriangle className="text-muted-foreground size-4" />
        )}
      </div>
    </article>
  );
}

function paymentSummary(
  kind: BookkeepingPaymentMethodKind,
  label: string | null,
  last4: string | null,
) {
  const base = paymentMethodLabel(kind);
  const detail = [label, last4 ? `끝 ${last4}` : null].filter(Boolean).join(" · ");
  return detail ? `${base} · ${detail}` : base;
}
