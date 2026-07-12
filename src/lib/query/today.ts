import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { commands, type TodayOverview, type WeeklyReview } from "@/bindings";

import { unwrap, useInvalidate } from "./client";
import {
  moveSignalFromToday,
  moveSignalToToday,
  patchSignalInLists,
  reorderListCache,
  SIGNAL_LIST_PREFIXES,
  snapshotQueries,
} from "./optimistic";

/** 오늘의 Today 레일 항목. */
export function useToday(today: string) {
  return useQuery({
    queryKey: ["today", today],
    queryFn: () => unwrap(commands.listToday(today)),
  });
}

/**
 * Today 운영 뷰 집계 (Phase 11a): Work Debt 4지표 + Q1/PR attention 섹션.
 * 호출 시 Rust가 오늘 부채 스냅샷을 멱등 기록한다(Weekly review 추세용). 캘린더는 별도 합성.
 */
export function useTodayOverview(date: string) {
  return useQuery<TodayOverview>({
    queryKey: ["todayOverview", date],
    queryFn: () => unwrap(commands.todayOverview(date)),
  });
}

/**
 * Weekly review (Phase 11c): 지난 7일 처리량·PR·루틴·부채추세 집계. endDate=로컬 오늘.
 * 전부 read(기존 타임스탬프 + debt_snapshots). 외부 변경 없음.
 * 주 이동 시 이전 주 수치를 유지(placeholderData) — KPI 타일 0 플래시 방지.
 */
export function useWeeklyReview(endDate: string) {
  return useQuery<WeeklyReview>({
    queryKey: ["weeklyReview", endDate],
    queryFn: () => unwrap(commands.weeklyReview(endDate)),
    placeholderData: keepPreviousData,
  });
}

/** Today 승격 (로컬, Acceptance 불요). 매트릭스에서 빠지고 Today에만 표시 — optimistic 이동. */
export function usePromoteToday() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) =>
      unwrap(commands.promoteToday(id, date)),
    onMutate: async ({ id, date }) => {
      const rollback = await snapshotQueries(qc, [["signals"], ["today"]]);
      moveSignalToToday(qc, id, date);
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.boardAndToday(),
  });
}

/** Today 승격 취소 → 원 사분면 복귀 — optimistic 이동. */
export function useUnpromoteToday() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.unpromoteToday(id)),
    onMutate: async (id) => {
      const rollback = await snapshotQueries(qc, [["signals"], ["today"]]);
      moveSignalFromToday(qc, id);
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.boardAndToday(),
  });
}

/** Today 항목 완료 토글 (날짜별, 미완료는 rollover). 최빈 상호작용이라 optimistic —
 *  체크가 즉시 뒤집히고(루틴 체크와 동일 감각), 실패 시 롤백, settle 시 무효화로 수렴. */
export function useToggleTodayDone() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, date, done }: { id: string; date: string; done: boolean }) =>
      unwrap(commands.toggleTodayDone(id, date, done)),
    onMutate: async ({ id, date, done }) => {
      const rollback = await snapshotQueries(qc, SIGNAL_LIST_PREFIXES);
      patchSignalInLists(qc, id, { todayDoneAt: done ? date : null });
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => {
      void inv.today();
      void inv.completedHistory();
    },
  });
}

/** Today 레일 재정렬 — optimistic 재배열(드롭 직후 스냅백 방지), rank 영속은 invalidate 수렴. */
export function useReorderToday() {
  const qc = useQueryClient();
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (orderedIds: string[]) => unwrap(commands.reorderToday(orderedIds)),
    onMutate: async (orderedIds) => {
      const rollback = await snapshotQueries(qc, [["today"]]);
      reorderListCache(qc, ["today"], orderedIds);
      return { rollback };
    },
    onError: (_err, _vars, ctx) => ctx?.rollback(),
    onSettled: () => inv.today(),
  });
}

/** [start,end] 범위 날짜별 배치 — 타임라인 시그널 블록의 SSOT. */
export function useSignalPlacements(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ["signalPlacements", startDate, endDate],
    queryFn: () => unwrap(commands.listSignalPlacements(startDate, endDate)),
  });
}

/** 카드별 누적 배치 시간(분)/일수 — Today 카드 배지(전체 기간). */
export function useSignalTimeTotals() {
  return useQuery({
    queryKey: ["signalTimeTotals"],
    queryFn: () => unwrap(commands.signalTimeTotals()),
  });
}
