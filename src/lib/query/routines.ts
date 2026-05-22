import {
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { unwrap, useInvalidate } from "./client";
import {
  commands,
  type CreateRoutineInput,
  type UpdateRoutineInput,
  type Weekday,
} from "@/bindings";

/** 오늘 해당하는 루틴 + 날짜별 완료 상태. */
export function useTodayRoutines(date: string, weekday: Weekday) {
  return useQuery({
    queryKey: ["routines", date],
    queryFn: () => unwrap(commands.listTodayRoutines(date, weekday)),
  });
}

/** 루틴 트래킹(이행률/streak/히스토리) — endDate 기준 지난 days일. */
export function useRoutineTracking(endDate: string, days: number) {
  return useQuery({
    queryKey: ["routine-tracking", endDate, days],
    queryFn: () => unwrap(commands.routineTracking(endDate, days)),
  });
}

// ── Mutations (관련 쿼리 invalidate) ───────────────────────────────────────────

/** 루틴 추가. */
export function useCreateRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateRoutineInput) => unwrap(commands.createRoutine(input)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 수정. */
export function useUpdateRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateRoutineInput) => unwrap(commands.updateRoutine(input)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 삭제. */
export function useDeleteRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => unwrap(commands.deleteRoutine(id)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 재정렬 (드래그, rank 영속). */
export function useReorderRoutines() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (orderedIds: string[]) => unwrap(commands.reorderRoutines(orderedIds)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 완료 토글 (날짜별, 다음날 리셋). */
export function useToggleRoutineCheck() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({
      routineId,
      date,
      done,
    }: {
      routineId: string;
      date: string;
      done: boolean;
    }) => unwrap(commands.toggleRoutineCheck(routineId, date, done)),
    onSuccess: () => inv.routines(),
  });
}

// ── Phase 2: Projects / Repos / 토큰 ────────────────────────────────────────────
