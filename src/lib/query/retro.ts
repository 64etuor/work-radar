import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { commands, type WorkSignal } from "@/bindings";

import { unwrap, useInvalidate } from "./client";
import { patchSignalInLists, SIGNAL_LIST_PREFIXES, snapshotQueries } from "./optimistic";

/**
 * 회고(retro) 완료 todo 타임라인 (Phase 17). [start,end] 로컬 날짜 inclusive.
 * 전부 로컬 read — today_done_at 범위. 외부 변경 없음(INVARIANT #2).
 * 주 이동 시 이전 범위 데이터를 유지(placeholderData) — 빈 리스트 플래시 방지.
 */
export function useCompleted(start: string, end: string) {
  return useQuery({
    queryKey: ["completed", start, end],
    queryFn: () => unwrap(commands.listCompleted(start, end)),
    placeholderData: keepPreviousData,
  });
}

/**
 * Today 우측 "완료 이력" 패널용 무한 쿼리. today 기준으로 7일씩 과거로 페이징.
 * pageParam=0 → [today-6, today], pageParam=1 → [today-13, today-7], …
 * `listCompleted`는 today_done_at DESC 정렬 → 페이지 내부는 최신부터.
 * 26주(약 6개월) 캡 — 그 이상은 사용자가 명시적으로 회고 뷰로 가는 게 자연스럽다.
 */
const HISTORY_WINDOW_DAYS = 7;
const HISTORY_MAX_PAGES = 26;

function subtractDays(yyyymmdd: string, days: number): string {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(y, m - 1, d - days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

type HistoryPage = { rows: WorkSignal[]; pageParam: number; start: string; end: string };

export function useCompletedHistory(today: string) {
  return useInfiniteQuery<HistoryPage>({
    queryKey: ["completedHistory", today],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const p = pageParam as number;
      const end = subtractDays(today, p * HISTORY_WINDOW_DAYS);
      const start = subtractDays(today, (p + 1) * HISTORY_WINDOW_DAYS - 1);
      const rows = await unwrap(commands.listCompleted(start, end));
      return { rows, pageParam: p, start, end };
    },
    getNextPageParam: (last) =>
      last.pageParam + 1 < HISTORY_MAX_PAGES ? last.pageParam + 1 : undefined,
  });
}

/** 회고 쿼리 무효화(태깅 후 갱신). completed/archive 둘 다. */
function useInvalidateRetro() {
  const inv = useInvalidate();
  return () => {
    void inv.completedHistory();
    void inv.archivedSnoozed();
  };
}

/** 고임팩트 ⭐ 태그 토글 (사람 결정 — INVARIANT #1) — 연속 태깅이 끊기지 않게 optimistic. */
export function useSetSignalImpact() {
  const qc = useQueryClient();
  const inv = useInvalidateRetro();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      unwrap(commands.setSignalImpact(id, value)),
    onMutate: async ({ id, value }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, { impactHigh: value });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: inv,
  });
}

/** 후회 ⚠️ (하지말걸) 태그 토글 (사람 결정 — INVARIANT #1) — optimistic. */
export function useSetSignalRegret() {
  const qc = useQueryClient();
  const inv = useInvalidateRetro();
  return useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      unwrap(commands.setSignalRegret(id, value)),
    onMutate: async ({ id, value }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, { regret: value });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: inv,
  });
}

/** 보관함: archived + snoozed 열람 (Phase 17). 새 status 없음(snooze/archive 재사용). */
export function useArchivedSnoozed() {
  return useQuery({
    queryKey: ["archivedSnoozed"],
    queryFn: () => unwrap(commands.listArchivedSnoozed()),
  });
}

/** 신호 복원 (archived→미분류, snoozed→원 사분면). 로컬 액션(외부 변경 0). */
export function useRestoreSignal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.restoreSignal(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["archivedSnoozed"] });
      void qc.invalidateQueries({ queryKey: ["signalSearch"] });
      void qc.invalidateQueries({ queryKey: ["todayOverview"] });
      void qc.invalidateQueries({ queryKey: ["signals"] });
    },
  });
}
