import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BookkeepingCashflowInput,
  type BookkeepingCategoryTrendInput,
  type BookkeepingExportFormat,
  type BookkeepingReconcileAccountInput,
  type BookkeepingRecurringOccurrenceStatus,
  type BookkeepingReviewStatus,
  type BookkeepingTransaction,
  commands,
  type CreateBookkeepingRecurringExpenseInput,
  type CreateBookkeepingTransactionInput,
  type ExportBookkeepingInput,
  type FindBookkeepingDuplicateCandidatesInput,
  type OverrideBookkeepingCategoryInput,
  type RecordBookkeepingSyncFailureInput,
  type SetBookkeepingBudgetInput,
  type SetBookkeepingLineItemsInput,
  type SetBookkeepingMmbakOptionsInput,
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

/** 캐시된 거래 목록에서 갱신된 행만 교체 — 순수 함수(리스트 없음/미포함이면 무변경). */
export function replaceTransactionRow(
  rows: BookkeepingTransaction[] | undefined,
  updated: BookkeepingTransaction,
): BookkeepingTransaction[] | undefined {
  return rows?.map((row) => (row.id === updated.id ? updated : row));
}

/**
 * 단일 거래를 갱신한 뮤테이션의 onSuccess — 서버가 돌려준 fresh 행을 모든 거래-목록 캐시에
 * **동기** 반영한 뒤 invalidate(요약/예산 등 파생 뷰 refetch). invalidate는 fire-and-forget이라
 * refetch가 도착하기 전 창이 있는데, 인라인 셀 편집은 "현재 tx + patch"로 전체 draft를 합성하므로
 * 그 창에서 두 번째 셀을 고치면 stale 스냅샷이 직전 편집(override 포함)을 되돌릴 수 있다 —
 * setQueriesData가 mutateAsync 해소 전에 캐시를 fresh로 만들어 그 lost-update 창을 닫는다.
 */
function useApplyUpdatedTransaction() {
  const qc = useQueryClient();
  const invalidate = useInvalidateBookkeeping();
  return (updated: BookkeepingTransaction) => {
    qc.setQueriesData<BookkeepingTransaction[]>(
      { queryKey: ["bookkeeping", "transactions"] },
      (rows) => replaceTransactionRow(rows, updated),
    );
    invalidate();
  };
}

export function useBookkeepingTransactions(
  status: BookkeepingReviewStatus | null = null,
  projectId: string | null = null,
  orderBy: string | null = null,
  fromDate: string | null = null,
  toDate: string | null = null,
) {
  return useQuery({
    queryKey: ["bookkeeping", "transactions", status, projectId, orderBy, fromDate, toDate],
    queryFn: () =>
      unwrap(commands.listBookkeepingTransactions(status, projectId, orderBy, fromDate, toDate)),
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
  const applyUpdated = useApplyUpdatedTransaction();
  return useMutation({
    mutationFn: (input: UpdateBookkeepingTransactionInput) =>
      unwrap(commands.updateBookkeepingTransaction(input)),
    onSuccess: applyUpdated,
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
  const applyUpdated = useApplyUpdatedTransaction();
  return useMutation({
    mutationFn: (input: OverrideBookkeepingCategoryInput) =>
      unwrap(commands.overrideBookkeepingCategory(input)),
    onSuccess: applyUpdated,
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

export function useBookkeepingMmbakOptions() {
  return useQuery({
    queryKey: ["bookkeeping", "mmbakOptions"],
    queryFn: () => unwrap(commands.getBookkeepingMmbakOptions()),
  });
}

export function useSetBookkeepingMmbakOptions() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: SetBookkeepingMmbakOptionsInput) =>
      unwrap(commands.setBookkeepingMmbakOptions(input)),
    onSuccess: invalidate,
  });
}

export function useImportBookkeepingMmbakLatest() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (projectId: string | null) =>
      unwrap(commands.importBookkeepingMmbakLatest(projectId)),
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
