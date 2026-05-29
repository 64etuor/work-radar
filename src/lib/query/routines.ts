import { useMutation, useQuery } from "@tanstack/react-query";

import {
  commands,
  type CreateRoutineInput,
  type Kind,
  type UpdateRoutineInput,
  type Weekday,
} from "@/bindings";

import { unwrap, useInvalidate } from "./client";

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

/** 루틴 수정. 동기화 루틴은 Google PATCH 전파가 실패해도 로컬 변경은 커밋되므로(서버
 *  patch_failed 에러여도), onSettled로 무효화해 화면이 항상 최신 로컬 상태를 반영한다. */
export function useUpdateRoutine() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateRoutineInput) => unwrap(commands.updateRoutine(input)),
    onSettled: () => inv.routines(),
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

/** 루틴 kind 즉시 갱신 (personal/work 토글, signals 패턴 미러). */
export function useSetRoutineKind() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: Kind | null }) =>
      unwrap(commands.setRoutineKind(id, kind)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 Life Wheel tag key 갱신 (커스텀 키 허용, signals 패턴 미러). */
export function useSetRoutineAreaTagKey() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, tagKey }: { id: string; tagKey: string | null }) =>
      unwrap(commands.setRoutineAreaTagKey(id, tagKey)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 Google Calendar 동기화 ON (kind 일치 프로젝트 + 그 캘린더). */
export function useEnableRoutineGoogleSync() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({
      routineId,
      projectId,
      calendarId,
    }: {
      routineId: string;
      projectId: string;
      calendarId: string;
    }) => unwrap(commands.enableRoutineGoogleSync(routineId, projectId, calendarId)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 Google Calendar 동기화 OFF (master event 삭제 + 로컬 mirror 정리). */
export function useDisableRoutineGoogleSync() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: (routineId: string) => unwrap(commands.disableRoutineGoogleSync(routineId)),
    onSuccess: () => inv.routines(),
  });
}

/** 루틴 완료 토글 (날짜별, 다음날 리셋). */
export function useToggleRoutineCheck() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ routineId, date, done }: { routineId: string; date: string; done: boolean }) =>
      unwrap(commands.toggleRoutineCheck(routineId, date, done)),
    onSuccess: () => inv.routines(),
  });
}

// ── Phase 2: Projects / Repos / 토큰 ────────────────────────────────────────────
