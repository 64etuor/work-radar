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
  ShieldAlert,
  Tags,
  WalletCards,
} from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
  useReducer,
  useState,
} from "react";

import type {
  BookkeepingAuditEntry,
  BookkeepingCategorySummary,
  BookkeepingExpenseKind,
  BookkeepingGmailLabel,
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
  useBookkeepingMonthlySummary,
  useBookkeepingRecurringExpenses,
  useBookkeepingRecurringOccurrences,
  useBookkeepingSyncJobs,
  useBookkeepingTaxonomy,
  useBookkeepingTransactions,
  useCreateBookkeepingRecurringExpense,
  useCreateBookkeepingTransaction,
  useEnsureBookkeepingRecurringOccurrences,
  usePostBookkeepingRecurringOccurrence,
  useProjects,
  useSetBookkeepingRecurringOccurrenceStatus,
  useSyncBookkeepingGmailReceipts,
  useUpdateBookkeepingReviewStatus,
} from "@/lib/query";
import { useToastStore } from "@/lib/toast";

import { Field, SectionLabel } from "../settings/SettingsKit";
import { BOOKKEEPING_GMAIL_PERMISSION_COPY } from "./bookkeepingCopy";
import {
  BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  BOOKKEEPING_INPUT_PANEL_ORDER,
  type BookkeepingInputPanel,
} from "./bookkeepingPanels";

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
  const transactions = useBookkeepingTransactions(null, activeProjectId);
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
  const pushSuccess = useToastStore((s) => s.pushSuccess);
  const pushError = useToastStore((s) => s.pushError);

  const reviewQueue = (transactions.data ?? []).filter((tx) => tx.reviewStatus === "needs_review");
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
        onSuccess: () => pushSuccess(status === "approved" ? "승인했습니다" : "무시했습니다"),
        onError: (error) => pushMutationError("bookkeeping.review", error),
      },
    );
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
              rows={reviewQueue}
              disabled={review.isPending}
              onSetStatus={setReviewStatus}
            />

            <RecurringMonthCard
              rows={recurringOccurrences.data ?? []}
              ensurePending={ensureRecurring.isPending}
              actionPending={postRecurring.isPending || setRecurringStatus.isPending}
              onEnsure={() => ensureRecurring.mutate({ month, projectId: activeProjectId })}
              onConfirm={confirmOccurrence}
              onSkip={skipOccurrence}
            />

            <RecentTransactionsCard
              rows={transactions.data ?? []}
              disabled={review.isPending}
              onSetStatus={setReviewStatus}
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
  onSetStatus,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onSetStatus: (tx: BookkeepingTransaction, status: BookkeepingReviewStatus) => void;
}) {
  return (
    <Card className="bk-card bk-review-card">
      <CardHeader className="bk-card-header-row">
        <div>
          <CardTitle className="bk-card-title">
            <ClipboardList className="size-4" />
            리뷰큐
          </CardTitle>
          <CardDescription>Gmail/OCR/수동 거래를 확정하거나 제외합니다.</CardDescription>
        </div>
        <Badge variant="secondary">{rows.length}</Badge>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>대기 중인 거래 없음</EmptyState>}
          {rows.map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              disabled={disabled}
              onApprove={() => onSetStatus(tx, "approved")}
              onIgnore={() => onSetStatus(tx, "ignored")}
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

function RecentTransactionsCard({
  rows,
  disabled,
  onSetStatus,
}: {
  rows: BookkeepingTransaction[];
  disabled: boolean;
  onSetStatus: (tx: BookkeepingTransaction, status: BookkeepingReviewStatus) => void;
}) {
  return (
    <Card className="bk-card">
      <CardHeader>
        <CardTitle className="bk-card-title">
          <ReceiptText className="size-4" />
          최근 거래
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="bk-transaction-list">
          {rows.length === 0 && <EmptyState>거래 없음</EmptyState>}
          {rows.slice(0, 8).map((tx) => (
            <TransactionRow
              key={tx.id}
              tx={tx}
              disabled={disabled}
              onApprove={() => onSetStatus(tx, "approved")}
              onIgnore={() => onSetStatus(tx, "ignored")}
            />
          ))}
        </div>
      </CardContent>
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
    <article className="bk-row bk-transaction" data-status={tx.reviewStatus}>
      <div className="bk-row-main">
        <div className="bk-row-title">
          <strong className="typo-body-strong">{tx.merchant}</strong>
          {tx.description && (
            <span className="text-muted-foreground typo-caption-sm">{tx.description}</span>
          )}
        </div>
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
          <span>
            {paymentSummary(tx.paymentMethodKind, tx.paymentMethodLabel, tx.paymentMethodLast4)}
          </span>
          {tx.confidence != null && <span>신뢰도 {Math.round(tx.confidence * 100)}%</span>}
          {tx.duplicateOfTransactionId && <Badge variant="destructive">중복</Badge>}
          <span>{statusLabel(tx.reviewStatus)}</span>
        </div>
        {reviewReasonCodes(tx.reviewReasonsJson).length > 0 && (
          <div className="bk-row-reasons typo-caption-sm">
            {reviewReasonCodes(tx.reviewReasonsJson).map((code) => (
              <Badge key={code} variant="secondary">
                {code}
              </Badge>
            ))}
          </div>
        )}
        {tx.source !== "manual" && tx.sourceRef && (
          <p className="text-muted-foreground typo-caption-sm">출처 ref: {tx.sourceRef}</p>
        )}
        {tx.note && <p className="text-muted-foreground typo-caption-sm">{tx.note}</p>}
      </div>
      <div className="bk-row-amount typo-title-sm">{currency.format(tx.amountMinor)}</div>
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
    </article>
  );
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
