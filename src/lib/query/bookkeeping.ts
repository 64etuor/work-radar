import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type BookkeepingReviewStatus,
  commands,
  type CreateBookkeepingTransactionInput,
  type RecordBookkeepingSyncFailureInput,
} from "@/bindings";

import { unwrap } from "./client";

function useInvalidateBookkeeping() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["bookkeeping"] });
  };
}

export function useBookkeepingTransactions(status: BookkeepingReviewStatus | null = null) {
  return useQuery({
    queryKey: ["bookkeeping", "transactions", status],
    queryFn: () => unwrap(commands.listBookkeepingTransactions(status)),
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

export function useUpdateBookkeepingReviewStatus() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: BookkeepingReviewStatus }) =>
      unwrap(commands.updateBookkeepingReviewStatus(id, status)),
    onSuccess: invalidate,
  });
}

export function useBookkeepingMonthlySummary(month: string) {
  return useQuery({
    queryKey: ["bookkeeping", "summary", month],
    queryFn: () => unwrap(commands.bookkeepingMonthlySummary(month)),
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

export function useRecordBookkeepingSyncFailure() {
  const invalidate = useInvalidateBookkeeping();
  return useMutation({
    mutationFn: (input: RecordBookkeepingSyncFailureInput) =>
      unwrap(commands.recordBookkeepingSyncFailure(input)),
    onSuccess: invalidate,
  });
}
