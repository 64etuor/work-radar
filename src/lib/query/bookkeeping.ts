import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BookkeepingCashflowInput,
  type BookkeepingCategoryTrendInput,
  type BookkeepingExportFormat,
  type BookkeepingReconcileAccountInput,
  type BookkeepingRecurringOccurrenceStatus,
  type BookkeepingReviewStatus,
  commands,
  type CreateBookkeepingRecurringExpenseInput,
  type CreateBookkeepingTransactionInput,
  type ExportBookkeepingInput,
  type FindBookkeepingDuplicateCandidatesInput,
  type OverrideBookkeepingCategoryInput,
  type RecordBookkeepingSyncFailureInput,
  type SetBookkeepingBudgetInput,
  type SetBookkeepingLineItemsInput,
  type SyncBookkeepingGmailReceiptsInput,
  type UpdateBookkeepingTransactionInput,
  type WriteBookkeepingExportInput,
} from "@/bindings";

import { unwrap } from "./client";

function useInvalidateBookkeeping() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["bookkeeping"] });
  };
}

export function useBookkeepingTransactions(
  status: BookkeepingReviewStatus | null = null,
  projectId: string | null = null,
  orderBy: string | null = null,
) {
  return useQuery({
    queryKey: ["bookkeeping", "transactions", status, projectId, orderBy],
    queryFn: () => unwrap(commands.listBookkeepingTransactions(status, projectId, orderBy)),
  });
}

export function useCreateBookkeepingTransaction() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: CreateBookkeepingTransactionInput) =>
      unwrap(commands.createBookkeepingTransaction(input)),
    onSuccess: invalidate,
  });
}

export function useUpdateBookkeepingTransaction() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: UpdateBookkeepingTransactionInput) =>
      unwrap(commands.updateBookkeepingTransaction(input)),
    onSuccess: invalidate,
  });
}

export function useDeleteBookkeepingTransaction() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteBookkeepingTransaction(id)),
    onSuccess: invalidate,
  });
}

export function useRestoreBookkeepingTransaction() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.restoreBookkeepingTransaction(id)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingTrash(projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "trash", projectId],
    queryFn: () => unwrap(commands.listBookkeepingTrash(projectId)),
  });
}

export function useUpdateBookkeepingReviewStatus() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: BookkeepingReviewStatus }) =>
      unwrap(commands.updateBookkeepingReviewStatus(id, status)),
    onSuccess: invalidate,
  });
}

export function useBulkUpdateBookkeepingReviewStatus() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({ ids, status }: { ids: string[]; status: BookkeepingReviewStatus }) =>
      unwrap(commands.bulkUpdateBookkeepingReviewStatus(ids, status)),
    onSuccess: invalidate,
  });
}

export function useBulkSetBookkeepingCategory() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({
      ids,
      categoryCode,
      subcategoryCode,
      reason,
    }: {
      ids: string[];
      categoryCode: string | null;
      subcategoryCode: string | null;
      reason: string | null;
    }) => unwrap(commands.bulkSetBookkeepingCategory(ids, categoryCode, subcategoryCode, reason)),
    onSuccess: invalidate,
  });
}

/** 확정 행 인라인 분류 변경 — audit 보존을 위해 override 커맨드 경로를 사용한다. */
export function useOverrideBookkeepingCategory() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: OverrideBookkeepingCategoryInput) =>
      unwrap(commands.overrideBookkeepingCategory(input)),
    onSuccess: invalidate,
  });
}

export function useBulkDeleteBookkeepingTransactions() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (ids: string[]) => unwrap(commands.bulkDeleteBookkeepingTransactions(ids)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingMonthlySummary(month: string, projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "summary", month, projectId],
    queryFn: () => unwrap(commands.bookkeepingMonthlySummary(month, projectId)),
  });
}

export function useBookkeepingBudgets(month: string, projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "budgets", month, projectId],
    queryFn: () => unwrap(commands.listBookkeepingBudgets(month, projectId)),
  });
}

export function useBookkeepingBudgetStatus(month: string, projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "budgetStatus", month, projectId],
    queryFn: () => unwrap(commands.bookkeepingBudgetStatus(month, projectId)),
  });
}

export function useBookkeepingCashflow(input: BookkeepingCashflowInput) {
  return useQuery({
    queryKey: ["bookkeeping", "cashflow", input],
    queryFn: () => unwrap(commands.bookkeepingCashflow(input)),
  });
}

export function useBookkeepingCategoryTrend(input: BookkeepingCategoryTrendInput) {
  return useQuery({
    queryKey: ["bookkeeping", "categoryTrend", input],
    queryFn: () => unwrap(commands.bookkeepingCategoryTrend(input)),
  });
}

export function useBookkeepingReconcileAccount() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: BookkeepingReconcileAccountInput) =>
      unwrap(commands.bookkeepingReconcileAccount(input)),
    onSuccess: invalidate,
  });
}

export function useSetBookkeepingBudget() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: SetBookkeepingBudgetInput) => unwrap(commands.setBookkeepingBudget(input)),
    onSuccess: invalidate,
  });
}

export function useDeleteBookkeepingBudget() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteBookkeepingBudget(id)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingAudit(entityId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "audit", entityId],
    queryFn: () => unwrap(commands.listBookkeepingAudit(entityId)),
  });
}

export function useBookkeepingSyncJobs() {
  return useQuery({
    queryKey: ["bookkeeping", "syncJobs"],
    queryFn: () => unwrap(commands.listBookkeepingSyncJobs()),
  });
}

export function useBookkeepingTaxonomy() {
  return useQuery({
    queryKey: ["bookkeeping", "taxonomy"],
    queryFn: () => unwrap(commands.bookkeepingListTaxonomy()),
    staleTime: 5 * 60 * 1000,
  });
}

export function useBookkeepingRecurringExpenses(projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "recurringExpenses", projectId],
    queryFn: () => unwrap(commands.listBookkeepingRecurringExpenses(projectId)),
  });
}

export function useCreateBookkeepingRecurringExpense() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: CreateBookkeepingRecurringExpenseInput) =>
      unwrap(commands.createBookkeepingRecurringExpense(input)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingRecurringOccurrences(month: string, projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "recurringOccurrences", month, projectId],
    queryFn: () => unwrap(commands.listBookkeepingRecurringOccurrences(month, projectId)),
  });
}

export function useEnsureBookkeepingRecurringOccurrences() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({ month, projectId }: { month: string; projectId: string | null }) =>
      unwrap(commands.ensureBookkeepingRecurringOccurrences(month, projectId)),
    onSuccess: invalidate,
  });
}

export function usePostBookkeepingRecurringOccurrence() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.postBookkeepingRecurringOccurrence(id)),
    onSuccess: invalidate,
  });
}

export function useSetBookkeepingRecurringOccurrenceStatus() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: BookkeepingRecurringOccurrenceStatus }) =>
      unwrap(commands.setBookkeepingRecurringOccurrenceStatus(id, status)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingGmailLabels(projectId: string | null) {
  return useQuery({
    queryKey: ["bookkeeping", "gmailLabels", projectId],
    queryFn: () => unwrap(commands.listBookkeepingGmailLabels(projectId as string)),
    enabled: !!projectId,
  });
}

export function useSyncBookkeepingGmailReceipts() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: SyncBookkeepingGmailReceiptsInput) =>
      unwrap(commands.syncBookkeepingGmailReceipts(input)),
    onSuccess: invalidate,
  });
}

export function useRecordBookkeepingSyncFailure() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: RecordBookkeepingSyncFailureInput) =>
      unwrap(commands.recordBookkeepingSyncFailure(input)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingLineItems(transactionId: string) {
  return useQuery({
    queryKey: ["bookkeeping", "lineItems", transactionId],
    queryFn: () => unwrap(commands.listBookkeepingLineItems(transactionId)),
  });
}

export function useSetBookkeepingLineItems() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: SetBookkeepingLineItemsInput) =>
      unwrap(commands.setBookkeepingLineItems(input)),
    onSuccess: invalidate,
  });
}

export function useFindBookkeepingDuplicateCandidates(
  input: FindBookkeepingDuplicateCandidatesInput,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["bookkeeping", "duplicates", input],
    queryFn: () => unwrap(commands.findBookkeepingDuplicateCandidates(input)),
    enabled,
  });
}

export function useMarkBookkeepingDuplicate() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({
      id,
      duplicateOfTransactionId,
    }: {
      id: string;
      duplicateOfTransactionId: string;
    }) => unwrap(commands.markBookkeepingDuplicate(id, duplicateOfTransactionId)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingSyncCursors() {
  return useQuery({
    queryKey: ["bookkeeping", "syncCursors"],
    queryFn: () => unwrap(commands.listBookkeepingSyncCursors()),
  });
}

export function useExportBookkeepingCsv() {
  return useMutation({
    mutationFn: (input: ExportBookkeepingInput) => unwrap(commands.exportBookkeepingCsv(input)),
  });
}

export function useExportBookkeepingQif() {
  return useMutation({
    mutationFn: (input: ExportBookkeepingInput) => unwrap(commands.exportBookkeepingQif(input)),
  });
}

export function useExportBookkeepingOfx() {
  return useMutation({
    mutationFn: (input: ExportBookkeepingInput) => unwrap(commands.exportBookkeepingOfx(input)),
  });
}

export function useWriteBookkeepingExport() {
  return useMutation({
    mutationFn: (input: WriteBookkeepingExportInput) =>
      unwrap(commands.writeBookkeepingExport(input)),
  });
}

export type { BookkeepingExportFormat };
