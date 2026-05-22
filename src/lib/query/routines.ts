import {
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { unwrap, useInvalidate } from "./client";
import {
  commands,
  type CreateRoutineInput,
  type Weekday,
} from "@/bindings";

/** 오늘 해당하는 루틴 + 날짜별 완료 상태. */
export function useTodayRoutines(date: string, weekday: Weekday) {
  return useQuery({
    queryKey: ["routines", date],
    queryFn: () => unwrap(commands.listTodayRoutines(date, weekday)),
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
