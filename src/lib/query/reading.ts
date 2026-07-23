import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import {
  type AddBookInput,
  type AddBookQuoteInput,
  commands,
  type LogReadingSessionInput,
  type ReadingStatus,
  type UpdateBookInput,
} from "@/bindings";

import { pushMutationError, unwrap } from "./client";

export const readingKeys = {
  all: ["reading"] as const,
  books: (status: ReadingStatus | null, query: string) =>
    ["reading", "books", status ?? "all", query] as const,
  detail: (id: string) => ["reading", "detail", id] as const,
  stats: (year: number, today: string) => ["reading", "stats", year, today] as const,
  catalog: (query: string, limit: number) => ["reading", "catalog", query, limit] as const,
};

function invalidateReading(qc: QueryClient) {
  // 도메인 전체 무효화 — reading 쿼리는 전부 로컬 SQLite라 재조회가 싸고, 서가↔통계↔상세처럼
  // 파생이 얽힌 표면에서 부분 무효화가 놓치는 조합이 더 비싸다(diet 선례와 동일).
  return qc.invalidateQueries({ queryKey: readingKeys.all });
}

/** reading mutation 들이 공유하는 invalidate 헬퍼 — 인라인 invalidateQueries 금지. 모듈 내부 전용. */
function useInvalidateReading() {
  const qc = useQueryClient();
  return () => invalidateReading(qc);
}

// ── 조회 ──────────────────────────────────────────────────────────────

export function useBooks(status: ReadingStatus | null, query: string) {
  return useQuery({
    queryKey: readingKeys.books(status, query),
    queryFn: () => unwrap(commands.listBooks(status, query.length > 0 ? query : null)),
    placeholderData: keepPreviousData,
  });
}

export function useBookDetail(id: string | null) {
  return useQuery({
    queryKey: readingKeys.detail(id ?? ""),
    queryFn: () => unwrap(commands.getBookDetail(id ?? "")),
    enabled: id != null && id.length > 0,
  });
}

export function useReadingStats(year: number, today: string) {
  return useQuery({
    queryKey: readingKeys.stats(year, today),
    queryFn: () => unwrap(commands.readingStats(year, today)),
    enabled: today.length > 0,
    placeholderData: keepPreviousData,
  });
}

/** 카탈로그 검색(외부 GET — Rust 고정 provider). 2자 미만이면 조회하지 않는다. */
export function useCatalogSearch(query: string, limit = 10) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: readingKeys.catalog(trimmed, limit),
    queryFn: () => unwrap(commands.searchBookCatalog(trimmed, limit)),
    enabled: trimmed.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60 * 1000,
    retry: false, // Rust 쪽 bounded retry가 이미 처리 — 프런트 재시도 중첩 금지.
  });
}

// ── 변경 ──────────────────────────────────────────────────────────────

export function useAddBook() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (input: AddBookInput) => unwrap(commands.addBook(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useUpdateBook() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (input: UpdateBookInput) => unwrap(commands.updateBook(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useSetBookStatus() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: ({ id, status, date }: { id: string; status: ReadingStatus; date: string }) =>
      unwrap(commands.setBookStatus(id, status, date)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useDeleteBook() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteBook(id)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useLogReadingSession() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (input: LogReadingSessionInput) => unwrap(commands.logReadingSession(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useDeleteReadingSession() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteReadingSession(id)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useAddBookQuote() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (input: AddBookQuoteInput) => unwrap(commands.addBookQuote(input)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useDeleteBookQuote() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteBookQuote(id)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}

export function useSetReadingGoal() {
  const invalidate = useInvalidateReading();
  return useMutation({
    mutationFn: ({ year, targetBooks }: { year: number; targetBooks: number }) =>
      unwrap(commands.setReadingGoal(year, targetBooks)),
    onSuccess: () => void invalidate(),
    onError: (e) => pushMutationError("reading", e, "독서"),
  });
}
