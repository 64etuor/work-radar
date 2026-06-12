import { useMutation, useQuery } from "@tanstack/react-query";

import { commands, type TodayOverview, type WeeklyReview } from "@/bindings";

import { unwrap, useInvalidate } from "./client";

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
 */
export function useWeeklyReview(endDate: string) {
  return useQuery<WeeklyReview>({
    queryKey: ["weeklyReview", endDate],
    queryFn: () => unwrap(commands.weeklyReview(endDate)),
  });
}

/** Today 승격 (로컬, Acceptance 불요). 매트릭스에서 빠지고 Today에만 표시. */
export function usePromoteToday() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, date }: { id: string; date: string }) =>
      unwrap(commands.promoteToday(id, date)),
    onSuccess: () => {
      inv.signals();
      inv.today();
    },
  });
}

/** Today 승격 취소 → 원 사분면 복귀. */
export function useUnpromoteToday() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.unpromoteToday(id)),
    onSuccess: () => {
      inv.signals();
      inv.today();
    },
  });
}

/** Today 항목 완료 토글 (날짜별, 미완료는 rollover). */
export function useToggleTodayDone() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, date, done }: { id: string; date: string; done: boolean }) =>
      unwrap(commands.toggleTodayDone(id, date, done)),
    onSuccess: () => {
      inv.today();
      inv.completedHistory();
    },
  });
}

/** Today 레일 재정렬. */
export function useReorderToday() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (orderedIds: string[]) => unwrap(commands.reorderToday(orderedIds)),
    onSuccess: () => inv.today(),
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
