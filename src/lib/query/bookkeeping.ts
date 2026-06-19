import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BookkeepingRecurringOccurrenceStatus,
  type BookkeepingReviewStatus,
  commands,
  type CreateBookkeepingRecurringExpenseInput,
  type CreateBookkeepingTransactionInput,
  type RecordBookkeepingSyncFailureInput,
  type SyncBookkeepingGmailReceiptsInput,
  type UpdateBookkeepingTransactionInput,
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
) {
  return useQuery({
    queryKey: ["bookkeeping", "transactions", status, projectId],
    queryFn: () => unwrap(commands.listBookkeepingTransactions(status, projectId)),
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

export function useBookkeepingMonthlySummary(month: string, projectId: string | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "summary", month, projectId],
    queryFn: () => unwrap(commands.bookkeepingMonthlySummary(month, projectId)),
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
